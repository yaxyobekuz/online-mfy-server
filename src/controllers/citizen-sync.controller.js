import api from "../config/api.js";
import Citizen from "../models/Citizen.js";
import { getRequestUser } from "../utils/request-context.js";
import { withRateLimit } from "../utils/rate-limit.js";
import {
  startSync,
  tickSync,
  finishSync,
  failSync,
  getSyncProgress,
  isSyncRunning,
  setSyncWaiting,
} from "../utils/home-sync-progress.js";
import {
  toIsoDate,
  toDottedDate,
  shortenDocumentType,
  splitDocument,
  extractBirthCertPerson,
  joinName,
  isExpiredDocument,
  isBirthCertificate,
} from "../utils/person-data.js";
import { extractMahallaName, mahallaKey } from "../utils/mahalla.js";

// Fuqarolar bazasi global, lekin jarayonni kim boshlaganini
// ajratib turish uchun kalit foydalanuvchi bo'yicha beriladi —
// shunda ikki xodim bir vaqtda boshlasa progress aralashmaydi.
const citizenSyncKey = (userUid) => `citizenSync:${userUid}`;

// Bir yurishda nechta yozuv olinadi. Tashqi API sekundiga bir nechta
// so'rovga ruxsat beradi, 150 mingni bir yurishda yangilab bo'lmaydi —
// shuning uchun bo'laklab ishlanadi.
const MAX_BATCH = 2000;

const logWait = (progressKey, label) => (until) => {
  setSyncWaiting(progressKey, until);
  if (!until) return;

  const seconds = Math.ceil((until - Date.now()) / 1000);
  if (seconds >= 3) {
    console.log(`[${label}] rate limitga yetildi, ${seconds} soniya kutilmoqda...`);
  }
};

// GCP ba'zan haqiqiy sababni bermasdan "Internal Server Error"
// qaytaradi — bu vaqtinchalik nosozlik. Tajriba shuni ko'rsatdi:
// 5 tadan 4 tasi qayta so'ralganda hal bo'ladi (yo ma'lumot keladi,
// yo "vafot etgan"/"hujjati yaroqsiz" kabi aniq sabab chiqadi).
const isTransientError = (gcpData) =>
  /Internal Server Error/i.test(String(gcpData?.message ?? ""));

// Shaxs vafot etgan — bu holat o'zgarmaydi, qayta so'rash befoyda.
const isDeceased = (gcpData) =>
  /status_name\s*=\s*vafot etgan/i.test(String(gcpData?.message ?? ""));

// Tarmoq uzilishi (DNS, timeout, ulanish). Bu ma'lumotning emas,
// aloqaning muammosi — bir necha soniyadan keyin qayta urinib
// ko'rish kerak, aks holda uzilish paytidagi o'nlab yozuv bekorga
// "xato" bo'lib qoladi.
const NETWORK_ERRORS = new Set([
  "ENOTFOUND", "ECONNRESET", "ETIMEDOUT", "ECONNREFUSED",
  "EAI_AGAIN", "ECONNABORTED", "EHOSTUNREACH", "ENETUNREACH",
]);

const isNetworkError = (err) =>
  !err?.response && (NETWORK_ERRORS.has(err?.code) || err?.code === "ERR_NETWORK");

const GCP_RETRIES = 3;

// Vaqtinchalik nosozlikdan keyin darhol qayta so'rasak, ko'pincha
// yana o'sha javob keladi. Qisqa tanaffus natijani sezilarli
// yaxshilaydi.
const RETRY_PAUSE_MS = 1200;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// JSHSHIR + tug'ilgan sana bo'yicha davlat pasport bazasidan
// (GCP) so'nggi ma'lumotni oladi.
const fetchGcpOnce = (pinfl, birthDate, progressKey) =>
  withRateLimit(
    () =>
      api.get("/api/v1/gcp/pinfl", {
        params: { pinfl, birth_date: birthDate, form_name: "survey_homes_family" },
      }),
    {
      delayMs: 150,
      adaptiveKey: progressKey,
      onWait: progressKey ? logWait(progressKey, "Fuqarolar sync") : undefined,
    },
  ).then((response) => response.data);

const fetchGcpData = async (pinfl, birthDate, progressKey) => {
  let last = null;

  for (let attempt = 1; attempt <= GCP_RETRIES; attempt++) {
    last = await fetchGcpOnce(pinfl, birthDate, progressKey);

    // Javob aniq bo'lsa (muvaffaqiyat yoki tushunarli sabab) —
    // qayta so'rashning hojati yo'q.
    if (last?.code === 0 || !isTransientError(last)) return last;

    if (attempt < GCP_RETRIES) await pause(RETRY_PAUSE_MS);
  }

  return last;
};

// Tug'ilganlik guvohnomasi (seriya + raqam + sana) bo'yicha FHDYO
// bazasidan bolaning ma'lumotini oladi. Bolada JSHSHIR bo'lmagani
// uchun GCP uni topa olmaydi.
const fetchBirthCertData = (series, number, birthDate, progressKey) =>
  withRateLimit(
    () =>
      api.get("/api/v2/fhdyo/act/birth", {
        params: { serial: series, number, birth_date: birthDate },
      }),
    {
      delayMs: 150,
      adaptiveKey: progressKey,
      onWait: progressKey ? logWait(progressKey, "Fuqarolar sync") : undefined,
    },
  ).then((response) => response.data);

// GCP javobidan yangilanadigan maydonlarni tayyorlaydi. Bo'sh qiymat
// mavjud ma'lumotni o'chirib yubormasligi uchun faqat haqiqiy
// qiymatlar $set'ga kiritiladi.
const mapGcpUpdate = (gcpData) => {
  const person = gcpData.data ?? {};
  const document = person.documents?.[0];
  const { series, number } = splitDocument(person.current_document);

  const candidates = {
    fullName: person.full_name,
    birthDate: toDottedDate(person.birth_date),
    document: person.current_document,
    documentSeries: series,
    documentNumber: number,
    documentType: shortenDocumentType(document?.type),
    pinfl: person.current_pinfl != null ? String(person.current_pinfl) : null,
  };

  const update = { gcpData, gcpSyncedAt: new Date() };

  for (const [field, value] of Object.entries(candidates)) {
    if (value !== null && value !== undefined && value !== "") {
      update[field] = value;
    }
  }

  return update;
};

// FHDYO javobidan yangilanadigan maydonlarni tayyorlaydi.
const mapBirthCertUpdate = (response) => {
  const person = extractBirthCertPerson(response);
  if (!person) return null;

  const candidates = {
    fullName: joinName(person.surname, person.name, person.patronym),
    birthDate: person.birth_date,
    documentSeries: person.cert_series,
    documentNumber: person.cert_number,
    document:
      person.cert_series && person.cert_number
        ? `${person.cert_series}${person.cert_number}`
        : null,
    documentType: "Tug'ilganlik guvohnomasi",
    // Bolaga JSHSHIR berilgan bo'lsa — saqlaymiz. Shundan keyin u
    // GCP orqali ham tekshiriladi (pasport olgan bo'lishi mumkin).
    pinfl: person.pinfl != null ? String(person.pinfl) : null,
    fatherFullName: joinName(
      person.father_surname,
      person.father_name,
      person.father_patronym,
    ),
    fatherPinfl: person.father_pinfl != null ? String(person.father_pinfl) : null,
    fatherBirthDate: person.father_birth_date,
    motherFullName: joinName(
      person.mother_surname,
      person.mother_name,
      person.mother_patronym,
    ),
    motherPinfl: person.mother_pinfl != null ? String(person.mother_pinfl) : null,
    motherBirthDate: person.mother_birth_date,
  };

  const update = { birthCertData: response, birthCertSyncedAt: new Date() };

  for (const [field, value] of Object.entries(candidates)) {
    if (value !== null && value !== undefined && value !== "") {
      update[field] = value;
    }
  }

  return update;
};

// Hujjat seriyasi/raqamini har safar `document` dan qayta hisoblaymiz.
// DB'dagi tayyor documentSeries/documentNumber eski import paytidagi
// (kamroq formatni biladigan) mantiq bilan to'ldirilgan bo'lishi
// mumkin — masalan "T45759099" uchun seriya null bo'lib qolgan.
const documentParts = (citizen) => {
  const parsed = splitDocument(citizen.document);
  if (parsed.series) return parsed;

  // `document` bo'sh bo'lsa, saqlangan maydonlarga qaytamiz.
  return {
    series: citizen.documentSeries ?? null,
    number: citizen.documentNumber ?? null,
  };
};

// JSHSHIR yo'q va hujjati aynan TUG'ILGANLIK GUVOHNOMASI bo'lsa —
// FHDYO bazasidan qidiramiz. Pasport seriyasini (AA, AB, AE...)
// yuborish mantiqsiz: FHDYO faqat guvohnomalarni biladi va har
// safar "Ma'lumot topilmadi" qaytaradi.
const needsBirthCert = (citizen) => {
  if (citizen.pinfl) return false;

  const { series, number } = documentParts(citizen);
  return Boolean(number) && isBirthCertificate(series);
};

/**
 * Berilgan yozuvlarni ketma-ket yangilaydi. Bitta yozuv xato bersa
 * ham qolganlari davom etadi — butun jarayon to'xtamasin.
 */
const syncCitizens = async (user, citizens) => {
  const key = citizenSyncKey(user.uid);
  const total = citizens.length;
  startSync(key, total);

  console.log(`[Fuqarolar sync] boshlandi: ${total} ta yozuv`);

  try {
    for (const [index, citizen] of citizens.entries()) {
      const position = index + 1;
      const startedAt = Date.now();

      try {
        const isoBirthDate = toIsoDate(citizen.birthDate);
        if (!isoBirthDate) {
          throw new Error("Tug'ilgan sana noto'g'ri/yo'q");
        }

        let pinfl = citizen.pinfl;
        let viaBirthCert = false;

        // 1-bosqich: JSHSHIR yo'q bo'lsa, guvohnoma bazasidan
        // qidiramiz — u JSHSHIR va ota-ona ma'lumotini qaytaradi.
        if (needsBirthCert(citizen)) {
          const { series, number } = documentParts(citizen);
          const certResponse = await fetchBirthCertData(
            series,
            number,
            isoBirthDate,
            key,
          );

          const certUpdate = mapBirthCertUpdate(certResponse);
          if (!certUpdate) {
            throw new Error(
              certResponse?.message || "Guvohnoma bo'yicha ma'lumot topilmadi",
            );
          }

          await Citizen.updateOne({ _id: citizen._id }, { $set: certUpdate });
          pinfl = certUpdate.pinfl ?? null;
          viaBirthCert = true;
        }

        if (!pinfl) {
          if (viaBirthCert) {
            // Guvohnoma topildi, lekin JSHSHIR hali berilmagan —
            // bu xato emas, GCP bosqichi o'tkazib yuboriladi.
            tickSync(key);
            console.log(
              `[Fuqarolar sync] ${position}/${total} — OK guvohnoma, JSHSHIR yo'q (${citizen.fullName}) ${Date.now() - startedAt}ms`,
            );
            continue;
          }
          // Pasporti bor, lekin JSHSHIR yo'q: GCP faqat JSHSHIR
          // bo'yicha qidiradi, FHDYO esa faqat guvohnomani biladi —
          // ya'ni bu yozuvni hech qaysi baza orqali topib bo'lmaydi.
          // Excel yangilanmaguncha javob o'zgarmaydi, shuning uchun
          // belgilab qo'yamiz va boshqa so'ramaymiz.
          const reason = citizen.document
            ? `JSHSHIR yo'q, hujjati esa guvohnoma emas (${citizen.document}) — qidirib bo'lmaydi`
            : "JSHSHIR ham, tug'ilganlik guvohnomasi ham yo'q";

          await Citizen.updateOne(
            { _id: citizen._id },
            { $set: { documentExpired: true, documentExpiredAt: new Date() } },
          );

          tickSync(key, {
            failed: true,
            error: {
              recordId: String(citizen._id),
              fullName: citizen.fullName,
              reason,
            },
          });
          console.log(
            `[Fuqarolar sync] ${position}/${total} — QIDIRIB BO'LMAYDI (${citizen.fullName}) ${Date.now() - startedAt}ms`,
          );
          continue;
        }

        // 2-bosqich: JSHSHIR ma'lum — pasport bazasidan so'raymiz.
        const gcpData = await fetchGcpData(pinfl, isoBirthDate, key);

        if (!gcpData || gcpData.code !== 0) {
          if (viaBirthCert) {
            // Bola hali pasport olmagan — guvohnoma yetarli.
            tickSync(key);
            console.log(
              `[Fuqarolar sync] ${position}/${total} — OK guvohnoma (pasport hali yo'q) (${citizen.fullName}) ${Date.now() - startedAt}ms`,
            );
            continue;
          }

          // Vafot etgan shaxs — javob hech qachon o'zgarmaydi.
          // Qayta so'ramaslik uchun "eskirgan" deb belgilaymiz.
          if (isDeceased(gcpData) || isExpiredDocument(gcpData)) {
            await Citizen.updateOne(
              { _id: citizen._id },
              {
                $set: {
                  documentExpired: true,
                  documentExpiredAt: new Date(),
                  gcpData,
                },
              },
            );

            tickSync(key);
            console.log(
              `[Fuqarolar sync] ${position}/${total} — HUJJATI ESKIRGAN (${citizen.fullName}) ${Date.now() - startedAt}ms`,
            );
            continue;
          }

          throw new Error(gcpData?.message || "GCP'da ma'lumot topilmadi");
        }

        await Citizen.updateOne(
          { _id: citizen._id },
          { $set: mapGcpUpdate(gcpData) },
        );

        tickSync(key);
        console.log(
          `[Fuqarolar sync] ${position}/${total} — OK${viaBirthCert ? " guvohnoma→pasport" : ""} (${citizen.fullName ?? pinfl}) ${Date.now() - startedAt}ms`,
        );
      } catch (err) {
        // Tarmoq uzilgan bo'lsa — yozuvning aybi yo'q, aloqa
        // tiklanishini kutamiz. Uzilish bir necha soniya davom etsa,
        // aks holda o'nlab yozuv bekorga "xato" bo'lib qolardi.
        if (isNetworkError(err)) {
          console.log(
            `[Fuqarolar sync] ${position}/${total} — tarmoq uzildi (${err.code}), 15 soniya kutilmoqda...`,
          );
          setSyncWaiting(key, Date.now() + 15000);
          await pause(15000);
          setSyncWaiting(key, null);
        }

        const reason =
          err.response?.data?.message || err.message || "Noma'lum xatolik";

        console.log(
          `[Fuqarolar sync] ${position}/${total} — XATO (${citizen.fullName ?? citizen.pinfl}): ${reason} ${Date.now() - startedAt}ms`,
        );

        tickSync(key, {
          failed: true,
          error: {
            recordId: String(citizen._id),
            fullName: citizen.fullName,
            pinfl: citizen.pinfl,
            reason,
          },
        });
      }
    }

    const failed = getSyncProgress(key)?.failed ?? 0;
    console.log(
      `[Fuqarolar sync] tugadi: ${total} tadan ${total - failed} tasi muvaffaqiyatli`,
    );
    finishSync(key);
  } catch (err) {
    failSync(key, err.message);
  }
};

/**
 * Yangilashni background'da boshlaydi.
 *
 * Query parametrlari:
 *   onlyMissing=true  — hali hech qaysi manbadan yangilanmaganlar
 *   mahalla=<key>     — faqat shu mahalla fuqarolari
 *   limit=<n>         — bir yurishda nechta (standart 2000)
 */
export const startCitizenSync = async (req, res) => {
  const user = getRequestUser();
  if (!user) return res.status(401).json({ message: "Access key noto'g'ri" });

  const key = citizenSyncKey(user.uid);
  if (isSyncRunning(key)) {
    return res.status(409).json({ message: "Yuklash allaqachon ketmoqda" });
  }

  try {
    // Hujjati eskirganlarga qayta so'rov yubormaymiz.
    const filter = { documentExpired: { $ne: true } };

    if (req.query.onlyMissing === "true") {
      filter.gcpSyncedAt = null;
      filter.birthCertSyncedAt = null;
    }

    const limit = Math.min(
      Number.parseInt(req.query.limit, 10) || MAX_BATCH,
      MAX_BATCH,
    );

    // Mahalla bo'yicha cheklov. Manzil erkin matn bo'lgani uchun
    // uni so'rov ichida filtrlab bo'lmaydi — avval mos manzillar
    // ro'yxatini aniqlab, keyin shular bo'yicha so'raymiz. (Yozuvlarni
    // olib, keyin ajratish ishlamaydi: bitta mahalla yozuvlari
    // faylning o'rtasida bo'lishi mumkin va limitga tushmay qoladi.)
    if (req.query.mahalla) {
      const wanted = String(req.query.mahalla);
      const addresses = await Citizen.distinct("address");
      const matched = addresses.filter((address) => {
        const name = extractMahallaName(address);
        return name ? mahallaKey(name) === wanted : false;
      });

      if (!matched.length) {
        return res.status(404).json({ message: "Mahalla topilmadi" });
      }

      filter.address = { $in: matched };
    }

    const citizens = await Citizen.find(filter)
      .sort({ rowNumber: 1, _id: 1 })
      .limit(limit)
      .lean();

    if (!citizens.length) {
      return res.status(200).json({ message: "Yangilanadigan yozuv yo'q" });
    }

    // Background'da ishga tushiramiz, javobni kutmaymiz.
    syncCitizens(user, citizens);

    return res.status(202).json({ total: citizens.length });
  } catch {
    return res.status(500).json({ message: "Server xatoligi" });
  }
};

/**
 * Joriy yangilash progressi.
 */
export const getCitizenSyncStatus = async (req, res) => {
  const user = getRequestUser();
  if (!user) return res.status(401).json({ message: "Access key noto'g'ri" });

  const progress = getSyncProgress(citizenSyncKey(user.uid));
  if (!progress) {
    return res.status(200).json({ status: "idle" });
  }

  return res.status(200).json(progress);
};
