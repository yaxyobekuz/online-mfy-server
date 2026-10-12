/**
 * MFY bo'yicha oila a'zolarini ro'yxatdan o'tkazish ISHCHISI.
 *
 * Jarayon qat'iy KETMA-KET (single thread) ketadi:
 *
 *   1. Tayyorlash — MFY ning ko'chalari va barcha xonadonlari tashqi
 *      API'dan yuklanib, navbat (RegistrationHome) sifatida yoziladi.
 *   2. Har bir xonadon uchun:
 *        a. survey_uuid ta'minlanadi (yo'q bo'lsa forma yuklanadi);
 *        b. platformadagi hozirgi oila a'zolari yuklanadi — kim
 *           allaqachon ro'yxatda ekani JSHSHIR bo'yicha aniqlanadi;
 *        c. shu kadastrga tegishli fuqarolar umumiy bazadan topiladi;
 *        d. ro'yxatda yo'qlari bittadan:
 *             - davlat bazasidan (GCP yoki FHDYO) so'nggi ma'lumot;
 *             - shu ma'lumot bilan platformaga qo'shish;
 *             - natija (payload, javob, sabab) DB'ga yoziladi.
 *   3. Xonadon tugagach keyingisiga o'tiladi.
 *
 * Nega ketma-ket: tashqi API ~5 so'rov / 56 soniya limiti bilan
 * ishlaydi va yozish amallari bir xonadon kontekstida tartibli
 * bo'lishi kerak. Parallel yuborish limitni darhol urib, hamma
 * narsani sekinlashtiradi.
 *
 * Nega holat DB'da: jarayon soatlab davom etadi. Sahifa yopilsa yoki
 * server qayta ishga tushsa, yurish aynan to'xtagan xonadondan
 * davom etadi — qaytadan boshlash shart emas va platformada dublikat
 * paydo bo'lmaydi.
 */

import api from "../config/api.js";
import Citizen from "../models/Citizen.js";
import Street from "../models/Street.js";
import Home from "../models/Home.js";
import FamilyMember from "../models/FamilyMember.js";
import RegistrationRun from "../models/RegistrationRun.js";
import RegistrationHome from "../models/RegistrationHome.js";
import RegistrationMember from "../models/RegistrationMember.js";
import { withRateLimit } from "../utils/rate-limit.js";
import { requestContext } from "../utils/request-context.js";
import {
  extractMahallaName,
  mahallaKey,
  sameMahalla,
} from "../utils/mahalla.js";
import {
  toIsoDate,
  splitDocument,
  isBirthCertificate,
  extractBirthCertPerson,
  joinName,
  shortenDocumentType,
  isExpiredDocument,
} from "../utils/person-data.js";
import {
  DEFAULT_RELATIONSHIP,
  documentTypeCode,
  pickStudyLevel,
  yearsOld,
  reasonCodeOf,
  parseRegisteredPlace,
} from "../utils/registration-codes.js";
import { pushRunLog } from "../utils/registration-log.js";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Shu server nusxasining belgisi. Bitta bazaga bir nechta server
// ulanganda qaysi yurishni kim olib borayotganini ajratish uchun.
// Har ishga tushishda yangi bo'ladi — eski (o'chib qolgan) nusxa
// egaligi `OWNER_TIMEOUT_MS` dan keyin bo'shaydi.
const SERVER_ID = `${process.env.SERVER_NAME ?? "server"}-${process.pid}-${Date.now().toString(36)}`;
const SERVER_NAME = process.env.SERVER_NAME ?? "asosiy";

// Egasi shu vaqt davomida belgi qo'ymasa, yurish bo'sh deb
// hisoblanadi. Bitta odam ~20 soniya, rate-limit kutishi ~56
// soniya — shuning uchun chegara ulardan sezilarli katta.
const OWNER_TIMEOUT_MS = 300000;

const GCP_RETRIES = 3;
const RETRY_PAUSE_MS = 1200;
const NETWORK_WAIT_MS = 15000;

const NETWORK_ERRORS = new Set([
  "ENOTFOUND",
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "ECONNABORTED",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);

const isNetworkError = (err) =>
  !err?.response && (NETWORK_ERRORS.has(err?.code) || err?.code === "ERR_NETWORK");

// GCP ba'zan haqiqiy sababni bermasdan "Internal Server Error"
// qaytaradi — bu vaqtinchalik nosozlik, qayta so'rashda ko'pincha
// hal bo'ladi (yo ma'lumot keladi, yo aniq sabab chiqadi).
const isTransientError = (gcpData) =>
  /Internal Server Error/i.test(String(gcpData?.message ?? ""));

const isDeceased = (gcpData) =>
  /status_name\s*=\s*vafot etgan/i.test(String(gcpData?.message ?? ""));

// Bir vaqtda ishlab turgan yurishlar. Bitta yurish ikki marta
// ishga tushib qolmasligi uchun.
const activeRuns = new Set();

// Shu serverda ishlayaptimi.
export const isRunActive = (runId) => activeRuns.has(String(runId));

/**
 * Yurish umuman faolmi — SHU serverda yoki BOSHQASIDA.
 *
 * Bir nechta server bitta bazaga ulangan bo'lsa, `activeRuns`
 * yetarli emas: boshqa serverdagi yurish "to'xtagan" ko'rinardi va
 * foydalanuvchi uni qayta boshlab yuborishi mumkin edi.
 *
 * Shuning uchun yurishning o'z belgisiga qaraladi: egasi bor va
 * yaqinda belgi qo'ygan bo'lsa — faol.
 */
export const isRunActiveAnywhere = (run) => {
  if (!run) return false;
  if (activeRuns.has(String(run._id))) return true;

  if (!run.ownerId || !run.heartbeatAt) return false;

  return Date.now() - new Date(run.heartbeatAt) < OWNER_TIMEOUT_MS;
};

// Yurishni qaysi server olib boryapti (o'zimizmi yoki boshqasi).
export const runOwner = (run) => {
  if (!run?.ownerId) return null;
  return {
    name: run.ownerName ?? "boshqa server",
    isSelf: run.ownerId === SERVER_ID,
  };
};

/**
 * Tashqi API xatosidan eng foydali matnni chiqaradi. Axios'ning o'z
 * xabari ("Request failed with status code 400") sababni ko'rsatmaydi.
 */
export const describeError = (err) => {
  const data = err.response?.data;
  if (!data) return err.message || "Noma'lum xatolik";

  if (typeof data === "string") return data.slice(0, 300);

  // Validatsiya xatolari: { errors: { pinfl: ["..."] } }
  if (data.errors && typeof data.errors === "object") {
    const parts = Object.entries(data.errors).map(([field, messages]) => {
      const text = Array.isArray(messages) ? messages.join(", ") : messages;
      return `${field}: ${text}`;
    });
    if (parts.length) return parts.join(" | ").slice(0, 400);
  }

  const direct = data.message ?? data.error ?? data.detail ?? data.title;
  if (typeof direct === "string" && direct) return direct.slice(0, 300);

  try {
    return JSON.stringify(data).slice(0, 400);
  } catch {
    return err.message || "Noma'lum xatolik";
  }
};

// Rate-limit kutishini yurish holatiga yozadi — client "N soniya
// kutilmoqda" deb ko'rsatadi.
const waitReporter = (run) => (until) => {
  RegistrationRun.updateOne(
    { _id: run._id },
    { $set: { waitingUntil: until ?? null } },
  ).catch(() => {});

  if (!until) return;

  const seconds = Math.ceil((until - Date.now()) / 1000);
  if (seconds >= 3) {
    pushRunLog(run._id, {
      level: "wait",
      message: `Tashqi API limiti — ${seconds} soniya kutilmoqda`,
    });
  }
};

// Barcha tashqi so'rovlar bitta moslashuvchan oqimdan o'tadi:
// shunda limit bir joyda hisoblanadi va 429 ga umuman tushmaymiz.
const rateLimited = (run, fn) =>
  withRateLimit(fn, {
    delayMs: 150,
    adaptiveKey: `registration:${run.userUid}`,
    onWait: waitReporter(run),
  });

// ---------------------------------------------------------------
// Tashqi API chaqiruvlari
// ---------------------------------------------------------------

const fetchStreets = (user, run) =>
  rateLimited(run, () =>
    api.get("/api/v1/survey_homes/cache/street", {
      params: {
        obl_id: user.oblId,
        area_id: user.areaId,
        district_id: user.districtId,
      },
    }),
  ).then((response) => response.data?.results ?? []);

// Ko'cha bo'yicha barcha xonadonlar (javob sahifalangan, size=100).
const fetchStreetHomes = async (user, streetId, run) => {
  const size = 100;
  const all = [];
  let page = 1;
  let total = Infinity;

  while ((page - 1) * size < total) {
    const response = await rateLimited(run, () =>
      api.get("/api/v1/survey_homes_street/cache/data", {
        params: {
          obl_id: user.oblId,
          area_id: user.areaId,
          district_id: user.districtId,
          street_id: streetId,
          surveyed: 0,
          page,
          size,
        },
      }),
    );

    const results = response.data?.results ?? [];
    all.push(...results);
    total = response.data?.total ?? 0;
    page += 1;

    // Himoya: tashqi API `total` ni noto'g'ri bersa, sikl cheksiz
    // aylanib qolmasin.
    if (!results.length) break;
  }

  return all;
};

const fetchHomeForm = (user, homeId, run) =>
  rateLimited(run, () =>
    api.get(`/web/v1/forms/survey_homes/${homeId}`, {
      params: {
        obl_id: user.oblId,
        area_id: user.areaId,
        district_id: user.districtId,
      },
    }),
  ).then((response) => response.formData ?? null);

const fetchFamilyMembers = (user, streetId, surveyUuid, run) =>
  rateLimited(run, () =>
    api.get("/web/v1/tables/survey_homes_family/data", {
      params: {
        obl_id: user.oblId,
        area_id: user.areaId,
        district_id: user.districtId,
        street_id: streetId,
        survey_uuid: surveyUuid,
      },
    }),
  ).then((response) => response.data?.results ?? []);

const fetchGcpOnce = (pinfl, birthDate, run) =>
  rateLimited(run, () =>
    api.get("/api/v1/gcp/pinfl", {
      params: {
        pinfl,
        birth_date: birthDate,
        form_name: "survey_homes_family",
      },
    }),
  ).then((response) => response.data);

const fetchGcp = async (pinfl, birthDate, run) => {
  let last = null;

  for (let attempt = 1; attempt <= GCP_RETRIES; attempt++) {
    last = await fetchGcpOnce(pinfl, birthDate, run);

    // Javob aniq bo'lsa (muvaffaqiyat yoki tushunarli sabab) —
    // qayta so'rashning hojati yo'q.
    if (last?.code === 0 || !isTransientError(last)) return last;
    if (attempt < GCP_RETRIES) await pause(RETRY_PAUSE_MS);
  }

  return last;
};

const fetchBirthCert = (series, number, birthDate, run) =>
  rateLimited(run, () =>
    api.get("/api/v2/fhdyo/act/birth", {
      params: { serial: series, number, birth_date: birthDate },
    }),
  ).then((response) => response.data);

/**
 * MIP — pasport seriya+raqam bo'yicha qidiradi va JSHSHIR'ni
 * qaytaradi.
 *
 * Nega kerak: GCP faqat JSHSHIR bo'yicha qidiradi, FHDYO esa faqat
 * tug'ilganlik guvohnomasini biladi. Ya'ni "JSHSHIR'i yo'q, lekin
 * pasporti bor" odamni ikkalasi ham topa olmaydi — bazadagi bunday
 * yozuvlar shu paytgacha umuman qidirilmasdan chetda qolardi.
 *
 * DIQQAT: topilmaganda ham `code: 0` ("OK") qaytadi, lekin ichida
 * `pinfl: null` va matn maydonlari "PASSPORT MA`LUMOTLARI TOPILMADI"
 * bo'ladi. Shuning uchun muvaffaqiyat `code` bo'yicha emas, `pinfl`
 * bo'yicha aniqlanadi.
 */
const fetchPassportPinfl = (series, number, birthDate, run) =>
  rateLimited(run, () =>
    api.get("/api/v2/mip/passport/birth-date", {
      params: {
        passport_serial: series,
        passport_number: number,
        birth_date: birthDate,
        form_name: "survey_homes_family",
      },
    }),
  ).then((response) => response.data);

// MIP javobidagi "topilmadi" belgisi.
const MIP_NOT_FOUND = /MA[`'’]?LUMOTLARI\s+TOPILMADI/i;

const mipPerson = (mipData) => {
  const person = mipData?.data;
  if (!person?.pinfl) return null;

  // Ism o'rnida "PASSPORT MA`LUMOTLARI TOPILMADI" turgan bo'lsa,
  // bu haqiqiy ma'lumot emas.
  if (MIP_NOT_FOUND.test(String(person.full_name ?? ""))) return null;

  return person;
};

const postFamilyMember = (payload, params, run) =>
  rateLimited(run, () =>
    api.post("/web/v1/forms/survey_homes_family", payload, { params }),
  );

// ---------------------------------------------------------------
// Fuqaroni davlat bazasidan tasdiqlash
// ---------------------------------------------------------------

// Hujjat seriyasi/raqamini har safar `document` dan qayta hisoblaymiz:
// DB'dagi tayyor maydonlar eski import paytidagi (kamroq formatni
// biladigan) mantiq bilan to'ldirilgan bo'lishi mumkin.
const documentParts = (citizen) => {
  const parsed = splitDocument(citizen.document);
  if (parsed.series) return parsed;

  return {
    series: citizen.documentSeries ?? null,
    number: citizen.documentNumber ?? null,
  };
};

/**
 * Bitta fuqaroni davlat bazasidan tasdiqlaydi.
 *
 * Platforma yuborilgan F.I.Sh. va tug'ilgan sanani rasmiy baza bilan
 * AYNAN solishtiradi, farq bo'lsa "Маълумотлар мувофиқ эмас" deb rad
 * etadi. Shuning uchun Excel'dagi qiymatga ishonmaymiz — har safar
 * bazadan olinadi.
 *
 * JSHSHIR bor                     -> GCP (pasport bazasi)
 * JSHSHIR yo'q, hujjati guvohnoma -> FHDYO (JSHSHIR'ni ham beradi,
 *   keyin GCP bilan ham tekshiramiz: bola pasport olgan bo'lishi
 *   mumkin)
 *
 * Qaytaradi: { verified, registryResponse } yoki { skip, registryResponse }
 */
const verifyCitizen = async (citizen, run) => {
  const isoBirthDate = toIsoDate(citizen.birthDate);
  if (!isoBirthDate) {
    return { skip: "Tug'ilgan sana noto'g'ri yoki yo'q" };
  }

  let pinfl = citizen.pinfl ? String(citizen.pinfl) : null;
  let cert = null;
  let passport = null;

  // 1-bosqich: JSHSHIR yo'q — hujjat turiga qarab qidiramiz.
  //   guvohnoma -> FHDYO
  //   pasport   -> MIP
  if (!pinfl) {
    const { series, number } = documentParts(citizen);

    // Pasport seriyasini FHDYO'ga yuborish mantiqsiz: u faqat
    // guvohnomalarni biladi va har safar "topilmadi" qaytaradi.
    // Lekin pasport bo'yicha MIP bazasidan JSHSHIR'ni topish mumkin.
    if (!number || !isBirthCertificate(series)) {
      if (!number || !series) {
        return { skip: "JSHSHIR ham, hujjat ham yo'q" };
      }

      const mipData = await fetchPassportPinfl(
        series,
        number,
        isoBirthDate,
        run,
      );
      const person = mipPerson(mipData);

      if (!person) {
        return {
          skip: `JSHSHIR yo'q, pasport (${citizen.document}) bo'yicha ham topilmadi`,
          registryResponse: mipData,
        };
      }

      // JSHSHIR topildi — endi uni GCP bilan tasdiqlaymiz (pastdagi
      // 2-bosqich). Pasport ma'lumoti o'zi ham yetarli, lekin GCP
      // hujjatning amaldagi holatini (vafot etgan, yaroqsiz) biladi.
      pinfl = String(person.pinfl);

      passport = {
        fullName: person.full_name,
        birthDate: person.birth_date ?? isoBirthDate,
        pinfl: String(person.pinfl),
        docSeries: series,
        docNumber: number,
        documentType: "Passport",
        response: mipData,
      };
    } else {
      // Tug'ilganlik guvohnomasi — FHDYO bazasidan.
      const response = await fetchBirthCert(series, number, isoBirthDate, run);
      const person = extractBirthCertPerson(response);

      if (!person) {
        return {
          skip: response?.message || "Guvohnoma bo'yicha ma'lumot topilmadi",
          registryResponse: response,
        };
      }

      cert = {
        fullName: joinName(person.surname, person.name, person.patronym),
        birthDate: person.birth_date,
        pinfl: person.pinfl != null ? String(person.pinfl) : null,
        docSeries: person.cert_series ?? series,
        docNumber: person.cert_number ?? number,
        documentType: "Tug'ilganlik guvohnomasi",
        response,
      };

      pinfl = cert.pinfl;

      // Guvohnoma topildi, lekin JSHSHIR hali berilmagan. Platforma
      // JSHSHIR'siz qabul qilmaydi ("pinfl: Bo'sh bo'lmasligi
      // kerak"), shuning uchun bekorga so'rov yubormaymiz.
      if (!pinfl) {
        return {
          skip: "Guvohnoma topildi, lekin JSHSHIR hali berilmagan",
          registryResponse: response,
        };
      }
    }
  }

  // 2-bosqich: JSHSHIR ma'lum — pasport bazasidan so'raymiz.
  const gcpData = await fetchGcp(pinfl, isoBirthDate, run);

  if (gcpData?.code === 0) {
    const person = gcpData.data ?? {};
    const { series, number } = splitDocument(person.current_document);
    const docType = shortenDocumentType(person.documents?.[0]?.type);

    return {
      verified: {
        fullName:
          person.full_name ??
          cert?.fullName ??
          passport?.fullName ??
          citizen.fullName,
        // Platforma ISO (YYYY-MM-DD) formatni kutadi.
        birthDate: person.birth_date ?? isoBirthDate,
        pinfl:
          person.current_pinfl != null ? String(person.current_pinfl) : pinfl,
        docSeries: series ?? cert?.docSeries ?? passport?.docSeries,
        docNumber: number ?? cert?.docNumber ?? passport?.docNumber,
        documentType: docType ?? cert?.documentType ?? "Passport",
        via: "gcp",
      },
      registryResponse: gcpData,
    };
  }

  // GCP topmadi, lekin MIP (pasport bazasi) topgan edi — o'shani
  // ishlatamiz. Bu holat uchraydi: GCP JSHSHIR bo'yicha qidiradi va
  // ba'zan topa olmaydi, MIP esa pasport bo'yicha topadi.
  if (passport) {
    return {
      verified: {
        fullName: passport.fullName,
        birthDate: passport.birthDate,
        pinfl: passport.pinfl,
        docSeries: passport.docSeries,
        docNumber: passport.docNumber,
        documentType: passport.documentType,
        via: "mip",
      },
      registryResponse: passport.response,
    };
  }

  // GCP topmadi. Bola bo'lsa — guvohnoma yetarli, FHDYO ma'lumoti
  // bilan qo'shamiz (pasport hali yo'q).
  if (cert) {
    return {
      verified: {
        fullName: cert.fullName,
        birthDate: cert.birthDate,
        pinfl: cert.pinfl,
        docSeries: cert.docSeries,
        docNumber: cert.docNumber,
        documentType: cert.documentType,
        via: "fhdyo",
      },
      registryResponse: cert.response,
    };
  }

  // Holati o'zgarmaydigan sabablar — qayta urinish befoyda.
  if (isDeceased(gcpData)) {
    return {
      skip: "Vafot etgan (davlat bazasi ma'lumoti)",
      registryResponse: gcpData,
    };
  }

  if (isExpiredDocument(gcpData)) {
    return {
      skip: "Hujjati yaroqsiz / muddati o'tgan",
      registryResponse: gcpData,
    };
  }

  return {
    skip: gcpData?.message || "Davlat bazasida ma'lumot topilmadi",
    registryResponse: gcpData,
  };
};

// ---------------------------------------------------------------
// Bitta odamni ro'yxatga olish
// ---------------------------------------------------------------

/**
 * Bitta odamni platformaga qo'shadi va butun yo'lni (bazadan nima
 * kelgani, nima yuborilgani, platforma nima javob bergani)
 * RegistrationMember yozuviga yozadi.
 *
 * Qaytaradi: "added" | "exists" | "skipped" | "failed"
 */
/**
 * JSHSHIR'siz odam uchun kesh kaliti — guvohnoma seriyasi, raqami
 * va tug'ilgan sanasi. Aynan shu uchlik FHDYO so'roviga yuboriladi,
 * ya'ni bir xil kalit bir xil javobni beradi.
 */
const certCacheKey = (citizen) => {
  const parsed = splitDocument(citizen.document);
  const series = parsed.series ?? citizen.documentSeries;
  const number = parsed.number ?? citizen.documentNumber;

  if (!series || !number) return null;
  return `${series}|${number}|${citizen.birthDate ?? ""}`;
};

const registerOneMember = async (
  user,
  run,
  homeRow,
  citizen,
  knownPinfls,
  takenPinfls,
  hopelessPinfls,
  certPinfls,
) => {
  const startedAt = Date.now();

  const member = await RegistrationMember.create({
    runId: run._id,
    homeRowId: homeRow._id,
    cadasterNumber: homeRow.cadasterNumber,
    homeId: homeRow.homeId,
    citizenId: citizen._id,
    fullName: citizen.fullName,
    birthDate: citizen.birthDate,
    document: citizen.document,
    pinfl: citizen.pinfl ?? null,
    status: "pending",
    attemptedAt: new Date(),
    userUid: user.uid,
  });

  const finish = (fields) =>
    RegistrationMember.updateOne(
      { _id: member._id },
      { $set: { ...fields, durationMs: Date.now() - startedAt } },
    );

  // Xonadon egasining o'zini a'zo qilib qo'shib bo'lmaydi — u
  // allaqachon egasi sifatida ro'yxatda turadi, platforma rad etadi.
  if (
    citizen.pinfl &&
    homeRow.ownerPinfl &&
    String(citizen.pinfl) === String(homeRow.ownerPinfl)
  ) {
    const reason = "Xonadon egasi — a'zo qilib qo'shilmaydi";
    await finish({ status: "skipped", reason, reasonCode: "xonadon_egasi" });

    pushRunLog(run._id, {
      level: "skip",
      fullName: citizen.fullName,
      message: reason,
    });

    return "skipped";
  }

  // Bu odam oldin ham tekshirilgan va holati o'zgarmaydigan sabab
  // bilan chetda qolgan (vafot etgan, hujjati yaroqsiz). Bazada bir
  // odam bir nechta kadastrda uchraydi — uni har safar davlat
  // bazasidan qayta so'rash bekorga rate-limit sarflaydi, javob esa
  // o'sha-o'sha keladi.
  const hopeless = citizen.pinfl ? hopelessPinfls.get(String(citizen.pinfl)) : null;

  if (hopeless) {
    await finish({
      status: "skipped",
      reason: hopeless,
      reasonCode: reasonCodeOf(hopeless),
    });

    pushRunLog(run._id, {
      level: "skip",
      fullName: citizen.fullName,
      message: `${hopeless} — avval aniqlangan, qayta so'ralmadi`,
    });

    return "skipped";
  }

  // Manbada JSHSHIR yo'q (bazadagi yozuvlarning ~14% i — bolalar,
  // ularda faqat tug'ilganlik guvohnomasi bor). Bunday odamning
  // JSHSHIR'i FHDYO javobidan ma'lum bo'ladi, ya'ni so'rovsiz bilib
  // bo'lmaydi. Lekin bir marta bilib olgach, guvohnoma raqamini
  // eslab qolamiz — keyingi uchrashuvda so'rov kerak emas.
  const certKey = citizen.pinfl ? null : certCacheKey(citizen);
  const cachedPinfl = certKey ? certPinfls.get(certKey) : null;

  // Manbadagi (yoki guvohnoma orqali eslab qolingan) JSHSHIR
  // allaqachon ro'yxatda bo'lsa, davlat bazasiga umuman murojaat
  // qilmaymiz — javob baribir ishlatilmaydi.
  //
  // Pastda ham shunga o'xshash tekshiruv bor, lekin u davlat
  // bazasidan qaytgan `current_pinfl` bo'yicha ketadi (odamning
  // JSHSHIR'i almashtirilgan bo'lishi mumkin). Ya'ni bu yerdagisi
  // so'rovni TEJAYDI, pastdagisi esa chetlab o'tilganini USHLAYDI —
  // ikkalasi ham kerak.
  const sourcePinfl = citizen.pinfl ?? cachedPinfl;

  if (sourcePinfl && knownPinfls.has(String(sourcePinfl))) {
    const reason = "Platformada allaqachon ro'yxatda (shu yoki boshqa xonadonda)";

    await finish({
      status: "exists",
      reason,
      reasonCode: "allaqachon_mavjud",
    });

    pushRunLog(run._id, {
      level: "skip",
      fullName: citizen.fullName,
      message: `${reason} — qayta so'ralmadi`,
    });

    return "exists";
  }

  // --- Davlat bazasidan tasdiqlash ---
  let verification;

  try {
    verification = await verifyCitizen(citizen, run);
  } catch (err) {
    // Tarmoq uzilishi — odamning aybi yo'q. Kutib, bir marta qayta
    // urinamiz, aks holda uzilish paytidagi o'nlab odam bekorga
    // "xato" bo'lib qolardi.
    if (isNetworkError(err)) {
      pushRunLog(run._id, {
        level: "wait",
        message: `Tarmoq uzildi (${err.code}) — ${NETWORK_WAIT_MS / 1000} soniya kutilmoqda`,
      });

      await RegistrationRun.updateOne(
        { _id: run._id },
        { $set: { waitingUntil: Date.now() + NETWORK_WAIT_MS } },
      );
      await pause(NETWORK_WAIT_MS);
      await RegistrationRun.updateOne(
        { _id: run._id },
        { $set: { waitingUntil: null } },
      );

      try {
        verification = await verifyCitizen(citizen, run);
      } catch (retryErr) {
        const reason = describeError(retryErr);
        await finish({
          status: "failed",
          reason,
          reasonCode: reasonCodeOf(reason),
        });

        pushRunLog(run._id, {
          level: "error",
          fullName: citizen.fullName,
          message: `Tasdiqlashda xatolik: ${reason}`,
        });

        return "failed";
      }
    } else {
      const reason = describeError(err);
      await finish({
        status: "failed",
        reason,
        reasonCode: reasonCodeOf(reason),
      });

      pushRunLog(run._id, {
        level: "error",
        fullName: citizen.fullName,
        message: `Tasdiqlashda xatolik: ${reason}`,
      });

      return "failed";
    }
  }

  if (verification.skip) {
    const skipCode = reasonCodeOf(verification.skip);

    // Holati hech qachon o'zgarmaydigan sabablar: vafot etgan,
    // hujjati yaroqsiz. Bir odam bazada bir nechta kadastrda
    // uchraydi — uni har safar davlat bazasidan qayta so'rash
    // bekorga rate-limit sarflaydi. Shuning uchun band deb
    // belgilaymiz.
    if (["vafot_etgan", "hujjat_yaroqsiz"].includes(skipCode) && citizen.pinfl) {
      hopelessPinfls.set(String(citizen.pinfl), verification.skip);
    }

    await finish({
      status: "skipped",
      reason: verification.skip,
      reasonCode: skipCode,
      registryResponse: verification.registryResponse ?? null,
    });

    pushRunLog(run._id, {
      level: "skip",
      fullName: citizen.fullName,
      message: verification.skip,
    });

    return "skipped";
  }

  const verified = verification.verified;

  // Guvohnoma orqali topilgan JSHSHIR'ni eslab qolamiz: shu bola
  // boshqa kadastrda yoki xonadon qayta ishlanganda uchrasa, FHDYO
  // so'rovi takrorlanmaydi.
  if (certKey && verified.pinfl) {
    certPinfls.set(certKey, String(verified.pinfl));
  }

  // Tasdiqlangandan keyin JSHSHIR o'zgargan bo'lishi mumkin (GCP
  // "current_pinfl" ni qaytaradi). Shu JSHSHIR platformada bo'lsa —
  // yubormaymiz, baribir rad etiladi.
  if (knownPinfls.has(String(verified.pinfl))) {
    const reason =
      "Platformada allaqachon ro'yxatda (shu yoki boshqa xonadonda)";
    await finish({
      status: "exists",
      reason,
      reasonCode: "allaqachon_mavjud",
      verifiedPinfl: verified.pinfl,
      verifiedFullName: verified.fullName,
      verifiedVia: verified.via,
      registryResponse: verification.registryResponse ?? null,
    });

    pushRunLog(run._id, {
      level: "skip",
      fullName: verified.fullName,
      message: reason,
    });

    return "exists";
  }

  const docType = documentTypeCode(verified.documentType);
  if (!docType) {
    const reason = `Hujjat turi aniqlanmadi: "${verified.documentType ?? "bo'sh"}"`;
    await finish({ status: "skipped", reason, reasonCode: "boshqa" });

    pushRunLog(run._id, {
      level: "skip",
      fullName: verified.fullName,
      message: reason,
    });

    return "skipped";
  }

  if (!verified.docSeries || !verified.docNumber) {
    const reason = "Hujjat seriyasi yoki raqami aniqlanmadi";
    await finish({ status: "skipped", reason, reasonCode: "boshqa" });

    pushRunLog(run._id, {
      level: "skip",
      fullName: verified.fullName,
      message: reason,
    });

    return "skipped";
  }

  // --- Platformaga yuborish ---
  const age = yearsOld(verified.birthDate);
  const studyLevel = pickStudyLevel(age, verified.pinfl);

  const payload = {
    pinfl: Number(verified.pinfl),
    full_name: verified.fullName,
    address: null,
    phone: "",
    birth_date: verified.birthDate,
    study_level_id: String(studyLevel),
    doc_serial: verified.docSeries,
    doc_number: verified.docNumber,
    // Qarindoshlik darajasi umumiy fuqarolar bazasida yo'q — faqat
    // kadastr bor, kim kimga nima bo'lishi yozilmagan. Noto'g'ri
    // daraja ko'rsatgandan ko'ra "Boshqa" to'g'riroq.
    relationship: String(DEFAULT_RELATIONSHIP),
    document_type: String(docType),
  };

  const params = {
    _target: "modal",
    pinfl: verified.pinfl,
    obl_id: user.oblId,
    area_id: user.areaId,
    district_id: user.districtId,
    street_id: homeRow.streetId,
    survey_uuid: homeRow.surveyUuid,
    owner_pinfl: homeRow.ownerPinfl,
  };

  const verifiedFields = {
    verifiedFullName: verified.fullName,
    verifiedBirthDate: verified.birthDate,
    verifiedPinfl: verified.pinfl,
    verifiedDocSeries: verified.docSeries,
    verifiedDocNumber: verified.docNumber,
    verifiedDocumentType: verified.documentType,
    verifiedVia: verified.via,
    registryResponse: verification.registryResponse ?? null,
    relationshipCode: String(DEFAULT_RELATIONSHIP),
    studyLevelCode: String(studyLevel),
    documentTypeCode: String(docType),
    sentPayload: payload,
    sentParams: params,
  };

  pushRunLog(run._id, {
    level: "request",
    fullName: verified.fullName,
    message: `POST — ${verified.pinfl}, ${verified.docSeries}${verified.docNumber}, ${age} yosh, ta'lim kodi ${studyLevel}`,
  });

  try {
    const response = await postFamilyMember(payload, params, run);
    const memberId = response?.id != null ? String(response.id) : null;

    await finish({
      ...verifiedFields,
      status: "added",
      memberId,
      platformResponse: response ?? null,
      httpStatus: 200,
      reason: null,
      reasonCode: null,
    });

    // Shu yurishning o'zida bir xil odam ikkinchi marta uchrashi
    // mumkin (bazada takrorlangan qator yoki bir odam bir nechta
    // kadastrda) — endi u platformada bor.
    knownPinfls.add(String(verified.pinfl));
    takenPinfls.add(String(verified.pinfl));

    pushRunLog(run._id, {
      level: "success",
      fullName: verified.fullName,
      message: `Qo'shildi — ID ${memberId ?? "?"}`,
      ms: Date.now() - startedAt,
    });

    return "added";
  } catch (err) {
    const reason = describeError(err);
    const reasonCode = reasonCodeOf(reason);

    // Platforma "bu odam allaqachon boshqa xonadonda ro'yxatda" deb
    // rad etgan bo'lsa, uni band deb belgilaymiz: bazada bir odam
    // bir nechta kadastrda uchraydi, keyingi xonadonlarda yana
    // urinib, rate-limitni bekorga sarflamaymiz.
    if (
      ["boshqa_xonadon_egasi", "boshqa_xonadon_azosi", "allaqachon_mavjud"].includes(
        reasonCode,
      )
    ) {
      takenPinfls.add(String(verified.pinfl));
    }

    // Platforma "boshqa xonadonda ro'yxatda" desa, xabar ichida
    // o'sha joyning manzili bo'ladi. Uni ajratib saqlaymiz: mahalla
    // xodimi uchun "odam qayerga ko'chib ketgan" degan savol
    // hisobotdan ko'rinib tursin.
    const place = parseRegisteredPlace(reason);
    const placeFields = place
      ? {
          registeredRegion: place.region,
          registeredMahalla: place.mahalla,
          // O'z mahallamizda boshqa xonadondami yoki butunlay
          // boshqa joydami — ikkisi mahalla uchun turli ma'no
          // anglatadi.
          //
          // Taqqoslash `sameMahalla` orqali: platforma mahalla
          // nomini biroz boshqacha yozadi ("Сарновул" / "САРНАВУЛ"),
          // oddiy kalit solishtiruvi esa o'z mahallasini "ko'chib
          // ketgan" deb ko'rsatib qo'yadi.
          movedAway: !sameMahalla(place.mahalla, run.mahallaName),
        }
      : {};

    await finish({
      ...verifiedFields,
      ...placeFields,
      status: "failed",
      reason,
      reasonCode,
      platformResponse: err.response?.data ?? null,
      httpStatus: err.response?.status ?? null,
    });

    pushRunLog(run._id, {
      level: "error",
      fullName: verified.fullName,
      message: reason,
      status: err.response?.status,
      ms: Date.now() - startedAt,
    });

    return "failed";
  }
};

// ---------------------------------------------------------------
// Bitta xonadonni ishlash
// ---------------------------------------------------------------

const processHome = async (
  user,
  run,
  homeRow,
  takenPinfls,
  hopelessPinfls,
  certPinfls,
) => {
  const startedAt = Date.now();

  await RegistrationHome.updateOne(
    { _id: homeRow._id },
    { $set: { status: "processing", startedAt: new Date() } },
  );

  pushRunLog(run._id, {
    level: "home",
    message: `Xonadon ${homeRow.homeNum ?? homeRow.homeId} — ${homeRow.cadasterNumber ?? "kadastr yo'q"}${homeRow.streetName ? ` (${homeRow.streetName})` : ""}`,
  });

  // Bu xonadon oldin yarim ishlangan bo'lishi mumkin (server
  // kutilmaganda o'chgan). Tugallanmagan ("pending") urinishlarni
  // o'chiramiz: ular natijani bildirmaydi, lekin hisobotni
  // chalkashtiradi. Tugagan urinishlar (added/failed/skipped)
  // joyida qoladi — ular haqiqiy tarix.
  const stale = await RegistrationMember.deleteMany({
    homeRowId: homeRow._id,
    status: "pending",
  });

  // Oldingi urinishda allaqachon qo'shilgan odamlarni qayta
  // yubormaslik uchun ularning JSHSHIR'ini band deb belgilaymiz.
  const alreadyTried = await RegistrationMember.find(
    { homeRowId: homeRow._id, status: { $in: ["added", "exists"] } },
    "verifiedPinfl pinfl",
  ).lean();

  // IKKALA JSHSHIR ham saqlanadi: manbadagi (`pinfl`) va davlat
  // bazasi tasdiqlagani (`verifiedPinfl`). Ular farq qilishi mumkin
  // (JSHSHIR almashtirilgan bo'lsa), tekshiruv esa ikki joyda
  // ketadi — so'rovdan oldin manbadagi bo'yicha, so'rovdan keyin
  // tasdiqlangani bo'yicha. Faqat bittasini saqlasak, so'rovdan
  // oldingi tekshiruv ishlamay qolardi.
  for (const attempt of alreadyTried) {
    for (const pinfl of [attempt.pinfl, attempt.verifiedPinfl]) {
      if (pinfl) takenPinfls.add(String(pinfl));
    }
  }

  if (stale.deletedCount || alreadyTried.length) {
    pushRunLog(run._id, {
      level: "info",
      message: `Bu xonadon oldin yarim ishlangan: ${alreadyTried.length} ta tugagan urinish saqlandi, ${stale.deletedCount} ta tugallanmagani tozalandi`,
    });
  }

  const finishHome = (fields) =>
    RegistrationHome.updateOne(
      { _id: homeRow._id },
      {
        $set: {
          ...fields,
          finishedAt: new Date(),
          durationMs: Date.now() - startedAt,
        },
      },
    );

  const empty = { added: 0, failed: 0, skipped: 0, candidates: 0 };

  // --- survey_uuid va egasining JSHSHIR'i ---
  // Ikkalasi ham a'zo qo'shish uchun majburiy. Ro'yxat endpointi
  // survey_uuid'ni bermaydi — xonadon formasidan olinadi.
  if (!homeRow.surveyUuid || !homeRow.ownerPinfl) {
    try {
      const formData = await fetchHomeForm(user, homeRow.homeId, run);

      if (formData?.survey_uuid) homeRow.surveyUuid = formData.survey_uuid;
      if (formData?.pinfl) homeRow.ownerPinfl = String(formData.pinfl);
      if (formData?.full_name) homeRow.ownerFullName = formData.full_name;

      await RegistrationHome.updateOne(
        { _id: homeRow._id },
        {
          $set: {
            surveyUuid: homeRow.surveyUuid,
            ownerPinfl: homeRow.ownerPinfl,
            ownerFullName: homeRow.ownerFullName,
          },
        },
      );
    } catch (err) {
      const reason = describeError(err);
      await finishHome({ status: "failed", reason });

      pushRunLog(run._id, {
        level: "error",
        message: `Xonadon formasi yuklanmadi: ${reason}`,
      });

      return { homeStatus: "failed", ...empty };
    }
  }

  if (!homeRow.surveyUuid) {
    const reason = "Xonadonning survey_uuid'i yo'q — a'zo qo'shib bo'lmaydi";
    await finishHome({ status: "failed", reason });

    pushRunLog(run._id, { level: "error", message: reason });
    return { homeStatus: "failed", ...empty };
  }

  // --- Platformada hozir kim bor? ---
  // Har safar yangidan so'raymiz: oldingi yurish yoki boshqa xodim
  // allaqachon kimnidir qo'shgan bo'lishi mumkin.
  let existing = [];

  try {
    existing = await fetchFamilyMembers(
      user,
      homeRow.streetId,
      homeRow.surveyUuid,
      run,
    );
  } catch (err) {
    const reason = describeError(err);
    await finishHome({ status: "failed", reason });

    pushRunLog(run._id, {
      level: "error",
      message: `Oila a'zolari yuklanmadi: ${reason}`,
    });

    return { homeStatus: "failed", ...empty };
  }

  // Shu xonadonda hozir turganlar + butun yurish bo'yicha "band"
  // JSHSHIR'lar.
  //
  // Platforma bir shaxsni ikki joyda ro'yxatga olishga yo'l bermaydi:
  // odam boshqa xonadonning EGASI yoki A'ZOSI bo'lsa, so'rov
  // "Ушбу фуқаро ... хонадон эгаси сифатида ..." deb rad etiladi.
  // Bazada esa bir odam bir nechta kadastrda uchraydi (ro'yxat
  // yillar bo'yicha yig'ilgan). Shuning uchun band JSHSHIR'lar
  // yurish davomida yig'ilib boradi va bunday odamga bekorga so'rov
  // yuborilmaydi — rate-limit tejaladi.
  const knownPinfls = new Set(takenPinfls);
  for (const person of existing) {
    if (person.pinfl) {
      knownPinfls.add(String(person.pinfl));
      takenPinfls.add(String(person.pinfl));
    }
  }
  if (homeRow.ownerPinfl) {
    knownPinfls.add(String(homeRow.ownerPinfl));
    takenPinfls.add(String(homeRow.ownerPinfl));
  }

  // --- Shu kadastrga tegishli fuqarolar ---
  if (!homeRow.cadasterNumber) {
    const reason = "Xonadonda kadastr raqami yo'q — fuqarolarni topib bo'lmaydi";
    await finishHome({
      status: "skipped",
      reason,
      existingCount: existing.length,
    });

    pushRunLog(run._id, { level: "skip", message: reason });
    return { homeStatus: "skipped", ...empty };
  }

  const citizens = await Citizen.find({
    cadasterNumber: homeRow.cadasterNumber,
  })
    .sort({ birthDate: 1, rowNumber: 1 })
    .lean();

  // Allaqachon ro'yxatda turganlarga so'rov yubormaymiz — rate-limit
  // bekorga sarflanmasligi uchun.
  const candidates = citizens.filter(
    (citizen) => !citizen.pinfl || !knownPinfls.has(String(citizen.pinfl)),
  );

  pushRunLog(run._id, {
    level: "info",
    message: `Platformada ${existing.length} a'zo, bazada ${citizens.length} fuqaro — kiritiladi ${candidates.length} ta`,
  });

  if (!candidates.length) {
    await finishHome({
      status: "skipped",
      reason: citizens.length
        ? "Bazadagi barcha fuqarolar allaqachon ro'yxatda"
        : "Bu kadastr bo'yicha fuqarolar bazasida yozuv yo'q",
      existingCount: existing.length,
      candidatesCount: 0,
    });

    return { homeStatus: "skipped", ...empty };
  }

  // --- Bittadan ro'yxatga olish ---
  let added = 0;
  let failed = 0;
  let skipped = 0;

  for (const citizen of candidates) {
    const result = await registerOneMember(
      user,
      run,
      homeRow,
      citizen,
      knownPinfls,
      takenPinfls,
      hopelessPinfls,
      certPinfls,
    );

    if (result === "added") added += 1;
    else if (result === "failed") failed += 1;
    else skipped += 1;

    // Har odamdan keyin hisoblagich yangilanadi — client jonli
    // ko'rib turadi. Qayta hisoblash manbadan ketadi, shuning uchun
    // xonadon qayta ishlangan bo'lsa ham son to'g'ri qoladi.
    await recountRun(run._id);
  }

  // Xonadonning holati a'zolar natijasidan chiqadi. Diqqat: bu
  // yerda "failed" xonadonning O'ZI ishlanmaganini bildirmaydi
  // (u muvaffaqiyatli o'qildi) — a'zolarining hammasi rad etilgan.
  // Shuning uchun sabab ham shu tilda yoziladi, aks holda
  // jadvalda bo'sh katak qolardi.
  const homeStatus = failed > 0 ? (added > 0 ? "partial" : "failed") : "done";

  const summary = (() => {
    if (homeStatus === "done") {
      return added > 0
        ? `${added} a'zo kiritildi`
        : `Kiritiladigan a'zo qolmadi (${skipped} o'tkazildi)`;
    }

    if (homeStatus === "partial") {
      return `${added} kiritildi, ${failed} ta a'zo rad etildi`;
    }

    return `Hech kim kiritilmadi — ${failed} ta a'zo rad etildi${skipped ? `, ${skipped} o'tkazildi` : ""}`;
  })();

  await finishHome({
    status: homeStatus,
    existingCount: existing.length,
    candidatesCount: candidates.length,
    addedCount: added,
    failedCount: failed,
    skippedCount: skipped,
    reason: summary,
  });

  pushRunLog(run._id, {
    level: added > 0 ? "success" : "info",
    message: `Xonadon tugadi — ${added} qo'shildi, ${failed} xato, ${skipped} o'tkazildi`,
    ms: Date.now() - startedAt,
  });

  return { homeStatus, added, failed, skipped, candidates: candidates.length };
};

// ---------------------------------------------------------------
// Navbatni tuzish
// ---------------------------------------------------------------

/**
 * Yurish hisoblagichlarini haqiqiy yozuvlardan qayta hisoblaydi.
 *
 * `$inc` ishonchsiz: xonadon qayta ishlanishi mumkin (server o'chib
 * qolsa), bunda bir natija ikki marta sanalardi. Shuning uchun son
 * har xonadondan keyin manbadan — RegistrationHome va
 * RegistrationMember dan — qayta olinadi.
 */
const recountRun = async (runId) => {
  const [homeRows, memberRows] = await Promise.all([
    RegistrationHome.aggregate([
      { $match: { runId } },
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
          candidates: { $sum: "$candidatesCount" },
        },
      },
    ]),
    RegistrationMember.aggregate([
      { $match: { runId } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
  ]);

  const homes = {};
  let candidates = 0;
  for (const row of homeRows) {
    homes[row._id] = row.count;
    candidates += row.candidates ?? 0;
  }

  const members = {};
  for (const row of memberRows) members[row._id] = row.count;

  // "Ishlangan" — tugagan holatlarni TO'G'RIDAN-TO'G'RI sanaymiz.
  //
  // Avval bu son "jami minus navbatdagilar" bilan hisoblanardi.
  // Natijada "Vaqtinchalik xatolarni qayta urinish" bosilganda
  // xonadon `pending` ga qaytib, umumiy progress ORQAGA ketardi
  // (17/569 -> 16/569). Arifmetika to'g'ri, lekin ma'nosi noto'g'ri:
  // bitta xonadonni qayta ochish butun yurish progressini
  // kamaytirmasligi kerak.
  const homesDone =
    (homes.done ?? 0) +
    (homes.partial ?? 0) +
    (homes.skipped ?? 0) +
    (homes.failed ?? 0);

  // Qayta urinish uchun ochilgan xonadon `pending` ga qaytadi va
  // `homesDone` bir kamayadi. Progress orqaga ketmasligi uchun eng
  // yuqori qiymatni saqlaymiz: xonadon qaytadan ishlanganda son
  // o'z joyiga qaytadi, oradagi vaqtda esa kamayib ko'rinmaydi.
  await RegistrationRun.updateOne(
    { _id: runId },
    {
      $max: { homesDone },
      $set: {
        homesFailed: homes.failed ?? 0,
        membersTotal: candidates,
        membersAdded: members.added ?? 0,
        membersFailed: members.failed ?? 0,
        // "exists" ham o'tkazilganlar qatoriga kiradi: so'rov
        // yuborilmagan, odam allaqachon ro'yxatda.
        membersSkipped: (members.skipped ?? 0) + (members.exists ?? 0),
        heartbeatAt: new Date(),
      },
    },
  );
};

// Ishchi har qadamda boshqaruv ko'rsatmasini DB'dan o'qiydi —
// shuning uchun "to'xtatish" tugmasi darhol ishlaydi.
const readControl = async (run) => {
  const fresh = await RegistrationRun.findById(run._id, "control").lean();
  return fresh?.control ?? "stop";
};

/**
 * MFY ning xonadonlarini yuklab, navbatni tuzadi.
 *
 * Platforma xonadonlarni MFY bo'yicha emas, KO'CHA bo'yicha beradi;
 * mahalla nomi esa faqat fuqarolar bazasidagi manzilda bor. Shuning
 * uchun: avval mahallaga tegishli kadastrlar fuqarolar bazasidan
 * aniqlanadi, so'ng platformadagi xonadonlar shu ro'yxat bilan
 * kesishtiriladi.
 */
const prepareQueue = async (user, run) => {
  await RegistrationRun.updateOne(
    { _id: run._id },
    { $set: { status: "preparing", stage: "Mahalla kadastrlari aniqlanmoqda" } },
  );

  pushRunLog(run._id, {
    level: "info",
    message: `"${run.mahallaName ?? run.mahallaKey}" mahallasi tayyorlanmoqda`,
  });

  // 1. Mahallaga tegishli manzillar -> kadastrlar.
  const addresses = await Citizen.distinct("address");
  const matchedAddresses = addresses.filter((address) => {
    const name = extractMahallaName(address);
    return name ? mahallaKey(name) === run.mahallaKey : false;
  });

  if (!matchedAddresses.length) {
    throw new Error("Bu mahalla umumiy fuqarolar bazasida topilmadi");
  }

  const cadasters = await Citizen.distinct("cadasterNumber", {
    address: { $in: matchedAddresses },
  });
  const cadasterSet = new Set(cadasters.filter(Boolean));

  pushRunLog(run._id, {
    level: "info",
    message: `${matchedAddresses.length} manzil, ${cadasterSet.size} kadastr topildi`,
  });

  // 2. Platformaning ko'chalari.
  await RegistrationRun.updateOne(
    { _id: run._id },
    { $set: { stage: "Ko'chalar yuklanmoqda" } },
  );

  const streets = await fetchStreets(user, run);

  // Ko'chalarni mahalliy nusxaga ham yozib qo'yamiz — boshqa
  // sahifalar shu ro'yxatdan foydalanadi.
  if (streets.length) {
    await Street.bulkWrite(
      streets.map((street) => ({
        updateOne: {
          filter: { userUid: user.uid, streetId: String(street.id) },
          update: { $set: { name: street.name } },
          upsert: true,
        },
      })),
    );
  }

  pushRunLog(run._id, {
    level: "info",
    message: `${streets.length} ko'cha topildi — xonadonlar yuklanmoqda`,
  });

  // 3. Har bir ko'chaning xonadonlari; mahalla kadastrlariga
  //    tegishlilari navbatga olinadi.
  const queue = [];

  for (const [index, street] of streets.entries()) {
    const control = await readControl(run);
    if (control !== "run") return { queued: 0, interrupted: control };

    await RegistrationRun.updateOne(
      { _id: run._id },
      {
        $set: {
          stage: `Ko'chalar: ${index + 1}/${streets.length} — ${street.name}`,
          heartbeatAt: new Date(),
        },
      },
    );

    let homes = [];

    try {
      homes = await fetchStreetHomes(user, String(street.id), run);
    } catch (err) {
      // Bitta ko'cha yuklanmasa, qolganlari davom etadi — butun
      // yurish to'xtamasin.
      pushRunLog(run._id, {
        level: "error",
        message: `"${street.name}" ko'chasi yuklanmadi: ${describeError(err)}`,
      });
      continue;
    }

    const matched = homes.filter(
      (home) => home.cadaster_number && cadasterSet.has(home.cadaster_number),
    );

    for (const home of matched) {
      queue.push({
        runId: run._id,
        queueIndex: queue.length,
        homeId: String(home.id),
        streetId: String(street.id),
        streetName: street.name,
        homeNum: home.home_num,
        cadasterNumber: home.cadaster_number,
        ownerFullName: home.full_name,
        ownerPinfl: home.pinfl != null ? String(home.pinfl) : null,
        status: "pending",
        userUid: user.uid,
      });
    }

    if (matched.length) {
      pushRunLog(run._id, {
        level: "info",
        message: `"${street.name}" — ${matched.length} xonadon navbatga qo'shildi`,
      });
    }
  }

  if (!queue.length) {
    // Eng ko'p uchraydigan sabab: token boshqa MFY ga tegishli.
    // Tashqi API faqat foydalanuvchining o'z hududidagi xonadonlarni
    // qaytaradi, shuning uchun boshqa mahallani tanlash befoyda.
    throw new Error(
      `Bu mahalla xonadonlari tokenga ko'rinmaydi: tashqi API ${streets.length} ko'cha qaytardi, ulardagi xonadonlar orasida mahalla kadastrlari yo'q. Token o'z MFY ingizga tegishli bo'lishi kerak.`,
    );
  }

  await RegistrationHome.insertMany(queue);

  await RegistrationRun.updateOne(
    { _id: run._id },
    { $set: { homesTotal: queue.length, stage: "Navbat tayyor" } },
  );

  pushRunLog(run._id, {
    level: "info",
    message: `Navbat tayyor: ${queue.length} xonadon`,
  });

  return { queued: queue.length, interrupted: null };
};

// ---------------------------------------------------------------
// Yurishni olib borish
// ---------------------------------------------------------------

/**
 * Yurishni boshlaydi yoki davom ettiradi. Chaqiruvchi KUTMAYDI:
 * javob darhol qaytariladi, jarayon fonda davom etadi.
 */
export const runRegistration = async (user, runDoc, token) => {
  const runId = String(runDoc._id);

  if (activeRuns.has(runId)) return;

  // --- Egalik olish (bir nechta server uchun) ---
  //
  // Bitta bazaga bir nechta server ulanishi mumkin. `activeRuns`
  // xotirada bo'lgani uchun ikkinchi server birinchisining
  // ishlayotganini ko'rmaydi — bir xonadonga ikki marta so'rov
  // ketardi.
  //
  // Shuning uchun egalik DB'da ATOMIK tarzda olinadi: shart faqat
  // "egasi yo'q yoki egasi o'zimiz yoki eski egasining belgisi
  // eskirgan" bo'lsa bajariladi. Ikki server bir vaqtda urinsa,
  // faqat bittasi yutadi.
  const claimed = await RegistrationRun.findOneAndUpdate(
    {
      _id: runDoc._id,
      $or: [
        { ownerId: null },
        { ownerId: { $exists: false } },
        { ownerId: SERVER_ID },
        // Egasi javob bermay qolgan (o'chib qolgan server).
        { heartbeatAt: { $lt: new Date(Date.now() - OWNER_TIMEOUT_MS) } },
      ],
    },
    { $set: { ownerId: SERVER_ID, ownerName: SERVER_NAME, heartbeatAt: new Date() } },
    { returnDocument: "after" },
  );

  if (!claimed) {
    // Boshqa server ishlayapti — aralashmaymiz.
    console.log(
      `[Ro'yxatga olish] "${runDoc.mahallaName}" boshqa serverda ketmoqda, o'tkazib yuborildi`,
    );
    return;
  }

  activeRuns.add(runId);

  // Ishchi O'Z so'rov kontekstida ishlaydi — ya'ni o'z tokeni bilan.
  //
  // Nega kerak: har MFY ning alohida tokeni bor va tashqi API faqat
  // o'sha token egasining hududini ko'rsatadi. Bir nechta MFY
  // parallel ishlaganda har biri o'z tokenini ishlatishi shart,
  // aks holda ikkinchisi birinchisining hududini so'rab qolardi.
  //
  // Kontekst fon vazifasiga meros bo'lib o'tadi, lekin unga
  // tayanmaymiz: bu yerda ataylab yangi kontekst ochiladi, shunda
  // yurish server qayta ishga tushgandan keyin ham (saqlangan token
  // bilan) davom eta oladi.
  return requestContext.run({ token, user }, () => runWorker(user, runDoc));
};

const runWorker = async (user, runDoc) => {
  const runId = String(runDoc._id);
  const run = runDoc;

  try {
    // Navbat hali tuzilmagan bo'lsa — tuzamiz. Tuzilgan bo'lsa
    // (davom ettirish holati) to'g'ridan-to'g'ri ishlashga o'tamiz.
    const queued = await RegistrationHome.countDocuments({ runId: run._id });

    if (!queued) {
      const { interrupted } = await prepareQueue(user, run);

      if (interrupted) {
        await RegistrationRun.updateOne(
          { _id: run._id },
          {
            $set: {
              status: interrupted === "pause" ? "paused" : "stopped",
              stage: "Tayyorlash to'xtatildi",
              waitingUntil: null,
              finishedAt: interrupted === "stop" ? new Date() : null,
            },
          },
        );
        return;
      }
    }

    await RegistrationRun.updateOne(
      { _id: run._id },
      {
        $set: {
          status: "running",
          error: null,
          heartbeatAt: new Date(),
        },
      },
    );

    // Yurish birinchi marta boshlanayotgan bo'lsa, boshlangan
    // vaqtni belgilaymiz (davom ettirishda tegmaymiz).
    if (!run.startedAt) {
      await RegistrationRun.updateOne(
        { _id: run._id },
        { $set: { startedAt: new Date() } },
      );
    }

    const total = await RegistrationHome.countDocuments({ runId: run._id });

    // Platformada allaqachon "band" bo'lgan JSHSHIR'lar. Bir odam
    // faqat bitta xonadonda bo'lishi mumkin, bazada esa u bir
    // nechta kadastrda uchraydi. Shuning uchun band ro'yxat yurish
    // boshida to'ldiriladi va davomida o'sib boradi.
    const takenPinfls = new Set();

    // 1. Mahalliy nusxadagi xonadon egalari va a'zolari.
    for (const pinfl of await Home.distinct("pinfl", { userUid: user.uid })) {
      if (pinfl) takenPinfls.add(String(pinfl));
    }
    for (const pinfl of await FamilyMember.distinct("pinfl", {
      userUid: user.uid,
    })) {
      if (pinfl) takenPinfls.add(String(pinfl));
    }

    // 2. Oldingi yurishlarda qo'shilgan yoki "boshqa xonadonda
    //    ro'yxatda" deb rad etilgan odamlar — qayta urinishning
    //    ma'nosi yo'q.
    //
    //    Manbadagi (`pinfl`) va davlat bazasi tasdiqlagan
    //    (`verifiedPinfl`) JSHSHIR — IKKALASI ham olinadi. Tekshiruv
    //    ikki joyda ketadi: so'rovdan oldin manbadagisi bo'yicha
    //    (so'rovni tejaydi), so'rovdan keyin tasdiqlangani bo'yicha
    //    (JSHSHIR almashtirilgan holatni ushlaydi). Faqat bittasini
    //    saqlasak, birinchisi ishlamay qolardi.
    const occupied = [
      { userUid: user.uid, status: { $in: ["added", "exists"] } },
      {
        userUid: user.uid,
        reasonCode: { $in: ["boshqa_xonadon_egasi", "boshqa_xonadon_azosi"] },
      },
    ];

    for (const filter of occupied) {
      for (const field of ["pinfl", "verifiedPinfl"]) {
        for (const pinfl of await RegistrationMember.distinct(field, filter)) {
          if (pinfl) takenPinfls.add(String(pinfl));
        }
      }
    }

    // Holati hech qachon o'zgarmaydigan sabablar — vafot etgan,
    // hujjati yaroqsiz. Bular "ro'yxatda bor" degani EMAS, shuning
    // uchun alohida saqlanadi: sababi ham o'zi bilan yuradi, keyingi
    // uchrashuvda o'sha sabab yoziladi. Diqqat: bunday yozuvda
    // `verifiedPinfl` bo'lmaydi (GCP ma'lumot qaytarmagan), shuning
    // uchun manba `pinfl` dan olinadi.
    const hopelessPinfls = new Map();

    // Guvohnoma -> JSHSHIR keshi. Bazadagi yozuvlarning ~14% ida
    // JSHSHIR yo'q (bolalar) — ularniki faqat FHDYO javobidan
    // ma'lum bo'ladi. Bir marta bilib olingach, qayta so'ramaymiz.
    const certPinfls = new Map();

    for (const row of await RegistrationMember.find(
      {
        userUid: user.uid,
        pinfl: { $in: [null, ""] },
        verifiedPinfl: { $nin: [null, ""] },
      },
      "document birthDate verifiedPinfl",
    ).lean()) {
      const key = certCacheKey(row);
      if (key) certPinfls.set(key, String(row.verifiedPinfl));
    }

    for (const row of await RegistrationMember.find(
      {
        userUid: user.uid,
        reasonCode: { $in: ["vafot_etgan", "hujjat_yaroqsiz"] },
        pinfl: { $nin: [null, ""] },
      },
      "pinfl reason",
    ).lean()) {
      hopelessPinfls.set(String(row.pinfl), row.reason);
    }

    pushRunLog(run._id, {
      level: "info",
      message: `${takenPinfls.size} JSHSHIR allaqachon ro'yxatda, ${hopelessPinfls.size} tasi o'zgarmas sabab bilan chetda, ${certPinfls.size} guvohnoma keshlangan — ularga so'rov yuborilmaydi`,
    });

    // --- Asosiy sikl: navbatdagi xonadonlar ---
    while (true) {
      const control = await readControl(run);

      if (control !== "run") {
        const status = control === "pause" ? "paused" : "stopped";

        await RegistrationRun.updateOne(
          { _id: run._id },
          {
            $set: {
              status,
              stage: control === "pause" ? "To'xtatib turildi" : "To'xtatildi",
              waitingUntil: null,
              finishedAt: control === "stop" ? new Date() : null,
            },
          },
        );

        pushRunLog(run._id, {
          level: "info",
          message:
            control === "pause"
              ? "Jarayon to'xtatib turildi"
              : "Jarayon to'xtatildi",
        });

        return;
      }

      // Navbatdagi keyingi xonadon. "processing" holatida qolgan
      // yozuvni ham olamiz: server kutilmaganda o'chgan bo'lsa,
      // o'sha xonadon yarim qolgan bo'ladi.
      const homeRow = await RegistrationHome.findOne({
        runId: run._id,
        status: { $in: ["pending", "processing"] },
      }).sort({ queueIndex: 1 });

      if (!homeRow) break;

      await RegistrationRun.updateOne(
        { _id: run._id },
        {
          $set: {
            stage: `Xonadon ${homeRow.queueIndex + 1}/${total} — ${homeRow.cadasterNumber ?? homeRow.homeId}`,
            heartbeatAt: new Date(),
          },
        },
      );

      await processHome(
        user,
        run,
        homeRow,
        takenPinfls,
        hopelessPinfls,
        certPinfls,
      );

      // Hisoblagichlarni $inc bilan emas, HAQIQIY yozuvlardan qayta
      // hisoblaymiz. Sababi: xonadon qayta ishlanishi mumkin (server
      // o'chib qolgan bo'lsa), $inc esa bunda ikki marta qo'shib
      // yuborardi va sonlar haqiqatdan uzoqlashardi.
      await recountRun(run._id);
    }

    await RegistrationRun.updateOne(
      { _id: run._id },
      {
        $set: {
          status: "done",
          stage: "Tugadi",
          waitingUntil: null,
          finishedAt: new Date(),
        },
      },
    );

    const final = await RegistrationRun.findById(run._id).lean();

    pushRunLog(run._id, {
      level: "info",
      message: `Yurish tugadi — ${final?.membersAdded ?? 0} odam qo'shildi, ${final?.membersFailed ?? 0} xato, ${final?.membersSkipped ?? 0} o'tkazildi`,
    });

    console.log(
      `[Ro'yxatga olish] "${run.mahallaName}" tugadi: ${final?.membersAdded ?? 0} qo'shildi`,
    );
  } catch (err) {
    console.error("[Ro'yxatga olish] jarayon to'xtadi:", err);

    await RegistrationRun.updateOne(
      { _id: run._id },
      {
        $set: {
          status: "error",
          error: err.message || "Noma'lum xatolik",
          stage: "Xatolik",
          waitingUntil: null,
          finishedAt: new Date(),
        },
      },
    );

    pushRunLog(run._id, {
      level: "error",
      message: `Jarayon to'xtadi: ${err.message}`,
    });
  } finally {
    activeRuns.delete(runId);

    // Egalikni bo'shatamiz — boshqa server davom ettira olsin.
    await RegistrationRun.updateOne(
      { _id: run._id, ownerId: SERVER_ID },
      { $set: { ownerId: null, ownerName: null } },
    ).catch(() => {});
  }
};
