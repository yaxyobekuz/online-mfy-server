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
import MfyToken from "../models/MfyToken.js";
import UncadastredCitizen from "../models/UncadastredCitizen.js";
import UncadastredGroup from "../models/UncadastredGroup.js";
import User from "../models/User.js";
import { withRateLimit } from "../utils/rate-limit.js";
import { requestContext } from "../utils/request-context.js";
import {
  extractMahallaName,
  mahallaKey,
  sameMahalla,
} from "../utils/mahalla.js";
import { cadasterKey } from "../utils/cadaster.js";
import { surnameKey, fullNameSurnameKey } from "../utils/surname.js";
import { randomUzPhone, normalizePhone } from "../utils/phone.js";
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
  PERMANENT_REASON_CODES,
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

// Platforma tokeni yaroqsiz yoki muddati o'tgan — HTTP 401. Bu bitta
// fuqaroning emas, BUTUN yurishning muammosi: token eskirgach qolgan
// barcha so'rovlar ham 401 beradi. Shuning uchun uni alohida ushlab,
// yurishni "pauza" qilamiz (har bir fuqaroni "xato" deb belgilash
// o'rniga) — foydalanuvchi tokenni yangilab, davom ettiradi.
const isAuthError = (err) => err?.response?.status === 401;

class TokenExpiredError extends Error {
  constructor(message = "Platforma tokeni eskirgan — yangilang va davom eting") {
    super(message);
    this.name = "TokenExpiredError";
  }
}

// Token eskirsa yurishni "pauza" holatiga o'tkazadi (xato emas): panel
// uni "To'xtatib turildi" ko'rinishida ko'rsatadi, foydalanuvchi tokenni
// yangilab, "Davom ettirish" bosadi. Shu bilan token eskirgan paytdagi
// minglab fuqaro bekorga "xato" bo'lib qolmaydi.
/**
 * Bitta "Boshlash" davomida nechta odam kiritilgani va chegara.
 *
 * Hisob yurish umri bo'yicha EMAS, shu sessiya bo'yicha ketadi:
 * tugma bosilganda chegaracha kiritiladi va to'xtaydi, yana bosilsa
 * yana shuncha. Aks holda allaqachon 1255 odam kiritilgan yurishda
 * 50 lik chegara darhol ishga tushib, hech narsa qilinmasdi.
 */
const readLimit = async (userUid) => {
  const settings = await User.findOne({ uid: userUid })
    .select("autoStopAfter")
    .lean()
    .catch(() => null);

  return Number(settings?.autoStopAfter) || 0;
};

const newSession = async (userUid) => ({
  userUid,
  added: 0,
  limit: await readLimit(userUid),
  readAt: Date.now(),
});

// Chegara jarayon KETAYOTGANDA ham o'zgartirilishi mumkin: xodim
// sozlamani ochib, raqam yozib, saqlaydi. Boshida bir marta o'qisak,
// u o'zgarish faqat KEYINGI "Boshlash" da ishga tushardi — xodim esa
// chegara umuman ishlamayapti deb o'ylardi. Shuning uchun qiymat
// boshqaruv tugmasi kabi vaqti-vaqti bilan qayta o'qiladi.
const LIMIT_CACHE_MS = 10000;

const refreshLimit = async (session) => {
  if (!session) return;
  if (Date.now() - session.readAt < LIMIT_CACHE_MS) return;

  session.limit = await readLimit(session.userUid);
  session.readAt = Date.now();
};

const reachedLimit = async (session) => {
  if (!session) return false;

  await refreshLimit(session);
  return session.limit > 0 && session.added >= session.limit;
};

// Chegara tufayli to'xtatilgan yurish — bu xato emas, rejalashtirilgan
// to'xtash. Foydalanuvchi "Boshlash" bilan davom ettiradi.
const stopRunAtLimit = async (run, session) => {
  await RegistrationRun.updateOne(
    { _id: run._id },
    {
      $set: {
        status: "stopped",
        control: "stop",
        stage: `Chegaraga yetildi — ${session.added} ta kiritildi`,
        waitingUntil: null,
        finishedAt: new Date(),
      },
    },
  );

  pushRunLog(run._id, {
    level: "info",
    message:
      `Sozlamadagi chegara (${session.limit} ta) bajarildi — jarayon ` +
      `avtomatik to'xtatildi. Davom ettirish uchun "Boshlash" bosing.`,
  });

  console.log(
    `[Ro'yxatga olish] "${run.mahallaName}" chegaraga yetdi: ${session.added}/${session.limit}`,
  );
};

const pauseRunForExpiredToken = async (run) => {
  await RegistrationRun.updateOne(
    { _id: run._id },
    {
      $set: {
        status: "paused",
        stage: "Token eskirgan — yangilang va davom eting",
        waitingUntil: null,
      },
    },
  );

  // Tokenni shu yerda ham belgilab qo'yamiz: aynan shu nuqtada uning
  // o'lgani ANIQ. Interceptorga tayanib qolmaymiz — u faqat so'rov
  // konteksti to'g'ri bo'lsa ishlaydi, bu esa panel xodimga token
  // yangilash kerakligini ko'rsatadigan yagona belgi.
  if (run.userUid) {
    await MfyToken.updateOne(
      { uid: run.userUid },
      { $set: { status: "expired", lastCheckedAt: new Date() } },
    ).catch(() => {});
  }
  pushRunLog(run._id, {
    level: "error",
    message:
      "Platforma tokeni eskirgan. Qolgan fuqarolar xato deb belgilanmadi — " +
      "tokenni yangilab, jarayonni davom ettiring.",
  });
};

// FHDYO/platforma "topilmadi" yoki hujjat formati noto'g'ri bo'lganda
// HTTP 400 (exception) qaytaradi — GCP kabi 200+code emas. Bu tizim
// xatosi EMAS, fuqaro ma'lumotidagi muammo, shuning uchun "xato" emas,
// "o'tkazildi" (skip) deb belgilanishi kerak.
const isDataRejection = (err) => err?.response?.status === 400;

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

/**
 * Xato MongoDB bilan aloqa uzilishimi?
 *
 * Nega kerak: soatlab ketadigan yurish bir lahzalik tarmoq uzilishi
 * tufayli butunlay yo'qolmasligi kerak. Bunday xatoda kutib qayta
 * urinamiz, boshqa xatolarda esa yurish to'xtaydi.
 */
const isMongoNetworkError = (err) => {
  const name = err?.name ?? "";
  const code = err?.code ?? err?.cause?.code ?? "";

  return (
    /MongoNetworkError|MongoNotConnectedError|MongoServerSelectionError|MongoTopologyClosedError/.test(
      name,
    ) || ["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "ECONNREFUSED", "EPIPE"].includes(code)
  );
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

/**
 * Yurishning "taqiqlangan ko'chalar" surati.
 *
 * Sozlamada belgilanmagan ko'chaga HECH QAYSI rejimda fuqaro
 * kiritilmaydi: oddiy (kadastr), kadastrsiz, random va qo'shimcha —
 * hammasi shu ro'yxatga bo'ysunadi. Avval cheklov faqat random
 * rejimda ishlardi va xodim boshqa rejimni ishga tushirganda
 * "номаълум" kabi texnik ko'chalarga ham ma'lumot kirib ketardi.
 *
 * Surat YURISHDA saqlanadi (`randomExcludedStreetIds`), sozlamadan
 * to'g'ridan-to'g'ri o'qilmaydi: ish ketayotganda sozlama
 * o'zgartirilsa, allaqachon ishlangan xonadonlar bilan ziddiyat
 * chiqardi.
 *
 * Eski yurishlarda bu maydon bo'sh bo'lishi mumkin (cheklov hali
 * yo'q edi) — bunday holatda hech narsa taqiqlanmaydi.
 */
const excludedStreetsOf = (run) =>
  new Set((run?.randomExcludedStreetIds ?? []).map((id) => String(id)));

/**
 * Ko'chalar ro'yxatidan taqiqlanganlarini olib tashlaydi va
 * nechtasi chetlab o'tilganini jurnalga yozadi.
 */
const allowedStreets = (streets, excluded, run) => {
  if (!excluded.size) return streets;

  const allowed = streets.filter(
    (street) => !excluded.has(String(street.id)),
  );

  const skipped = streets.length - allowed.length;
  if (skipped) {
    pushRunLog(run._id, {
      level: "info",
      message: `Sozlamaga ko'ra ${skipped} ta ko'cha chetlab o'tildi (${allowed.length} ta ko'cha bilan ishlanadi)`,
    });
  }

  return allowed;
};

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

  // JSHSHIR bor — davlat bazasiga MUROJAAT QILMAYMIZ.
  //
  // Nega: GCP ko'pincha "status_name = aktiv, doc_status = Yaroqsiz
  // hujjat" deb javob beradi — ya'ni odam faol, faqat GCP'dagi
  // hujjat yozuvi eskirgan (yangi pasport olgan, GCP yangilamagan).
  // Avval bunday odam chetga chiqarilardi, lekin qo'lda sinab
  // ko'rilganda platforma ularni MUAMMOSIZ qabul qildi (11/11
  // HTTP 201). Ya'ni platforma hujjat raqamini tekshirmaydi —
  // JSHSHIR, ism va sana yetarli.
  //
  // Natijada: bazadagi ma'lumot to'g'ridan-to'g'ri yuboriladi,
  // so'rovlar soni ikki barobar kamayadi va ~76 kishi bekorga
  // chetda qolmaydi.
  //
  // Diqqat: ism BAZADAGI LOTIN ustunidan olinadi (`fullName`),
  // kirill emas — platforma lotin kutadi.
  if (citizen.pinfl) {
    const { series, number } = documentParts(citizen);

    return {
      verified: {
        fullName: citizen.fullName,
        birthDate: isoBirthDate,
        pinfl: String(citizen.pinfl),
        docSeries: series,
        docNumber: number,
        // Hujjat turi seriyaga qarab: guvohnoma yoki pasport.
        documentType: isBirthCertificate(series)
          ? "Tug'ilganlik guvohnomasi"
          : "Passport",
        via: "baza",
      },
      registryResponse: null,
    };
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
        // Baza "DD.MM.YYYY" qaytarishi mumkin — platforma ISO kutadi.
        birthDate: toIsoDate(person.birth_date) ?? person.birth_date ?? isoBirthDate,
        pinfl: String(person.pinfl),
        docSeries: series,
        docNumber: number,
        documentType: "Passport",
        response: mipData,
      };
    } else {
      // Tug'ilganlik guvohnomasi — FHDYO bazasidan.
      let response;
      try {
        response = await fetchBirthCert(series, number, isoBirthDate, run);
      } catch (err) {
        // FHDYO guvohnomani topa olmaganda yoki raqam/seriya formati
        // noto'g'ri bo'lganda HTTP 400 (exception) qaytaradi — GCP kabi
        // 200+xabar emas. Shu sababli bu "topilmadi" hech qachon yumshoq
        // skip yo'liga yetib bormay, har bir bola "xato" bo'lib qolardi.
        // 400 ni fuqaro ma'lumotidagi kamchilik deb, "o'tkazildi" qilamiz.
        // 401 (token) va 429 (rate-limit) bu yerga kelmaydi: ular
        // yuqorida boshqariladi.
        if (isDataRejection(err)) {
          const reason = describeError(err) || "Guvohnoma bo'yicha ma'lumot topilmadi";
          return { skip: reason, registryResponse: err.response?.data ?? null };
        }
        throw err;
      }
      const person = extractBirthCertPerson(response);

      if (!person) {
        return {
          skip: response?.message || "Guvohnoma bo'yicha ma'lumot topilmadi",
          registryResponse: response,
        };
      }

      cert = {
        fullName: joinName(person.surname, person.name, person.patronym),
        // FHDYO sanani "DD.MM.YYYY" ko'rinishida qaytaradi, platforma
        // esa ISO ("YYYY-MM-DD") kutadi. Aylantirmasdan yuborilsa
        // platforma sababini aytmay 500 qaytaradi — aynan shu sabab
        // guvohnomali bolalar ommaviy ravishda "Tashqi server xatosi"
        // bo'lib qolardi.
        birthDate: toIsoDate(person.birth_date) ?? isoBirthDate,
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

  // 2-bosqich: JSHSHIR shu yerda FHDYO yoki MIP javobidan topilgan
  // (manbada yo'q edi). Ularning ikkisi ham RASMIY baza, ya'ni ism
  // va sana allaqachon tasdiqlangan — GCP'ga qayta murojaat qilish
  // shart emas.
  //
  // Guvohnoma topilgan bo'lsa — o'shani ishlatamiz.
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

  // Pasport bazasidan (MIP) topilgan bo'lsa — o'shani.
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

  // Bu yergacha yetib kelish kutilmaydi (JSHSHIR qayerdandir
  // topilgan bo'lishi kerak), lekin ehtiyot uchun GCP qoladi.
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
        // Platforma ISO (YYYY-MM-DD) formatni kutadi. GCP ba'zan
        // "DD.MM.YYYY" beradi, shuning uchun aylantiramiz.
        birthDate: toIsoDate(person.birth_date) ?? person.birth_date ?? isoBirthDate,
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
    // Token eskirgan (401) — bu fuqaroning emas, butun yurishning
    // muammosi. Uni "xato" deb belgilamay, yuqoriga uzatamiz: yurish
    // pauza qilinadi. Yarim qolgan "pending" yozuvni o'chiramiz, aks
    // holda u statistikada osilib qoladi (davom ettirilganda qayta
    // yaratiladi).
    if (isAuthError(err)) {
      await RegistrationMember.deleteOne({ _id: member._id });
      throw new TokenExpiredError();
    }

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
        if (isAuthError(retryErr)) {
          await RegistrationMember.deleteOne({ _id: member._id });
          throw new TokenExpiredError();
        }

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

    // Javobi hech qachon o'zgarmaydigan sabablar (vafot etgan,
    // hujjati yaroqsiz, bazadan topilmadi...). Bir odam bazada bir
    // nechta kadastrda uchraydi, random rejimda esa tasodifiy
    // tanlov uni qayta chiqarishi mumkin — har safar davlat
    // bazasidan qayta so'rash bekorga rate-limit sarflaydi.
    // Shuning uchun band deb belgilaymiz.
    if (PERMANENT_REASON_CODES.includes(skipCode) && citizen.pinfl) {
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
    // Oxirgi himoya: qaysi bazadan kelganidan qat'i nazar sana ISO
    // bo'lib ketsin. Platforma "DD.MM.YYYY" ni qabul qilmaydi va
    // sababini aytmay 500 qaytaradi.
    birth_date: toIsoDate(verified.birthDate) ?? verified.birthDate,
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

    // Rad etish sababi ma'lumotning o'zidagi nuqsondan bo'lsa
    // (masalan hujjat raqami platforma talabiga mos emas), qayta
    // yuborish ham xuddi shu javobni oladi. Bunday odamni band deb
    // belgilaymiz — keyingi uchrashuvda davlat bazasiga so'rov ham
    // ketmaydi.
    if (PERMANENT_REASON_CODES.includes(reasonCode)) {
      hopelessPinfls.set(String(verified.pinfl), reason);
      if (citizen.pinfl) hopelessPinfls.set(String(citizen.pinfl), reason);
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
  session = null,
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

  // --- Taqiqlangan ko'cha ---
  //
  // Oxirgi himoya: navbat `syncResumeQueue` da tozalanadi, lekin
  // eski yurishlarda (sozlama kiritilishidan oldin tuzilgan navbat)
  // taqiqlangan ko'chadagi xonadon qolib ketgan bo'lishi mumkin.
  // Bu yerda tekshirish arzon va ishonchli: tashqi API ga so'rov
  // yuborilgunga QADAR to'xtatiladi.
  if (excludedStreetsOf(run).has(String(homeRow.streetId))) {
    const reason = "Ko'cha sozlamalarda taqiqlangan";
    await finishHome({ status: "skipped", reason });

    pushRunLog(run._id, {
      level: "skip",
      message: `${homeRow.streetName ?? homeRow.streetId} — ${reason}`,
    });

    return { homeStatus: "skipped", ...empty };
  }

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
      // Token eskirgan (401) — bu XONADONNING emas, butun yurishning
      // muammosi. Uni "xato" deb belgilasak, xonadon abadiy
      // o'tkazib yuborilardi (navbat faqat pending/processing ni
      // oladi) va undagi odamlar hech qachon urinilmasdan
      // "platformada bor" bo'lib ko'rinardi. Shuning uchun yuqoriga
      // uzatamiz: yurish pauza qilinadi, xonadon `processing` da
      // qoladi va token yangilangach qaytadan ishlanadi.
      if (isAuthError(err)) throw new TokenExpiredError();

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
    // Yuqoridagi bilan bir xil sabab: 401 xonadonning aybi emas.
    if (isAuthError(err)) throw new TokenExpiredError();

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

  // Kadastr bir xil xonadon uchun ham turlicha yozilgan bo'lishi
  // mumkin (platformada "17030102060377", Excel'da
  // "17:03:01:02:06:0377"). Shuning uchun avval AYNAN qidiramiz —
  // bu indeksdan foydalanadi va aksariyat holatda yetarli; topilmasa
  // raqamga tozalangan ko'rinishi bo'yicha qaraymiz.
  let citizens = await Citizen.find({
    cadasterNumber: homeRow.cadasterNumber,
  })
    .sort({ birthDate: 1, rowNumber: 1 })
    .lean();

  if (!citizens.length) {
    const variants = await cadasterVariants(homeRow.cadasterNumber);

    if (variants.length) {
      citizens = await Citizen.find({ cadasterNumber: { $in: variants } })
        .sort({ birthDate: 1, rowNumber: 1 })
        .lean();
    }
  }

  // Allaqachon ro'yxatda turganlarga so'rov yubormaymiz — rate-limit
  // bekorga sarflanmasligi uchun.
  const candidates = citizens.filter(
    (citizen) => !citizen.pinfl || !knownPinfls.has(String(citizen.pinfl)),
  );

  pushRunLog(run._id, {
    level: "info",
    message: `Platformada ${existing.length} a'zo, bazada ${citizens.length} fuqaro — kiritiladi ${candidates.length} ta`,
  });

  // --- Platformada avvaldan turganlarni YOZIB qo'yamiz ---
  //
  // Allaqachon ro'yxatda turgan odamga so'rov yuborilmaydi (yuqorida
  // nomzodlardan chiqarib tashlandi). Avval ularga umuman yozuv
  // yaratilmasdi — natijada ular jonli kuzatuvda ko'rinmasdi va
  // statistikada faqat AYIRMA orqali "Platformada mavjud" bo'lib
  // qolardi: o'lchanmaydigan, auditga yopiq son. Endi har biriga
  // `exists` yozuvi yaratamiz — son haqiqiy kuzatuvga tayanadi,
  // ro'yxatda nomma-nom va jonli kuzatuvda ko'rinadi.
  //
  // FAQAT shu xonadonda platformada haqiqatan turganlar (a'zo yoki
  // egasi) yoziladi. Yurish davomida boshqa sabab bilan "band" bo'lib
  // qolganlar (boshqa xonadonda qo'shilgan/rad etilgan) bu yerda
  // yozilmaydi: ularning yakuniy yozuvi o'sha xonadonda allaqachon
  // bor, bu yerda `exists` qo'shsak natijasini buzib yuborardik.
  const platformPinfls = new Set();
  for (const person of existing) {
    if (person.pinfl) platformPinfls.add(String(person.pinfl));
  }
  if (homeRow.ownerPinfl) platformPinfls.add(String(homeRow.ownerPinfl));

  // Shu xonadonga bu yurishda allaqachon yozilgan JSHSHIR'lar —
  // takror yozuv yaratmaslik uchun (xonadon qayta ishlangan bo'lishi
  // mumkin, `alreadyTried` yuqorida added/exists yozuvlaridan to'ldi).
  const recordedPinfls = new Set();
  for (const attempt of alreadyTried) {
    for (const p of [attempt.pinfl, attempt.verifiedPinfl]) {
      if (p) recordedPinfls.add(String(p));
    }
  }

  const existsRows = [];
  for (const citizen of citizens) {
    if (!citizen.pinfl) continue;
    const key = String(citizen.pinfl);
    if (!platformPinfls.has(key) || recordedPinfls.has(key)) continue;
    // Shu yurishda bir odam bir necha bor chiqmasin.
    recordedPinfls.add(key);

    existsRows.push({
      runId: run._id,
      homeRowId: homeRow._id,
      cadasterNumber: homeRow.cadasterNumber,
      homeId: homeRow.homeId,
      citizenId: citizen._id,
      fullName: citizen.fullName,
      birthDate: citizen.birthDate,
      document: citizen.document,
      pinfl: key,
      status: "exists",
      reason: "Platformada allaqachon ro'yxatda (shu xonadonda)",
      reasonCode: "allaqachon_mavjud",
      durationMs: 0,
      attemptedAt: new Date(),
      userUid: user.uid,
    });
  }

  if (existsRows.length) {
    // ordered:false — bitta takror (noyob indeks) butun partiyani
    // to'xtatib qo'ymasin.
    await RegistrationMember.insertMany(existsRows, { ordered: false }).catch(
      (err) => {
        pushRunLog(run._id, {
          level: "warn",
          message: `Avvaldan turganlarni yozishda xatolik: ${err.message}`,
        });
      },
    );

    for (const row of existsRows) {
      pushRunLog(run._id, {
        level: "skip",
        fullName: row.fullName,
        message: "Platformada allaqachon ro'yxatda",
      });
    }
  }

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
  let interrupted = null;

  for (const citizen of candidates) {
    // To'xtatish/pauza tugmasi a'zolar oralig'ida ham sezilsin —
    // bitta xonadon 20 ta so'rov bo'lishi mumkin, oxirigacha
    // kutmaymiz. Keshlangani uchun bu arzon.
    const control = await readControlCached(run);
    if (control !== "run") {
      interrupted = control;
      break;
    }

    // Sozlamadagi chegaraga yetdikmi? Tekshiruv aynan SHU YERDA —
    // odamlar oralig'ida — turibdi: xonadon tugashini kutsak, chegara
    // oshib ketardi (bitta xonadonda 20 tagacha odam bo'lishi mumkin).
    // To'xtash "To'xtatish" tugmasi bilan bir xil yo'ldan ketadi:
    // xonadon `pending` ga qaytadi va davom ettirilganda qolgan
    // odamlar qayta ishlanadi.
    if (await reachedLimit(session)) {
      interrupted = "limit";
      break;
    }

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

    if (result === "added") {
      added += 1;
      // Chegara FAQAT muvaffaqiyatli kiritishlarni sanaydi: rad
      // etilganlar platformaga hech narsa qo'shmaydi, ularni sanash
      // chegarani bekorga yeb qo'yardi.
      if (session) session.added += 1;
    } else if (result === "failed") failed += 1;
    else skipped += 1;

    // Har odamdan keyin hisoblagich yangilanadi — client jonli
    // ko'rib turadi. Qayta hisoblash manbadan ketadi, shuning uchun
    // xonadon qayta ishlangan bo'lsa ham son to'g'ri qoladi.
    await recountRun(run._id);
  }

  // To'xtatildi: xonadon TUGALLANMAGAN. Uni `pending` ga qaytaramiz,
  // shunda davom ettirilganda qayta ishlanadi (allaqachon
  // qo'shilganlar `takenPinfls` orqali o'tkazib yuboriladi).
  if (interrupted) {
    await RegistrationHome.updateOne(
      { _id: homeRow._id },
      { $set: { status: "pending" }, $unset: { startedAt: "" } },
    );
    return { homeStatus: "pending", added, failed, skipped, interrupted };
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
/**
 * Kadastrning fuqarolar bazasidagi BOSHQACHA yozilgan ko'rinishlari.
 *
 * Aynan moslik topilmaganda ishlatiladi: butun bazadagi unikal
 * kadastrlar bir marta o'qilib, raqam bo'yicha indekslanadi. Keshsiz
 * har xonadon uchun `distinct` ketardi — minglab xonadonda bu
 * sezilarli yuk.
 *
 * Kesh jarayon umri davomida yashaydi: yurish ketayotganda fuqarolar
 * bazasi o'zgarmaydi (yuklash butun kolleksiyani almashtiradi va
 * undan keyin yurish qaytadan boshlanadi).
 */
let cadasterVariantIndex = null;

/**
 * Fuqarolar bazasi almashtirilganda keshni bo'shatish — aks holda
 * yangi Excel yuklangandan keyin ham eski kadastrlar ishlatilardi.
 */
export const resetCadasterCache = () => {
  cadasterVariantIndex = null;
};

const cadasterVariants = async (value) => {
  const key = cadasterKey(value);
  if (!key) return [];

  if (!cadasterVariantIndex) {
    cadasterVariantIndex = new Map();

    for (const original of await Citizen.distinct("cadasterNumber")) {
      const originalKey = cadasterKey(original);
      if (!originalKey) continue;

      const bucket = cadasterVariantIndex.get(originalKey);
      if (bucket) bucket.push(original);
      else cadasterVariantIndex.set(originalKey, [original]);
    }
  }

  return cadasterVariantIndex.get(key) ?? [];
};

const readControl = async (run) => {
  const fresh = await RegistrationRun.findById(run._id, "control").lean();
  return fresh?.control ?? "stop";
};

// Boshqaruvni TEZ-TEZ o'qish uchun qisqa muddatli kesh.
//
// Nega kerak: "to'xtatish" tugmasi bosilganda ishchi buni darhol
// sezishi kerak. Avval boshqaruv faqat har XONADONDAN oldin
// o'qilardi, bitta xonadon esa (20 tagacha a'zo, har biri tashqi
// so'rov) o'nlab soniya ketardi — tugma bosilgach ham jarayon
// uzoq davom etardi. Endi a'zolar oralig'ida ham tekshiramiz, lekin
// har safar bazaga bormaslik uchun javob ~1.5 soniya keshlanadi.
const CONTROL_CACHE_MS = 1500;
const controlCache = new Map();

const readControlCached = async (run) => {
  const id = String(run._id);
  const cached = controlCache.get(id);

  if (cached && Date.now() - cached.at < CONTROL_CACHE_MS) {
    return cached.value;
  }

  const value = await readControl(run);
  controlCache.set(id, { value, at: Date.now() });
  return value;
};

// Yurish tugaganda keshni tozalaymiz (xotira o'smasin).
const clearControlCache = (runId) => controlCache.delete(String(runId));

/**
 * MFY ning xonadonlarini yuklab, navbatni tuzadi.
 *
 * Platforma xonadonlarni MFY bo'yicha emas, KO'CHA bo'yicha beradi.
 * Shuning uchun avval mahallaga tegishli kadastrlar aniqlanadi
 * ("Hisoblash" natijasi va mahalla nomi — ikkalasi birgalikda),
 * so'ng platformadagi xonadonlar shu ro'yxat bilan kesishtiriladi.
 *
 * Taqqoslash RAQAM bo'yicha ketadi (`cadasterKey`): bir xonadon
 * manbalarda turlicha yoziladi.
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

  // 1. Qaysi kadastrlar bilan ishlaymiz.
  //
  // IKKI MANBA BIRLASHTIRILADI — biri ikkinchisini almashtirmaydi:
  //
  //   a) "Hisoblash" natijasi (`homes`). Platforma tokenga FAQAT
  //      o'z MFY sining xonadonlarini ko'rsatadi, ya'ni o'sha
  //      xonadonlarning kadastri mahallani o'zi belgilaydi. Nom
  //      bu yerda umuman kerak emas — u bir mahallada o'nlab xil
  //      yoziladi ("ПОЛВОНКУЛ", "Полвонкўл", "POLVONKO`L"...) va
  //      aynan shu sabab yangi token uchun ish boshlanmasdi.
  //
  //   b) Mahalla nomi bo'yicha (eski mantiq).
  //
  // Nega ikkalasi ham: `homes` da faqat PLATFORMADA bor xonadonlar
  // turadi, fuqarolar bazasida esa platformaga hali kirmagan
  // kadastrlar ham bo'ladi. Faqat `homes` ga tayansak, eski
  // foydalanuvchilarda navbat qisqarib ketardi (tekshirildi: Ko'l
  // MFY da 675 o'rniga 657 kadastr). Faqat nomga tayansak, yangi
  // token umuman ishlamasdi. Birlashma ikkala holatni ham qoplaydi.
  const cadasterSet = new Set();
  const sources = [];

  const fromHomes = await Home.distinct("cadasterNumber", {
    userUid: run.userUid,
  });

  let homesCount = 0;
  for (const value of fromHomes) {
    const key = cadasterKey(value);
    if (key && !cadasterSet.has(key)) {
      cadasterSet.add(key);
      homesCount += 1;
    }
  }

  if (homesCount) sources.push(`hisoblangan xonadonlar: ${homesCount}`);

  const addresses = await Citizen.distinct("address");
  const matchedAddresses = addresses.filter((address) => {
    const name = extractMahallaName(address);
    return name ? mahallaKey(name) === run.mahallaKey : false;
  });

  if (matchedAddresses.length) {
    let nameCount = 0;

    for (const value of await Citizen.distinct("cadasterNumber", {
      address: { $in: matchedAddresses },
    })) {
      const key = cadasterKey(value);
      if (key && !cadasterSet.has(key)) {
        cadasterSet.add(key);
        nameCount += 1;
      }
    }

    if (nameCount) sources.push(`mahalla nomi: ${nameCount}`);
  }

  if (!cadasterSet.size) {
    throw new Error(
      "Bu mahalla kadastrlari topilmadi — \"Hisoblash\" tugmasini bosib ko'ring",
    );
  }

  pushRunLog(run._id, {
    level: "info",
    message: `${cadasterSet.size} kadastr topildi (${sources.join(", ")})`,
  });

  // 2. Platformaning ko'chalari.
  await RegistrationRun.updateOne(
    { _id: run._id },
    { $set: { stage: "Ko'chalar yuklanmoqda" } },
  );

  const allStreets = await fetchStreets(user, run);

  // Ko'chalarni mahalliy nusxaga ham yozib qo'yamiz — boshqa
  // sahifalar shu ro'yxatdan foydalanadi.
  //
  // Diqqat: bu yerda TAQIQLANGANLARI ham saqlanadi. Mahalliy nusxa
  // "platformada qanday ko'chalar bor" degan savolga javob beradi
  // (sozlamalar oynasi shundan ro'yxat tuzadi), ya'ni unda hamma
  // ko'cha turishi kerak. Taqiqlanganlari pastda, navbat tuzishdan
  // oldin chiqarib tashlanadi.
  if (allStreets.length) {
    await Street.bulkWrite(
      allStreets.map((street) => ({
        updateOne: {
          filter: { userUid: user.uid, streetId: String(street.id) },
          update: { $set: { name: street.name } },
          upsert: true,
        },
      })),
    );
  }

  // Sozlamada belgilanmagan ko'chalar — bu rejimda ham chetlab
  // o'tiladi (avval faqat random rejimda shunday edi).
  const streets = allowedStreets(allStreets, excludedStreetsOf(run), run);

  if (!streets.length) {
    throw new Error(
      allStreets.length
        ? "Ruxsat etilgan ko'cha yo'q — sozlamalarda kamida bitta ko'chani belgilang"
        : "Ko'chalar topilmadi",
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

    const matched = homes.filter((home) => {
      const key = cadasterKey(home.cadaster_number);
      return key ? cadasterSet.has(key) : false;
    });

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

// ---------------------------------------------------------------
// Random rejim — ixtiyoriy fuqarolarni bitta oilaga qo'shish
// ---------------------------------------------------------------

/**
 * Random rejimda MFY dagi fuqarolardan tasodifiy tanlab, bitta
 * xonadonga oila a'zosi sifatida qo'shadi. Maqsad songa yetguncha
 * davom etadi.
 *
 * Farqi oddiy rejimdan:
 *   - Kadastr bo'yicha moslashtirish YO'Q — fuqaro RANDOM tanlanadi
 *   - Bitta xonadon — modal orqali tanlangan yoki birinchi xonadon
 *   - Maqsad soni — "N ta muvaffaqiyatli qo'shish" gacha ishlaydi
 */
const runRandomWorker = async (user, runDoc) => {
  const runId = String(runDoc._id);
  const run = runDoc;

  try {
    const fresh = await RegistrationRun.findById(run._id)
      .select("+token")
      .lean();

    const asked = fresh.randomTarget ?? 0;
    if (asked <= 0) throw new Error("Maqsad soni noto'g'ri");

    // Sozlamadagi chegara random rejimga ham tegishli: modalda
    // so'ralgan maqsad bilan solishtirib, KICHIGI olinadi. Aks holda
    // "100 ta" deb yozilgan chegara random orqali bemalol oshib
    // ketardi.
    const session = await newSession(user.uid);
    const target =
      session.limit > 0 ? Math.min(asked, session.limit) : asked;

    if (target < asked) {
      pushRunLog(run._id, {
        level: "info",
        message: `Sozlamadagi chegara (${session.limit} ta) tufayli maqsad ${asked} dan ${target} ga tushirildi`,
      });
    }

    const homeId = fresh.randomHomeId;
    const streetId = fresh.randomStreetId;
    const surveyUuid = fresh.randomSurveyUuid;
    const ownerPinfl = fresh.randomOwnerPinfl;

    // Sozlamalarda taqiqlangan ko'chalar surati: keyingi xonadonga
    // o'tishda bu ko'chalardagi xonadonlarga qo'shilmaymiz.
    const excludedStreetIds = excludedStreetsOf(fresh);

    if (!homeId || !streetId || !surveyUuid) {
      throw new Error("Xonadon ma'lumotlari to'liq emas — homeId, streetId yoki surveyUuid yo'q");
    }

    await RegistrationRun.updateOne(
      { _id: run._id },
      {
        $set: {
          status: "running",
          error: null,
          stage: "Random rejim — fuqarolar tanlanmoqda",
          heartbeatAt: new Date(),
          startedAt: run.startedAt ?? new Date(),
        },
      },
    );

    pushRunLog(run._id, {
      level: "info",
      message: `Random rejim boshlandi — maqsad: ${target} ta muvaffaqiyatli qo'shish`,
    });

    // Platformada hozir kim bor — ularni qayta yubormaymiz.
    let existing = [];
    try {
      existing = await fetchFamilyMembers(user, streetId, surveyUuid, run);
    } catch (err) {
      pushRunLog(run._id, {
        level: "error",
        message: `Oila a'zolari yuklanmadi: ${describeError(err)}`,
      });
    }

    const knownPinfls = new Set();
    for (const person of existing) {
      if (person.pinfl) knownPinfls.add(String(person.pinfl));
    }
    if (ownerPinfl) knownPinfls.add(String(ownerPinfl));

    // Oldingi yurishlarda qo'shilgan yoki rad etilgan JSHSHIR'lar.
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
          if (pinfl) knownPinfls.add(String(pinfl));
        }
      }
    }

    const hopelessPinfls = new Map();
    for (const row of await RegistrationMember.find(
      {
        userUid: user.uid,
        reasonCode: { $in: PERMANENT_REASON_CODES },
        pinfl: { $nin: [null, ""] },
      },
      "pinfl reason",
    ).lean()) {
      hopelessPinfls.set(String(row.pinfl), row.reason);
    }

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

    // JSHSHIR'siz o'zgarmas holatlar. Yuqoridagi `hopelessPinfls`
    // faqat JSHSHIR bo'yicha ishlaydi — manbada JSHSHIR bo'lmasa
    // (bazadagi yozuvlarning bir qismi shunday) u odam har yurishda
    // qaytadan davlat bazasiga so'raladi, javob esa o'sha-o'sha.
    // Shuning uchun bunday yozuvlarni Citizen._id bo'yicha ham
    // eslab qolamiz.
    const hopelessCitizenIds = new Set();
    for (const id of await RegistrationMember.distinct("citizenId", {
      userUid: user.uid,
      reasonCode: { $in: PERMANENT_REASON_CODES },
      citizenId: { $ne: null },
    })) {
      hopelessCitizenIds.add(String(id));
    }

    const totalCitizens = await Citizen.countDocuments();
    if (!totalCitizens) throw new Error("Fuqarolar bazasi bo'sh");

    pushRunLog(run._id, {
      level: "info",
      message: `Bazada ${totalCitizens} fuqaro — random tanlash boshlanmoqda`,
    });

    // Hisoblagich NOLDAN emas, oldingi natijadan davom etadi.
    //
    // Nega: yurish uzilib (tarmoq, server qayta ishga tushishi)
    // keyin qayta boshlansa, allaqachon qo'shilganlar yo'qolmasligi
    // kerak edi — aks holda panel 503 o'rniga 35 ko'rsatardi va
    // ishchi maqsaddan ancha oshib ketardi.
    let added = fresh.randomAdded ?? 0;
    let failed = 0;
    let skipped = 0;
    let attempted = 0;
    const triedCitizenIds = new Set();
    let consecutiveMisses = 0;

    // Ketma-ket shuncha urinish behuda ketsa, to'xtaymiz. Qiymat
    // katta: bazadagi fuqarolarning bir qismi allaqachon ro'yxatda
    // yoki JSHSHIRsiz, ya'ni "behuda" urinishlar tabiiy holat.
    const MAX_CONSECUTIVE_MISSES = 300;

    // Bir so'rovda shuncha nomzod olinadi.
    const SAMPLE_SIZE = 50;
    let candidates = [];

    // Virtual homeRow — random rejimda bitta xonadon ishlatiladi.
    // Xonadon to'lib qolsa, `moveToNextHome` uni almashtiradi.
    const homeRow = {
      _id: run._id,
      homeId,
      streetId,
      surveyUuid,
      ownerPinfl,
      cadasterNumber: "random",
    };

    // Platformada bitta xonadonga cheklangan sondagi a'zo kiritiladi
    // ("хонадонга N тадан зиёд оила азоси киритиш мумкин эмас").
    // Amalda N = 20 (ba'zi xonadonlarda 15). Shuning uchun 20 gacha
    // urinamiz: limit pastroq bo'lsa, platforma rad etgan zahoti
    // xonadon to'lgan deb belgilanadi (pastda).
    const HOME_MEMBER_LIMIT = 20;
    let membersInHome = existing.length;

    pushRunLog(run._id, {
      level: "info",
      message: `Xonadonda hozir ${membersInHome} a'zo bor (limit ${HOME_MEMBER_LIMIT})`,
    });

    // Bo'sh joyi bor keyingi xonadonni topadi.
    //
    // Nega kerak: maqsad 30 ta bo'lsa, bitta xonadon yetmaydi —
    // limit 20. Xonadon to'lgach jarayon to'xtab qolmasligi uchun
    // navbatdagi xonadonga o'tamiz.
    const visitedHomeIds = new Set([String(homeId)]);

    const moveToNextHome = async () => {
      const streets = await fetchStreets(user, run);

      for (const street of streets) {
        // Taqiqlangan ko'chani butunlay o'tkazib yuboramiz.
        if (excludedStreetIds.has(String(street.id))) continue;

        const homes = await fetchStreetHomes(user, String(street.id), run);

        for (const home of homes) {
          const nextHomeId = String(home.id);
          if (visitedHomeIds.has(nextHomeId)) continue;
          visitedHomeIds.add(nextHomeId);

          const form = await fetchHomeForm(user, nextHomeId, run);
          if (!form?.survey_uuid) continue;

          const members = await fetchFamilyMembers(
            user,
            String(street.id),
            form.survey_uuid,
            run,
          ).catch(() => []);

          if (members.length >= HOME_MEMBER_LIMIT) continue;

          // Topildi — shu xonadonga o'tamiz.
          homeRow.homeId = nextHomeId;
          homeRow.streetId = String(street.id);
          homeRow.surveyUuid = form.survey_uuid;
          homeRow.ownerPinfl = form.pinfl ? String(form.pinfl) : null;
          membersInHome = members.length;

          for (const person of members) {
            if (person.pinfl) knownPinfls.add(String(person.pinfl));
          }
          if (homeRow.ownerPinfl) knownPinfls.add(homeRow.ownerPinfl);

          await RegistrationRun.updateOne(
            { _id: run._id },
            {
              $set: {
                randomHomeId: homeRow.homeId,
                randomStreetId: homeRow.streetId,
                randomSurveyUuid: homeRow.surveyUuid,
                randomOwnerPinfl: homeRow.ownerPinfl,
              },
            },
          );

          pushRunLog(run._id, {
            level: "info",
            message: `Keyingi xonadonga o'tildi — ${home.home_num ?? nextHomeId}-uy (${members.length} a'zo)`,
          });

          return true;
        }
      }

      return false;
    };

    // Mongo bilan aloqa bir lahzaga uzilsa (ECONNRESET, ETIMEDOUT)
    // soatlab ketgan ish butunlay yo'qolmasligi kerak. Shuning
    // uchun har bir aylanish shu o'ramda ketadi: uzilish bo'lsa
    // kutib, qaytadan urinamiz.
    let dbFailures = 0;
    const MAX_DB_FAILURES = 10;

    while (added < target) {
      try {
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
          message: control === "pause" ? "Jarayon to'xtatib turildi" : "Jarayon to'xtatildi",
        });
        return;
      }

      if (consecutiveMisses >= MAX_CONSECUTIVE_MISSES) {
        pushRunLog(run._id, {
          level: "info",
          message: `Ketma-ket ${MAX_CONSECUTIVE_MISSES} urinish muvaffaqiyatsiz — mos fuqaro qolmagan bo'lishi mumkin`,
        });
        break;
      }

      if (triedCitizenIds.size >= totalCitizens) {
        pushRunLog(run._id, {
          level: "info",
          message: "Barcha fuqarolar urinib ko'rildi",
        });
        break;
      }

      // Random tanlash.
      //
      // Nega `$nin` emas: urinilganlar ro'yxati har qadamda o'sadi va
      // uni butunlay Mongo'ga yuborish 30-maqsadda ham minglab
      // ObjectId degani — so'rov asta-sekin sekinlashadi. Buning
      // o'rniga bir nechta nomzod olib, ulardan hali urinilmaganini
      // tanlaymiz: so'rov hajmi doimiy bo'lib qoladi.
      //
      // Navbat buferi: har bir tanlashda alohida so'rov yubormaslik
      // uchun bir yo'la bir nechtasi olinadi.
      if (!candidates.length) {
        candidates = await Citizen.aggregate([{ $sample: { size: SAMPLE_SIZE } }]);
      }

      const citizen = candidates.pop();

      if (!citizen) {
        pushRunLog(run._id, {
          level: "info",
          message: "Boshqa fuqaro qolmadi",
        });
        break;
      }

      // Bu namunada allaqachon urinilgan bo'lsa — keyingisiga.
      if (triedCitizenIds.has(String(citizen._id))) {
        consecutiveMisses += 1;
        continue;
      }

      triedCitizenIds.add(String(citizen._id));
      attempted += 1;

      // JSHSHIR allaqachon ro'yxatda bo'lsa — o'tkazamiz.
      const sourcePinfl = citizen.pinfl ? String(citizen.pinfl) : null;
      if (sourcePinfl && knownPinfls.has(sourcePinfl)) {
        consecutiveMisses += 1;
        skipped += 1;
        continue;
      }

      // "O'zgarmas" sababli chetda qolgan bo'lsa — o'tkazamiz.
      if (sourcePinfl && hopelessPinfls.has(sourcePinfl)) {
        consecutiveMisses += 1;
        skipped += 1;
        continue;
      }

      // JSHSHIR'i yo'q, lekin shu yozuv oldin ham o'zgarmas sabab
      // bilan chetda qolgan — qayta so'rash bekorga ketadi.
      if (hopelessCitizenIds.has(String(citizen._id))) {
        consecutiveMisses += 1;
        skipped += 1;
        continue;
      }

      // Xonadon to'lgan bo'lsa — keyingisiga o'tamiz. Aks holda
      // platforma har bir so'rovni "20 tadan ziyod" deb rad etadi
      // va rate-limit bekorga sarflanadi.
      if (membersInHome >= HOME_MEMBER_LIMIT) {
        pushRunLog(run._id, {
          level: "info",
          message: `Xonadon to'ldi (${membersInHome}/${HOME_MEMBER_LIMIT}) — keyingisi qidirilmoqda`,
        });

        const moved = await moveToNextHome();

        if (!moved) {
          pushRunLog(run._id, {
            level: "info",
            message: "Bo'sh joyi bor xonadon topilmadi — jarayon tugadi",
          });
          break;
        }

        // Xonadon almashdi: shu fuqaroni keyingi aylanishda qayta
        // ko'rib chiqamiz.
        triedCitizenIds.delete(String(citizen._id));
        continue;
      }

      await RegistrationRun.updateOne(
        { _id: run._id },
        {
          $set: {
            stage: `Random: ${added}/${target} kiritildi (${attempted} urinish)`,
            heartbeatAt: new Date(),
          },
        },
      );

      const result = await registerOneMember(
        user,
        run,
        homeRow,
        citizen,
        knownPinfls,
        knownPinfls,
        hopelessPinfls,
        certPinfls,
      );

      if (result === "added") {
        added += 1;
        membersInHome += 1;
        consecutiveMisses = 0;

        await RegistrationRun.updateOne(
          { _id: run._id },
          {
            $set: {
              randomAdded: added,
              membersAdded: added,
              membersTotal: attempted,
              heartbeatAt: new Date(),
            },
          },
        );
      } else if (result === "failed") {
        failed += 1;
        consecutiveMisses += 1;

        // Platforma "20 tadan ziyod" desa — bizning hisobimiz
        // noto'g'ri bo'lgan (xonadonda biz ko'rmagan a'zolar bor).
        // Darhol to'lgan deb belgilaymiz, keyingi aylanishda
        // xonadon almashadi.
        const last = await RegistrationMember.findOne(
          { runId: run._id, citizenId: citizen._id },
          "reason reasonCode",
        )
          .sort({ createdAt: -1 })
          .lean();

        // Javobi o'zgarmaydigan rad etish — shu yozuvni boshqa
        // tanlamaymiz (JSHSHIR'i yo'q bo'lsa ham ishlaydi).
        if (PERMANENT_REASON_CODES.includes(last?.reasonCode)) {
          hopelessCitizenIds.add(String(citizen._id));
        }

        // Diqqat: limit har doim 20 emas. Platforma xonadon turiga
        // qarab boshqa son ham aytadi ("15 тадан зиёд"). Shuning
        // uchun aniq songa emas, XABARNING O'ZIGA qaraymiz.
        if (/зиёд оила азоси|ziyod oila a[’'`]?zosi/i.test(last?.reason ?? "")) {
          membersInHome = HOME_MEMBER_LIMIT;
          // Bu fuqaroning aybi yo'q — keyingi xonadonda qayta
          // urinib ko'rilsin.
          triedCitizenIds.delete(String(citizen._id));
        }
      } else {
        skipped += 1;
        consecutiveMisses += 1;

        // "skipped" ham o'zgarmas sabab bo'lishi mumkin (vafot
        // etgan, bazadan topilmadi). `hopelessPinfls` ni
        // `registerOneMember` ning o'zi to'ldiradi, lekin u faqat
        // JSHSHIR bo'yicha. JSHSHIR'siz yozuv ham qayta
        // tanlanmasligi uchun Citizen._id ni eslab qolamiz.
        const lastSkip = await RegistrationMember.findOne(
          { runId: run._id, citizenId: citizen._id },
          "reasonCode",
        )
          .sort({ createdAt: -1 })
          .lean();

        if (PERMANENT_REASON_CODES.includes(lastSkip?.reasonCode)) {
          hopelessCitizenIds.add(String(citizen._id));
        }
      }

        dbFailures = 0;
      } catch (err) {
        // Faqat BAZA uzilishi qayta urinishga arziydi. Boshqa
        // xatolar yuqoriga chiqadi va yurish "error" bo'ladi.
        if (!isMongoNetworkError(err)) throw err;

        dbFailures += 1;

        if (dbFailures >= MAX_DB_FAILURES) {
          throw new Error(
            `Baza bilan aloqa ${MAX_DB_FAILURES} marta uzildi: ${err.message}`,
          );
        }

        pushRunLog(run._id, {
          level: "wait",
          message: `Baza bilan aloqa uzildi (${dbFailures}/${MAX_DB_FAILURES}) — 10 soniyadan keyin qayta urinamiz`,
        });

        await pause(10000);
      }
    }

    await RegistrationRun.updateOne(
      { _id: run._id },
      {
        $set: {
          status: "done",
          stage: `Tugadi — ${added}/${target}`,
          randomAdded: added,
          membersAdded: added,
          membersFailed: failed,
          membersSkipped: skipped,
          membersTotal: attempted,
          waitingUntil: null,
          finishedAt: new Date(),
        },
      },
    );

    pushRunLog(run._id, {
      level: "info",
      message: `Random rejim tugadi — ${added}/${target} muvaffaqiyatli, ${failed} xato, ${skipped} o'tkazildi (${attempted} urinish)`,
    });
  } catch (err) {
    // Token eskirgan — xato emas, pauza (yangilab davom ettiriladi).
    if (err instanceof TokenExpiredError) {
      await pauseRunForExpiredToken(run);
      return;
    }

    console.error("[Random ro'yxatga olish] xatolik:", err);

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
      message: `Random rejim to'xtadi: ${err.message}`,
    });
  } finally {
    activeRuns.delete(runId);
    clearControlCache(runId);
    await RegistrationRun.updateOne(
      { _id: run._id, ownerId: SERVER_ID },
      { $set: { ownerId: null, ownerName: null } },
    ).catch(() => {});
  }
};

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
  const worker = runDoc.uncadastredMode
    ? runUncadastredWorker
    : runDoc.extraMode
      ? runExtraWorker
      : runDoc.randomMode
        ? runRandomWorker
        : runWorker;
  // `mahallaUid` ham qo'yiladi: `api.js` dagi javob interceptori 401
  // kelganda tokenni "eskirgan" deb AYNAN shu uid bo'yicha belgilaydi.
  // Usiz fon ishchisining 401 lari hech qayerga yozilmasdi — panel
  // tokenni yashil ("active") ko'rsatib turardi, xodim esa token
  // o'lganini bilmay, yurish behuda aylanaverardi.
  return requestContext.run({ token, user, mahallaUid: user.uid }, () =>
    worker(user, runDoc),
  );
};

// ---------------------------------------------------------------
// Qo'shimcha a'zolar rejimi
// ---------------------------------------------------------------

/**
 * Qo'shimcha a'zolar navbatini tuzadi: yuklangan FamilyMember'lar
 * KADASTR bo'yicha guruhlanib, RegistrationHome navbatiga yoziladi.
 *
 * Manba — `citizens` emas, platformadan yuklangan `FamilyMember`
 * (pa_survey_general). Har xonadon uchun: kadastr, egasi (pinfl),
 * ko'cha va survey_uuid saqlanadi.
 */
const prepareExtraQueue = async (user, run) => {
  await RegistrationRun.updateOne(
    { _id: run._id },
    { $set: { status: "preparing", stage: "Qo'shimcha a'zolar guruhlanmoqda" } },
  );

  // Xonadon egasini (relationship = "хонадон эгаси") POST qilmaymiz —
  // u allaqachon platformada egasi. Faqat a'zolar.
  //
  // Guruhlash KADASTR bo'yicha emas, HOMEID bo'yicha: kadastr `pa_survey_v5`
  // formasida ba'zan bo'sh qaytadi (masalan APOG'ON MFY), lekin POST uchun
  // kadastr umuman kerak emas — street_id + survey_uuid + owner_pinfl yetadi.
  // homeId esa har doim bor va xonadonning asl kimligi. Shuning uchun kadastr
  // yo'qligi yuklashni to'xtatmasligi kerak.
  const allMembers = await FamilyMember.find({
    userUid: user.uid,
    isOwner: { $ne: true },
    homeId: { $nin: [null, ""] },
  }).lean();

  if (!allMembers.length) {
    throw new Error(
      "Qo'shimcha a'zolar topilmadi — avval \"Qo'shimcha a'zolar\" bo'limida yuklang",
    );
  }

  // Sozlamada belgilanmagan ko'chadagi a'zolar chetlab o'tiladi.
  //
  // Bu rejimda ko'cha platformadan emas, YUKLANGAN a'zo yozuvidan
  // olinadi (`FamilyMember.streetId`), shuning uchun filtr ko'chalar
  // ro'yxatiga emas, a'zolarning o'ziga qo'llanadi.
  //
  // Ko'chasi noma'lum a'zo (streetId bo'sh) QOLDIRILADI: uni
  // taqiqlangan deb bo'lmaydi — qaysi ko'chada ekani ma'lum emas,
  // va platformaga yuborishda ko'cha baribir xonadondan olinadi.
  const excluded = excludedStreetsOf(run);

  const members = excluded.size
    ? allMembers.filter(
        (m) => !m.streetId || !excluded.has(String(m.streetId)),
      )
    : allMembers;

  if (!members.length) {
    throw new Error(
      "Ruxsat etilgan ko'chada qo'shimcha a'zo topilmadi — sozlamalardagi ko'chalarni tekshiring",
    );
  }

  if (members.length < allMembers.length) {
    pushRunLog(run._id, {
      level: "info",
      message: `Sozlamaga ko'ra ${allMembers.length - members.length} ta a'zo chetlab o'tildi (taqiqlangan ko'chalar)`,
    });
  }

  // HomeId bo'yicha guruhlash — har xonadon bitta navbat yozuvi.
  const byHome = new Map();
  for (const m of members) {
    const key = String(m.homeId);
    if (!byHome.has(key)) {
      byHome.set(key, {
        homeId: m.homeId,
        // Kadastr bo'lsa — ko'rsatkich/belgi uchun; bo'lmasa homeId.
        cadasterNumber: m.cadasterNumber || null,
        streetId: m.streetId,
        streetName: m.streetName,
        homeNum: m.homeNum,
        surveyUuid: m.surveyUuid,
        // Egasi pinfl — shu xonadon egasidan.
        ownerPinfl: null,
        count: 0,
      });
    }
    const g = byHome.get(key);
    g.cadasterNumber = g.cadasterNumber ?? (m.cadasterNumber || null);
    g.surveyUuid = g.surveyUuid ?? m.surveyUuid;
    g.count += 1;
  }

  // Egasi pinfl'ini alohida olamiz (isOwner=true yozuvlardan) — homeId bo'yicha.
  const owners = await FamilyMember.find({
    userUid: user.uid,
    isOwner: true,
    homeId: { $in: [...byHome.keys()] },
  })
    .select("homeId pinfl surveyUuid")
    .lean();
  for (const o of owners) {
    const g = byHome.get(String(o.homeId));
    if (g) {
      g.ownerPinfl = g.ownerPinfl ?? (o.pinfl ? String(o.pinfl) : null);
      g.surveyUuid = g.surveyUuid ?? o.surveyUuid;
    }
  }

  const queue = [...byHome.values()].map((h, index) => ({
    runId: run._id,
    queueIndex: index,
    homeId: String(h.homeId ?? ""),
    streetId: String(h.streetId ?? ""),
    streetName: h.streetName ?? null,
    homeNum: h.homeNum ?? null,
    cadasterNumber: h.cadasterNumber,
    ownerPinfl: h.ownerPinfl,
    surveyUuid: h.surveyUuid ?? null,
    status: "pending",
    candidatesCount: h.count,
    userUid: user.uid,
  }));

  await RegistrationHome.insertMany(queue);

  await RegistrationRun.updateOne(
    { _id: run._id },
    {
      $set: {
        homesTotal: queue.length,
        membersTotal: members.length,
        stage: "Navbat tayyor",
      },
    },
  );

  return { queued: queue.length };
};

/**
 * Bitta FamilyMember'ni platformaga oila a'zosi sifatida POST qiladi.
 * Davlat bazasidan QAYTA tekshirilmaydi — ma'lumot allaqachon
 * so'rovnomadan olingan.
 */
const postExtraMember = async (user, run, homeRow, member) => {
  const startedAt = Date.now();
  const pinfl = member.pinfl ? String(member.pinfl) : null;

  const finish = (fields) =>
    RegistrationMember.updateOne(
      // Dedup kaliti: kadastr bo'sh bo'lishi mumkin, shuning uchun homeId
      // bo'yicha (har xonadon aniq bitta homeId).
      { runId: run._id, homeId: homeRow.homeId, pinfl },
      {
        $set: {
          runId: run._id,
          homeRowId: homeRow._id,
          cadasterNumber: homeRow.cadasterNumber,
          homeId: homeRow.homeId,
          fullName: member.fullName,
          birthDate: member.birthDate,
          pinfl,
          userUid: user.uid,
          durationMs: Date.now() - startedAt,
          attemptedAt: new Date(),
          ...fields,
        },
      },
      { upsert: true },
    );

  // JSHSHIR yo'q — qo'sha olmaymiz.
  if (!pinfl) {
    await finish({ status: "skipped", reason: "JSHSHIR yo'q", reasonCode: "pinfl_yoq" });
    return "skipped";
  }

  // Telefon: a'zonikisi, bo'lmasa avto-generate.
  const phone = normalizePhone(member.phone) ?? randomUzPhone();

  const payload = {
    pinfl: Number(pinfl),
    full_name: member.fullName,
    address: null,
    phone,
    birth_date: toIsoDate(member.birthDate) ?? member.birthDate,
    study_level_id: String(pickStudyLevel(yearsOld(member.birthDate), pinfl)),
    doc_serial: member.docSerial ?? "",
    doc_number: member.docNumber ?? "",
    // A'zoning haqiqiy qarindoshligi (so'rovnomadan). Bo'lmasa "Boshqa".
    relationship: String(member.relationshipCode ?? DEFAULT_RELATIONSHIP),
    document_type: String(member.documentType ?? 1),
  };

  const params = {
    _target: "modal",
    pinfl,
    obl_id: user.oblId,
    area_id: user.areaId,
    district_id: user.districtId,
    street_id: homeRow.streetId,
    survey_uuid: homeRow.surveyUuid,
    owner_pinfl: homeRow.ownerPinfl,
  };

  try {
    const response = await postFamilyMember(payload, params, run);
    await finish({
      status: "added",
      memberId: response?.id != null ? String(response.id) : null,
      phone,
      relationshipCode: payload.relationship,
      sentPayload: payload,
      sentParams: params,
      platformResponse: response ?? null,
      httpStatus: 200,
      reason: null,
      reasonCode: null,
    });
    pushRunLog(run._id, {
      level: "success",
      fullName: member.fullName,
      message: `Qo'shildi — ${pinfl}`,
      ms: Date.now() - startedAt,
    });
    return "added";
  } catch (err) {
    const reason = describeError(err);
    const reasonCode = reasonCodeOf(reason);
    const place = parseRegisteredPlace(reason);
    await finish({
      status: reasonCode === "allaqachon_mavjud" ? "exists" : "failed",
      reason,
      reasonCode,
      phone,
      sentPayload: payload,
      sentParams: params,
      platformResponse: err.response?.data ?? null,
      httpStatus: err.response?.status ?? null,
      ...(place
        ? {
            registeredRegion: place.region,
            registeredMahalla: place.mahalla,
            movedAway: !sameMahalla(place.mahalla, run.mahallaName),
          }
        : {}),
    });
    pushRunLog(run._id, {
      level: reasonCode === "allaqachon_mavjud" ? "skip" : "error",
      fullName: member.fullName,
      message: reason,
    });
    return reasonCode === "allaqachon_mavjud" ? "exists" : "failed";
  }
};

/**
 * Qo'shimcha a'zolar ishchi (worker).
 */
const runExtraWorker = async (user, runDoc) => {
  const runId = String(runDoc._id);
  const run = runDoc;

  // Sozlamadagi avtomatik to'xtash chegarasi (har "Boshlash" da noldan).
  const session = await newSession(user.uid);

  try {
    const queued = await RegistrationHome.countDocuments({ runId: run._id });
    if (!queued) {
      await prepareExtraQueue(user, run);
    }

    await RegistrationRun.updateOne(
      { _id: run._id },
      {
        $set: {
          status: "running",
          error: null,
          startedAt: run.startedAt ?? new Date(),
          heartbeatAt: new Date(),
        },
      },
    );

    const total = await RegistrationHome.countDocuments({ runId: run._id });

    while (true) {
      const control = await readControl(run);
      if (control !== "run") {
        await RegistrationRun.updateOne(
          { _id: run._id },
          {
            $set: {
              status: control === "pause" ? "paused" : "stopped",
              stage: control === "pause" ? "To'xtatib turildi" : "To'xtatildi",
              finishedAt: control === "stop" ? new Date() : null,
            },
          },
        );
        return;
      }

      const homeRow = await RegistrationHome.findOne({
        runId: run._id,
        status: { $in: ["pending", "processing"] },
      }).sort({ queueIndex: 1 });

      if (!homeRow) break;

      // Taqiqlangan ko'cha — oxirgi himoya (navbat `prepareExtraQueue`
      // da filtrlanadi, lekin eski yurishda qolgan bo'lishi mumkin).
      if (excludedStreetsOf(run).has(String(homeRow.streetId))) {
        await RegistrationHome.updateOne(
          { _id: homeRow._id },
          {
            $set: {
              status: "skipped",
              reason: "Ko'cha sozlamalarda taqiqlangan",
              finishedAt: new Date(),
            },
          },
        );

        pushRunLog(run._id, {
          level: "skip",
          message: `${homeRow.streetName ?? homeRow.streetId} — ko'cha sozlamalarda taqiqlangan`,
        });

        await recountRun(run._id);
        continue;
      }

      await RegistrationHome.updateOne(
        { _id: homeRow._id },
        { $set: { status: "processing", startedAt: new Date() } },
      );

      await RegistrationRun.updateOne(
        { _id: run._id },
        {
          $set: {
            stage: `Xonadon ${homeRow.queueIndex + 1}/${total} — ${homeRow.cadasterNumber ?? homeRow.homeNum ?? homeRow.homeId}`,
            heartbeatAt: new Date(),
          },
        },
      );

      // Shu xonadondagi a'zolar (egasidan boshqa). homeId bo'yicha —
      // kadastr bo'sh bo'lishi mumkin, homeId esa har doim bor.
      const members = await FamilyMember.find({
        userUid: user.uid,
        homeId: homeRow.homeId,
        isOwner: { $ne: true },
      }).lean();

      let added = 0;
      let interrupted = false;
      let hitLimit = false;

      for (const member of members) {
        if ((await readControlCached(run)) !== "run") {
          interrupted = true;
          break;
        }

        // Sozlamadagi chegara bu rejimga ham tegishli — u ham
        // platformaga odam qo'shadi.
        if (await reachedLimit(session)) {
          interrupted = true;
          hitLimit = true;
          break;
        }

        const r = await postExtraMember(user, run, homeRow, member);
        if (r === "added") {
          added += 1;
          session.added += 1;
        }
        await recountRun(run._id);
      }

      if (interrupted) {
        await RegistrationHome.updateOne(
          { _id: homeRow._id },
          { $set: { status: "pending" } },
        );

        if (hitLimit) {
          await stopRunAtLimit(run, session);
          return;
        }

        continue;
      }

      await RegistrationHome.updateOne(
        { _id: homeRow._id },
        {
          $set: {
            status: "done",
            addedCount: added,
            finishedAt: new Date(),
          },
        },
      );
      await recountRun(run._id);
    }

    await RegistrationRun.updateOne(
      { _id: run._id },
      {
        $set: {
          status: "done",
          stage: "Tugadi",
          finishedAt: new Date(),
        },
      },
    );
  } catch (err) {
    // Token eskirgan — xato emas, pauza (yangilab davom ettiriladi).
    if (err instanceof TokenExpiredError) {
      await pauseRunForExpiredToken(run);
      return;
    }

    console.error("[Qo'shimcha a'zolar] xatolik:", err);
    await RegistrationRun.updateOne(
      { _id: run._id },
      { $set: { status: "error", error: err.message, stage: "Xatolik", finishedAt: new Date() } },
    ).catch(() => {});
  } finally {
    activeRuns.delete(runId);
    clearControlCache(runId);
    await RegistrationRun.updateOne(
      { _id: run._id, ownerId: SERVER_ID },
      { $set: { ownerId: null, ownerName: null } },
    ).catch(() => {});
  }
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

    // Sozlamadagi avtomatik to'xtash chegarasi. Har "Boshlash" da
    // noldan sanaladi.
    const session = await newSession(user.uid);

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
        reasonCode: { $in: PERMANENT_REASON_CODES },
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

      const homeResult = await processHome(
        user,
        run,
        homeRow,
        takenPinfls,
        hopelessPinfls,
        certPinfls,
        session,
      );

      // Hisoblagichlarni $inc bilan emas, HAQIQIY yozuvlardan qayta
      // hisoblaymiz. Sababi: xonadon qayta ishlanishi mumkin (server
      // o'chib qolgan bo'lsa), $inc esa bunda ikki marta qo'shib
      // yuborardi va sonlar haqiqatdan uzoqlashardi.
      await recountRun(run._id);

      // Sozlamadagi chegara bajarildi — yurishni YAKUNLAYMIZ.
      //
      // Bu `continue` bilan bo'lmaydi: boshqaruv hamon "run" bo'lgani
      // uchun sikl o'sha xonadonni qayta-qayta olib, abadiy
      // aylanaverardi.
      if (homeResult?.interrupted === "limit") {
        await stopRunAtLimit(run, session);
        return;
      }

      // Xonadon o'rtasida to'xtatilgan bo'lsa — siklni uzamiz.
      // Keyingi aylanishdagi boshqaruv tekshiruvi holatni (paused/
      // stopped) rasmiylashtiradi va xonadon `pending` da qoladi.
      if (homeResult?.interrupted) continue;
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
    // Token eskirgan — xato emas, pauza (yangilab davom ettiriladi).
    if (err instanceof TokenExpiredError) {
      await pauseRunForExpiredToken(run);
      return;
    }

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
    clearControlCache(runId);

    // Egalikni bo'shatamiz — boshqa server davom ettira olsin.
    await RegistrationRun.updateOne(
      { _id: run._id, ownerId: SERVER_ID },
      { $set: { ownerId: null, ownerName: null } },
    ).catch(() => {});
  }
};

// ---------------------------------------------------------------
// Kadastrsiz rejim — familiya bo'yicha moslash + random taqsimlash
// ---------------------------------------------------------------

/**
 * Platformadagi xonadonlarni yuklab, ularni FAMILIYA KALITI bo'yicha
 * indekslaydi.
 *
 * Nega kerak: kadastrsiz bazada kadastr yo'q, ya'ni odamni xonadonga
 * bog'laydigan yagona ishora — FAMILIYA. Xonadon egasi "ERGASHEV
 * SUXBATJON" bo'lsa, bazadagi "ERGASHEV XUDOYBERDI" aynan shu
 * xonadonga tushishi kerak: ular bir oila.
 *
 * Indeks bir marta quriladi va butun yurish davomida ishlatiladi —
 * aks holda har fuqaro uchun ko'chalar qayta yuklanib, rate-limit
 * behuda sarflanardi.
 *
 * Qaytaradi:
 *   homes      — barcha xonadonlar (random taqsimlash uchun)
 *   bySurname  — familiya kaliti -> xonadonlar ro'yxati
 */
const buildHomeIndex = async (user, run, excludedStreetIds) => {
  await RegistrationRun.updateOne(
    { _id: run._id },
    { $set: { stage: "Ko'chalar yuklanmoqda" } },
  );

  const allStreets = await fetchStreets(user, run);

  // Sozlamalarda taqiqlangan ko'chalar ("номаълум" kabi texnik
  // ko'chalar) — bu rejimda ham chetlab o'tiladi.
  const streets = allowedStreets(allStreets, excludedStreetIds, run);

  if (!streets.length) {
    throw new Error(
      allStreets.length
        ? "Ruxsat etilgan ko'chalar yo'q — sozlamalarni tekshiring"
        : "Ko'chalar topilmadi — token o'z MFY ingizga tegishli bo'lishi kerak",
    );
  }

  pushRunLog(run._id, {
    level: "info",
    message: `${streets.length} ko'cha topildi — xonadonlar yuklanmoqda`,
  });

  const homes = [];
  const bySurname = new Map();

  for (const [index, street] of streets.entries()) {
    const control = await readControl(run);
    if (control !== "run") return { homes, bySurname, interrupted: control };

    await RegistrationRun.updateOne(
      { _id: run._id },
      {
        $set: {
          stage: `Ko'chalar: ${index + 1}/${streets.length} — ${street.name}`,
          heartbeatAt: new Date(),
        },
      },
    );

    let streetHomes = [];

    try {
      streetHomes = await fetchStreetHomes(user, String(street.id), run);
    } catch (err) {
      // Bitta ko'cha yuklanmasa qolganlari davom etadi — butun
      // yurish to'xtamasin (kadastr rejimidagi bilan bir xil qoida).
      pushRunLog(run._id, {
        level: "error",
        message: `"${street.name}" ko'chasi yuklanmadi: ${describeError(err)}`,
      });
      continue;
    }

    for (const home of streetHomes) {
      const entry = {
        homeId: String(home.id),
        streetId: String(street.id),
        streetName: street.name,
        homeNum: home.home_num,
        cadasterNumber: home.cadaster_number ?? null,
        ownerFullName: home.full_name ?? null,
        ownerPinfl: home.pinfl != null ? String(home.pinfl) : null,
        // Egasining familiya kaliti — moslashning asosi.
        ownerSurnameKey: fullNameSurnameKey(home.full_name),
        // Xonadonda hozir nechta a'zo bor. Dastlab noma'lum: xonadon
        // kerak bo'lganda bir marta so'raladi va shu yerda eslanadi
        // (har fuqaro uchun qayta so'rash rate-limitni yeb qo'yardi).
        memberCount: null,
        surveyUuid: null,
      };

      homes.push(entry);

      if (entry.ownerSurnameKey) {
        const bucket = bySurname.get(entry.ownerSurnameKey);
        if (bucket) bucket.push(entry);
        else bySurname.set(entry.ownerSurnameKey, [entry]);
      }
    }
  }

  if (!homes.length) {
    throw new Error(
      `Xonadonlar topilmadi: tashqi API ${streets.length} ko'cha qaytardi, lekin ularda xonadon yo'q. Token o'z MFY ingizga tegishli bo'lishi kerak.`,
    );
  }

  pushRunLog(run._id, {
    level: "info",
    message: `${homes.length} xonadon yuklandi — ${bySurname.size} xil familiya aniqlandi`,
  });

  return { homes, bySurname, interrupted: null };
};

/**
 * Xonadonning `survey_uuid` va hozirgi a'zolari soni.
 *
 * Ikkalasi ham a'zo qo'shish uchun majburiy, lekin ro'yxat
 * endpointi ularni bermaydi. Bir marta so'raladi va xonadon
 * yozuvida eslanadi.
 *
 * Qaytaradi: xonadon ishlatishga yaroqlimi (survey_uuid bormi).
 */
const loadHomeState = async (user, run, home, knownPinfls) => {
  if (home.memberCount !== null) return home.memberCount !== Infinity;

  if (!home.surveyUuid) {
    let formData = null;

    try {
      formData = await fetchHomeForm(user, home.homeId, run);
    } catch (err) {
      // Token eskirgan — butun yurishning muammosi, yuqoriga uzatamiz.
      if (isAuthError(err)) throw new TokenExpiredError();

      // Bu xonadon o'qilmadi — boshqa urinmaymiz, keyingisiga o'tamiz.
      home.memberCount = Infinity;
      return false;
    }

    if (!formData?.survey_uuid) {
      home.memberCount = Infinity;
      return false;
    }

    home.surveyUuid = formData.survey_uuid;
    if (formData.pinfl) home.ownerPinfl = String(formData.pinfl);
    if (formData.full_name) {
      home.ownerFullName = formData.full_name;
      home.ownerSurnameKey =
        home.ownerSurnameKey ?? fullNameSurnameKey(formData.full_name);
    }
  }

  const members = await fetchFamilyMembers(
    user,
    home.streetId,
    home.surveyUuid,
    run,
  ).catch((err) => {
    if (isAuthError(err)) throw new TokenExpiredError();
    return [];
  });

  home.memberCount = members.length;

  // Platformada turganlar qayta yuborilmaydi.
  for (const person of members) {
    if (person.pinfl) knownPinfls.add(String(person.pinfl));
  }
  if (home.ownerPinfl) knownPinfls.add(String(home.ownerPinfl));

  return true;
};

// Platformada bitta xonadonga cheklangan sondagi a'zo sig'adi
// ("хонадонга N тадан зиёд оила азоси киритиш мумкин эмас").
// Amalda N = 20, ba'zi xonadonlarda 15.
const UNCADASTRED_HOME_LIMIT = 20;

/**
 * Bitta kadastrsiz fuqaro uchun XONADON TANLAYDI.
 *
 * Tartib:
 *   1. FAMILIYA bo'yicha: egasining familiyasi mos keladigan va
 *      bo'sh joyi bor xonadon. Bir familiyada bir nechta xonadon
 *      bo'lsa — eng bo'shi (kamroq a'zoli), shunda bitta xonadonga
 *      tiqilib qolmaydi.
 *   2. Mos xonadon bo'lmasa — RANDOM: bo'sh joyi bor ixtiyoriy
 *      xonadon.
 *
 * Qaytaradi: { home, via: "familiya" | "random" } yoki null.
 */
const pickHomeFor = async (
  user,
  run,
  citizen,
  homeIndex,
  knownPinfls,
  randomCursor,
) => {
  const { homes, bySurname } = homeIndex;

  const hasRoom = (home) =>
    home.memberCount !== null &&
    home.memberCount !== Infinity &&
    home.memberCount < UNCADASTRED_HOME_LIMIT;

  // --- 1. Familiya bo'yicha ---
  const key = citizen.lastNameKey ?? surnameKey(citizen.lastName);

  if (key) {
    const bucket = bySurname.get(key) ?? [];

    // Holati noma'lum xonadonlarni bir marta so'raymiz. FAQAT shu
    // familiyadagilar — hammasi emas (rate-limit tejaladi).
    for (const home of bucket) {
      if (home.memberCount !== null) continue;
      if ((await readControlCached(run)) !== "run") break;

      await loadHomeState(user, run, home, knownPinfls);
    }

    // Eng bo'sh xonadon — a'zolar tarqalib joylashsin.
    const matched = bucket
      .filter(hasRoom)
      .sort((a, b) => a.memberCount - b.memberCount)[0];

    if (matched) return { home: matched, via: "familiya" };
  }

  // --- 2. Random ---
  //
  // "Random" bu yerda "har safar tasodifiy xonadon" degani emas:
  // har fuqaro uchun tasodifiy tanlasak, bitta xonadon bir necha
  // bor tekshirilib, holati noma'lumlari uchun qayta-qayta so'rov
  // ketardi. Buning o'rniga xonadonlar ro'yxati yurish boshida BIR
  // MARTA aralashtiriladi va shu tartibda ketma-ket to'ldiriladi —
  // natija ham tasodifiy, ham tejamkor.
  while (randomCursor.index < homes.length) {
    const home = homes[randomCursor.index];

    if (home.memberCount === null) {
      if ((await readControlCached(run)) !== "run") return null;
      await loadHomeState(user, run, home, knownPinfls);
    }

    if (hasRoom(home)) return { home, via: "random" };

    // Bu xonadon to'la yoki yaroqsiz — keyingisiga o'tamiz va
    // boshqa qaytmaymiz.
    randomCursor.index += 1;
  }

  return null;
};

/**
 * Bitta kadastrsiz fuqaroni platformaga oila a'zosi sifatida
 * yuboradi.
 *
 * Davlat bazasidan QAYTA TEKSHIRILMAYDI — "Qo'shimcha a'zolar"
 * rejimidagi bilan bir xil qoida: ma'lumot xodim tayyorlagan
 * fayldan olingan, GCP so'rovi esa faqat rate-limitni sarflardi.
 * JSHSHIR to'g'riligini platformaning o'zi tekshiradi.
 *
 * Qaytaradi: "added" | "exists" | "failed" | "skipped" | "home_full"
 */
const postUncadastredMember = async (user, run, home, citizen, via) => {
  const startedAt = Date.now();
  const pinfl = citizen.pinfl ? String(citizen.pinfl) : null;

  const finish = (fields) =>
    RegistrationMember.updateOne(
      // Dedup kaliti: bir odam bir xonadonga ikki marta yozilmasin.
      // Kadastr yo'q, shuning uchun homeId bo'yicha.
      { runId: run._id, homeId: home.homeId, pinfl },
      {
        $set: {
          runId: run._id,
          cadasterNumber: home.cadasterNumber ?? null,
          homeId: home.homeId,
          citizenId: citizen._id,
          fullName: citizen.fullName,
          birthDate: citizen.birthDate,
          document: citizen.document ?? null,
          pinfl,
          userUid: user.uid,
          durationMs: Date.now() - startedAt,
          attemptedAt: new Date(),
          ...fields,
        },
      },
      { upsert: true },
    );

  // JSHSHIR yo'q — platforma a'zo qo'sha olmaydi (majburiy maydon).
  if (!pinfl) {
    await finish({
      status: "skipped",
      reason: "JSHSHIR yo'q",
      reasonCode: "pinfl_yoq",
    });

    pushRunLog(run._id, {
      level: "skip",
      fullName: citizen.fullName,
      message: "JSHSHIR yo'q — kiritilmadi",
    });

    return "skipped";
  }

  const isoBirthDate = toIsoDate(citizen.birthDate);

  if (!isoBirthDate) {
    await finish({
      status: "skipped",
      reason: "Tug'ilgan sana noto'g'ri yoki yo'q",
      reasonCode: "sana_notogri",
    });

    pushRunLog(run._id, {
      level: "skip",
      fullName: citizen.fullName,
      message: "Tug'ilgan sana yo'q — kiritilmadi",
    });

    return "skipped";
  }

  // Telefon: faylda bo'lsa o'zi, bo'lmasa avto-generate
  // ("Qo'shimcha a'zolar" rejimidagi bilan bir xil mantiq).
  const phone = normalizePhone(citizen.phone) ?? randomUzPhone();

  const age = yearsOld(isoBirthDate);

  const payload = {
    pinfl: Number(pinfl),
    full_name: citizen.fullName,
    address: null,
    phone,
    birth_date: isoBirthDate,
    study_level_id: String(pickStudyLevel(age, pinfl)),
    doc_serial: citizen.documentSeries ?? "",
    doc_number: citizen.documentNumber ?? "",
    // Qarindoshlik: faylda ko'rsatilgan bo'lsa o'shani, bo'lmasa
    // "Boshqa". Kadastr rejimida har doim "Boshqa" edi — u yerdagi
    // manbada bu ustun umuman yo'q; kadastrsiz faylda esa bor.
    relationship: String(citizen.relationshipCode ?? DEFAULT_RELATIONSHIP),
    document_type: String(
      isBirthCertificate(citizen.documentSeries) ? 2 : 1,
    ),
  };

  const params = {
    _target: "modal",
    pinfl,
    obl_id: user.oblId,
    area_id: user.areaId,
    district_id: user.districtId,
    street_id: home.streetId,
    survey_uuid: home.surveyUuid,
    owner_pinfl: home.ownerPinfl,
  };

  // Taqsimlash qanday bo'lganini yozib qo'yamiz: xodim hisobotda
  // "bu odam o'z oilasiga tushdimi yoki tasodifiy joygami" degan
  // savolga javob topishi kerak.
  const viaFields = {
    sentPayload: payload,
    sentParams: params,
    relationshipCode: payload.relationship,
    studyLevelCode: payload.study_level_id,
    phone,
    matchVia: via,
    matchedOwnerFullName: home.ownerFullName ?? null,
  };

  pushRunLog(run._id, {
    level: "request",
    fullName: citizen.fullName,
    message:
      `POST — ${pinfl}, ${age} yosh, ` +
      `${via === "familiya" ? `familiya mos (${home.ownerFullName ?? "?"})` : "random"}, ` +
      `${home.homeNum ?? home.homeId}-uy`,
  });

  try {
    const response = await postFamilyMember(payload, params, run);

    await finish({
      ...viaFields,
      status: "added",
      memberId: response?.id != null ? String(response.id) : null,
      platformResponse: response ?? null,
      httpStatus: 200,
      reason: null,
      reasonCode: null,
    });

    // Xonadonda bitta joy kamaydi.
    if (Number.isFinite(home.memberCount)) home.memberCount += 1;

    pushRunLog(run._id, {
      level: "success",
      fullName: citizen.fullName,
      message: `Qo'shildi — ${home.homeNum ?? home.homeId}-uy (${via === "familiya" ? "familiya bo'yicha" : "random"})`,
      ms: Date.now() - startedAt,
    });

    return "added";
  } catch (err) {
    // Token eskirgan — bu fuqaroning emas, butun yurishning
    // muammosi. Yuqoriga uzatamiz: yurish pauza qilinadi.
    if (isAuthError(err)) throw new TokenExpiredError();

    const reason = describeError(err);
    const reasonCode = reasonCodeOf(reason);

    // Xonadon to'lgan bo'lsa — bu odamning aybi emas. Xonadonni
    // to'la deb belgilaymiz va odam KEYINGI xonadonda qayta
    // urinadi (chaqiruvchi "home_full" dan shuni biladi). Yozuv
    // YARATILMAYDI: aks holda bitta odam uchun bir nechta "xato"
    // qatori paydo bo'lib, hisobot buzilardi.
    if (/зиёд|ziyod|оила\s+аъзоси\s+киритиш|оила\s+азоси\s+киритиш/i.test(reason)) {
      home.memberCount = UNCADASTRED_HOME_LIMIT;

      pushRunLog(run._id, {
        level: "info",
        message: `${home.homeNum ?? home.homeId}-uy to'ldi — keyingi xonadonga o'tiladi`,
      });

      return "home_full";
    }

    const place = parseRegisteredPlace(reason);

    await finish({
      ...viaFields,
      status: reasonCode === "allaqachon_mavjud" ? "exists" : "failed",
      reason,
      reasonCode,
      platformResponse: err.response?.data ?? null,
      httpStatus: err.response?.status ?? null,
      ...(place
        ? {
            registeredRegion: place.region,
            registeredMahalla: place.mahalla,
            movedAway: !sameMahalla(place.mahalla, run.mahallaName),
          }
        : {}),
    });

    pushRunLog(run._id, {
      level: reasonCode === "allaqachon_mavjud" ? "skip" : "error",
      fullName: citizen.fullName,
      message: reason,
      status: err.response?.status,
      ms: Date.now() - startedAt,
    });

    return reasonCode === "allaqachon_mavjud" ? "exists" : "failed";
  }
};

/**
 * KADASTRSIZ rejim ishchisi.
 *
 * Kadastr rejimidan farqi: navbat XONADONLAR bo'yicha emas,
 * FUQAROLAR bo'yicha ketadi — chunki odamni xonadonga bog'laydigan
 * kadastr yo'q. Har fuqaro uchun xonadon joyida tanlanadi:
 * familiyasi mos keladigani bo'lsa o'shanisi, bo'lmasa random.
 */
const runUncadastredWorker = async (user, runDoc) => {
  const runId = String(runDoc._id);
  const run = runDoc;

  // Sozlamadagi avtomatik to'xtash chegarasi (har "Boshlash" da
  // noldan) — bu rejim ham platformaga odam qo'shadi.
  const session = await newSession(user.uid);

  try {
    const fresh = await RegistrationRun.findById(run._id).lean();

    const groupId = fresh?.uncadastredGroupId;
    if (!groupId) throw new Error("MFY guruhi tanlanmagan");

    const group = await UncadastredGroup.findById(groupId).lean();
    if (!group) {
      throw new Error("MFY guruhi topilmadi — o'chirilgan bo'lishi mumkin");
    }

    await RegistrationRun.updateOne(
      { _id: run._id },
      {
        $set: {
          status: "preparing",
          error: null,
          stage: `"${group.name}" guruhi tayyorlanmoqda`,
          startedAt: run.startedAt ?? new Date(),
          heartbeatAt: new Date(),
        },
      },
    );

    pushRunLog(run._id, {
      level: "info",
      message: `Kadastrsiz rejim — "${group.name}" guruhi (${group.total ?? 0} ta yozuv)`,
    });

    // --- Allaqachon band JSHSHIR'lar ---
    //
    // Bir odam bazada bir necha bor uchrashi mumkin, bundan tashqari
    // oldingi yurishlarda qo'shilgan yoki "boshqa xonadonda bor" deb
    // rad etilgan bo'lishi mumkin. Bunday odamga qayta so'rov
    // yubormaymiz — rate-limit tejaladi.
    const knownPinfls = new Set();

    for (const filter of [
      { userUid: user.uid, status: { $in: ["added", "exists"] } },
      {
        userUid: user.uid,
        reasonCode: {
          $in: [
            "boshqa_xonadon_egasi",
            "boshqa_xonadon_azosi",
            "allaqachon_mavjud",
          ],
        },
      },
      // O'zgarmas sabab bilan chetda qolganlar (vafot etgan, hujjati
      // yaroqsiz) — javob o'zgarmaydi.
      { userUid: user.uid, reasonCode: { $in: PERMANENT_REASON_CODES } },
    ]) {
      for (const field of ["pinfl", "verifiedPinfl"]) {
        for (const pinfl of await RegistrationMember.distinct(field, filter)) {
          if (pinfl) knownPinfls.add(String(pinfl));
        }
      }
    }

    pushRunLog(run._id, {
      level: "info",
      message: `${knownPinfls.size} ta JSHSHIR allaqachon band — ularga so'rov yuborilmaydi`,
    });

    // --- Xonadonlar indeksi ---
    const homeIndex = await buildHomeIndex(
      user,
      run,
      excludedStreetsOf(fresh),
    );

    if (homeIndex.interrupted) {
      const paused = homeIndex.interrupted === "pause";

      await RegistrationRun.updateOne(
        { _id: run._id },
        {
          $set: {
            status: paused ? "paused" : "stopped",
            stage: paused ? "To'xtatib turildi" : "To'xtatildi",
            finishedAt: paused ? null : new Date(),
          },
        },
      );
      return;
    }

    // Random taqsimlash uchun xonadonlarni BIR MARTA aralashtiramiz
    // (`pickHomeFor` izohiga qarang). Fisher–Yates.
    const shuffled = [...homeIndex.homes];
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    homeIndex.homes = shuffled;

    const randomCursor = { index: 0 };

    // --- Fuqarolar navbati ---
    //
    // Bir so'rovda hammasini olmaymiz: guruhda o'n minglab yozuv
    // bo'lishi mumkin. Bo'laklab o'qiymiz — `_id` bo'yicha oldinga
    // siljib (`skip` ishlatmasdan: katta kolleksiyada u sekinlashadi).
    const BATCH = 500;
    let lastId = null;

    let added = 0;
    let failed = 0;
    let skipped = 0;
    let exists = 0;
    let bySurnameCount = fresh.matchedBySurname ?? 0;
    let randomlyCount = fresh.matchedRandomly ?? 0;
    let processed = 0;
    let outOfHomes = false;

    const total = await UncadastredCitizen.countDocuments({ groupId });

    if (!total) {
      throw new Error(
        `"${group.name}" guruhida yozuv yo'q — avval Excel yuklang`,
      );
    }

    await RegistrationRun.updateOne(
      { _id: run._id },
      {
        $set: {
          status: "running",
          membersTotal: total,
          stage: `Kadastrsiz — 0/${total}`,
          heartbeatAt: new Date(),
        },
      },
    );

    outer: for (;;) {
      const control = await readControl(run);
      if (control !== "run") {
        const paused = control === "pause";

        await RegistrationRun.updateOne(
          { _id: run._id },
          {
            $set: {
              status: paused ? "paused" : "stopped",
              stage: paused ? "To'xtatib turildi" : "To'xtatildi",
              waitingUntil: null,
              finishedAt: paused ? null : new Date(),
            },
          },
        );

        pushRunLog(run._id, {
          level: "info",
          message: paused ? "Jarayon to'xtatib turildi" : "Jarayon to'xtatildi",
        });
        return;
      }

      const batch = await UncadastredCitizen.find({
        groupId,
        ...(lastId ? { _id: { $gt: lastId } } : {}),
      })
        .sort({ _id: 1 })
        .limit(BATCH)
        .lean();

      if (!batch.length) break;

      for (const citizen of batch) {
        // Boshqaruv tugmasi — har odamdan oldin (keshlangan o'qish:
        // tugma bosilgani darhol sezilsin, lekin har odamda bazaga
        // borilmasin).
        //
        // `continue outer` — tashqi sikl boshiga qaytadi va u yerda
        // boshqaruv KESHSIZ o'qiladi: yurish to'g'ri holat bilan
        // yopiladi. Bu yerda `lastId` ataylab SURILMAYDI (pastda,
        // odam ishlanganidan keyin suriladi) — aks holda to'xtatish
        // paytida partiyaning qolgan qismi o'tkazib yuborilardi va
        // davom ettirilganda ular umuman ishlanmasdi.
        if ((await readControlCached(run)) !== "run") continue outer;

        // Sozlamadagi chegara.
        if (await reachedLimit(session)) {
          await stopRunAtLimit(run, session);
          return;
        }

        processed += 1;

        // Allaqachon band JSHSHIR — so'rov yubormaymiz.
        const pinfl = citizen.pinfl ? String(citizen.pinfl) : null;

        if (pinfl && knownPinfls.has(pinfl)) {
          skipped += 1;
          // DIQQAT: `lastId` shu yerda ham suriladi. Aks holda
          // butunlay o'tkazib yuborilgan partiya (hammasi band
          // JSHSHIR) qayta-qayta o'qilib, sikl cheksiz aylanardi.
          lastId = citizen._id;
          continue;
        }

        // Xonadon tanlaymiz. Tanlangan xonadon to'lib qolsa
        // (platforma rad etsa), keyingisida qayta urinamiz.
        let result = null;

        for (let attempt = 0; attempt < 3; attempt += 1) {
          const picked = await pickHomeFor(
            user,
            run,
            citizen,
            homeIndex,
            knownPinfls,
            randomCursor,
          );

          if (!picked) break;

          result = await postUncadastredMember(
            user,
            run,
            picked.home,
            citizen,
            picked.via,
          );

          if (result !== "home_full") {
            if (result === "added") {
              if (picked.via === "familiya") bySurnameCount += 1;
              else randomlyCount += 1;
            }
            break;
          }

          result = null;
        }

        if (result === null) {
          // Bo'sh joyi bor xonadon qolmadi — davom etish befoyda.
          outOfHomes = true;
          break outer;
        }

        if (result === "added") {
          added += 1;
          session.added += 1;
          if (pinfl) knownPinfls.add(pinfl);
        } else if (result === "exists") {
          exists += 1;
          if (pinfl) knownPinfls.add(pinfl);
        } else if (result === "failed") {
          failed += 1;
        } else {
          skipped += 1;
        }

        // Bu odam ishlandi — navbat shu yerdan davom etadi.
        lastId = citizen._id;

        await RegistrationRun.updateOne(
          { _id: run._id },
          {
            $set: {
              stage: `Kadastrsiz — ${processed}/${total} (${added} kiritildi)`,
              membersAdded: added,
              membersFailed: failed,
              membersSkipped: skipped,
              matchedBySurname: bySurnameCount,
              matchedRandomly: randomlyCount,
              heartbeatAt: new Date(),
            },
          },
        );
      }
    }

    if (outOfHomes) {
      pushRunLog(run._id, {
        level: "info",
        message:
          "Bo'sh joyi bor xonadon qolmadi — jarayon to'xtatildi. " +
          `Platformada har xonadonga ${UNCADASTRED_HOME_LIMIT} tagacha a'zo sig'adi.`,
      });
    }

    await RegistrationRun.updateOne(
      { _id: run._id },
      {
        $set: {
          status: "done",
          stage: outOfHomes
            ? `Xonadonlar to'ldi — ${added} ta kiritildi`
            : `Tugadi — ${added} ta kiritildi (${bySurnameCount} familiya, ${randomlyCount} random)`,
          membersAdded: added,
          membersFailed: failed,
          membersSkipped: skipped,
          matchedBySurname: bySurnameCount,
          matchedRandomly: randomlyCount,
          finishedAt: new Date(),
        },
      },
    );

    pushRunLog(run._id, {
      level: "info",
      message:
        `Kadastrsiz rejim tugadi: ${added} kiritildi ` +
        `(${bySurnameCount} familiya bo'yicha, ${randomlyCount} random), ` +
        `${exists} allaqachon bor, ${failed} xato, ${skipped} o'tkazildi`,
    });
  } catch (err) {
    // Token eskirgan — xato emas, pauza (yangilab davom ettiriladi).
    if (err instanceof TokenExpiredError) {
      await pauseRunForExpiredToken(run);
      return;
    }

    console.error("[Kadastrsiz] xatolik:", err);

    await RegistrationRun.updateOne(
      { _id: run._id },
      {
        $set: {
          status: "error",
          error: err.message,
          stage: "Xatolik",
          finishedAt: new Date(),
        },
      },
    ).catch(() => {});

    pushRunLog(run._id, {
      level: "error",
      message: `Jarayon to'xtadi: ${err.message}`,
    });
  } finally {
    activeRuns.delete(runId);
    clearControlCache(runId);

    // Egalikni bo'shatamiz — boshqa server davom ettira olsin.
    await RegistrationRun.updateOne(
      { _id: run._id, ownerId: SERVER_ID },
      { $set: { ownerId: null, ownerName: null } },
    ).catch(() => {});
  }
};
