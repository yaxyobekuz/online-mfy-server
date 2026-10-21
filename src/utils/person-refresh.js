/**
 * Shaxsni davlat bazalaridan (GCP — pasport/ID, FHDYO — tug'ilganlik
 * guvohnomasi) SO'NGGI ma'lumoti bilan yangilash uchun umumiy util.
 *
 * Bu mantiq ikki joyda kerak:
 *   1) "Fuqarolar sync" (citizen-sync.controller.js) — butun bazani
 *      bo'laklab yangilaydi;
 *   2) Ro'yxatga olish ishchisi (registration-worker.js) — "Ba'tafsil"
 *      va "Aqilli" uslublarda har fuqaroni kiritishdan oldin/keyin
 *      so'nggi ma'lumotni oladi.
 *
 * Ikkalasi bir xil endpoint va bir xil normalizatsiyadan foydalanishi
 * uchun mantiq shu yerda yagona turadi — biridagi tuzatish ikkinchisiga
 * ham tegsin.
 *
 * Rate-limit bu yerda QATTIQ bog'lanmaydi: har bir chaqiruvchi o'z
 * `rateLimit(fn)` wrapper'ini uzatadi (sync — withRateLimit+logWait,
 * worker — rateLimited(run, fn)). Shunday qilib har kim o'z progress /
 * kutish hisoblagichini saqlaydi va dublikat limit qatlami bo'lmaydi.
 */

import api from "../config/api.js";
import {
  toIsoDate,
  toDottedDate,
  shortenDocumentType,
  splitDocument,
  extractBirthCertPerson,
  joinName,
  isExpiredDocument,
  isBirthCertificate,
} from "./person-data.js";

// GCP ba'zan haqiqiy sababni bermasdan "Internal Server Error"
// qaytaradi — bu vaqtinchalik nosozlik. Tajriba: 5 tadan 4 tasi qayta
// so'ralganda hal bo'ladi (yo ma'lumot, yo aniq sabab chiqadi).
export const isTransientError = (gcpData) =>
  /Internal Server Error/i.test(String(gcpData?.message ?? ""));

// Shaxs vafot etgan — holat o'zgarmaydi, qayta so'rash befoyda.
export const isDeceased = (gcpData) =>
  /status_name\s*=\s*vafot etgan/i.test(String(gcpData?.message ?? ""));

// Tarmoq uzilishi (DNS, timeout, ulanish) — ma'lumotning emas,
// aloqaning muammosi.
const NETWORK_ERRORS = new Set([
  "ENOTFOUND", "ECONNRESET", "ETIMEDOUT", "ECONNREFUSED",
  "EAI_AGAIN", "ECONNABORTED", "EHOSTUNREACH", "ENETUNREACH",
]);

export const isNetworkError = (err) =>
  !err?.response && (NETWORK_ERRORS.has(err?.code) || err?.code === "ERR_NETWORK");

export const GCP_RETRIES = 3;

// Vaqtinchalik nosozlikdan keyin darhol qayta so'rasak, ko'pincha yana
// o'sha javob keladi. Qisqa tanaffus natijani sezilarli yaxshilaydi.
export const RETRY_PAUSE_MS = 1200;
export const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------
// Davlat bazasiga so'rovlar
//
// Har bir funksiya `rateLimit(fn)` wrapper'ini oladi — u fn ni
// (axios chaqiruvi) chegaralab bajaradi va axios javobini qaytaradi.
// ---------------------------------------------------------------

// JSHSHIR + sana bo'yicha pasport bazasidan (GCP).
const fetchGcpOnce = (pinfl, birthDate, rateLimit) =>
  rateLimit(() =>
    api.get("/api/v1/gcp/pinfl", {
      params: { pinfl, birth_date: birthDate, form_name: "survey_homes_family" },
    }),
  ).then((response) => response.data);

export const fetchGcpData = async (pinfl, birthDate, rateLimit) => {
  let last = null;

  for (let attempt = 1; attempt <= GCP_RETRIES; attempt++) {
    last = await fetchGcpOnce(pinfl, birthDate, rateLimit);

    // Javob aniq bo'lsa (muvaffaqiyat yoki tushunarli sabab) —
    // qayta so'rashning hojati yo'q.
    if (last?.code === 0 || !isTransientError(last)) return last;

    if (attempt < GCP_RETRIES) await pause(RETRY_PAUSE_MS);
  }

  return last;
};

// Pasport/ID seriya+raqam + sana bo'yicha GCP hujjat bazasidan.
//
// Nega alohida: JSHSHIR yo'q, lekin pasporti bor odam uchun GCP
// JSHSHIR bo'yicha qidira olmaydi. `gcp/document` esa seriya+raqam
// bo'yicha qidiradi va AYNAN `gcp/pinfl` kabi `data.{full_name,
// current_pinfl, current_document, documents[]}` qaytaradi — demak
// javob `mapGcpUpdate` bilan to'g'ridan-to'g'ri normalizatsiya qilinadi.
const fetchGcpDocumentOnce = (serial, number, birthDate, rateLimit) =>
  rateLimit(() =>
    api.get("/api/v1/gcp/document", {
      params: {
        serial,
        number,
        birth_date: birthDate,
        form_name: "survey_homes_family",
      },
    }),
  ).then((response) => response.data);

export const fetchGcpDocument = async (serial, number, birthDate, rateLimit) => {
  let last = null;

  for (let attempt = 1; attempt <= GCP_RETRIES; attempt++) {
    last = await fetchGcpDocumentOnce(serial, number, birthDate, rateLimit);
    if (last?.code === 0 || !isTransientError(last)) return last;
    if (attempt < GCP_RETRIES) await pause(RETRY_PAUSE_MS);
  }

  return last;
};

// Guvohnoma (seriya+raqam+sana) bo'yicha FHDYO bazasidan. Bolada
// JSHSHIR bo'lmagani uchun GCP uni topa olmaydi.
export const fetchBirthCertData = (series, number, birthDate, rateLimit) =>
  rateLimit(() =>
    api.get("/api/v2/fhdyo/act/birth", {
      params: { serial: series, number, birth_date: birthDate },
    }),
  ).then((response) => response.data);

// ---------------------------------------------------------------
// Javoblarni modelga yoziladigan $set shakliga keltirish
// ---------------------------------------------------------------

// GCP (pinfl yoki document) javobidan yangilanadigan maydonlar. Bo'sh
// qiymat mavjud ma'lumotni o'chirmasligi uchun faqat haqiqiy qiymatlar
// $set'ga kiritiladi.
export const mapGcpUpdate = (gcpData) => {
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

// FHDYO javobidan yangilanadigan maydonlar (bola + ota-ona).
export const mapBirthCertUpdate = (response) => {
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
    // Bolaga JSHSHIR berilgan bo'lsa — saqlaymiz.
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

// Hujjat seriyasi/raqamini har safar `document` dan qayta hisoblaymiz —
// DB'dagi tayyor maydonlar eski import mantig'i bilan to'ldirilgan
// bo'lishi mumkin (masalan "T45759099" uchun seriya null).
export const documentParts = (person) => {
  const parsed = splitDocument(person.document);
  if (parsed.series) return parsed;

  return {
    series: person.documentSeries ?? null,
    number: person.documentNumber ?? null,
  };
};

// JSHSHIR yo'q va hujjati aynan TUG'ILGANLIK GUVOHNOMASI bo'lsa — FHDYO
// bazasidan qidiramiz. Pasport seriyasini yuborish mantiqsiz.
export const needsBirthCert = (person) => {
  if (person.pinfl) return false;

  const { series, number } = documentParts(person);
  return Boolean(number) && isBirthCertificate(series);
};

/**
 * Bitta shaxsni davlat bazasidan so'nggi ma'lumoti bilan yangilaydi.
 *
 * Identifikatorga qarab manba tanlanadi:
 *   - JSHSHIR bor                 -> GCP (gcp/pinfl)
 *   - JSHSHIR yo'q + guvohnoma    -> FHDYO (fhdyo/act/birth)
 *   - JSHSHIR yo'q + pasport/ID   -> GCP (gcp/document)
 *
 * Qaytaradi:
 *   { update, source }              — yangilanadigan $set maydonlari
 *   { notFound: true, reason, expired? } — topilmadi yoki o'zgarmas sabab
 *
 * `update` — modelga yoziladigan $set. Chaqiruvchi uni Citizen yoki
 * UncadastredCitizen'ga yozadi (kerakli maydonlarni filtrlab).
 */
export const refreshPerson = async (person, { rateLimit }) => {
  const isoBirthDate = toIsoDate(person.birthDate);
  if (!isoBirthDate) {
    return { notFound: true, reason: "Tug'ilgan sana noto'g'ri yoki yo'q" };
  }

  // 1) JSHSHIR yo'q, hujjati guvohnoma — FHDYO.
  if (needsBirthCert(person)) {
    const { series, number } = documentParts(person);
    let certResponse;
    try {
      certResponse = await fetchBirthCertData(series, number, isoBirthDate, rateLimit);
    } catch (err) {
      // FHDYO topa olmaganda HTTP 400 (exception) qaytaradi.
      const reason =
        err.response?.data?.message ||
        err.message ||
        "Guvohnoma bo'yicha ma'lumot topilmadi";
      return { notFound: true, reason, raw: err.response?.data ?? null };
    }

    const certUpdate = mapBirthCertUpdate(certResponse);
    if (!certUpdate) {
      return {
        notFound: true,
        reason: certResponse?.message || "Guvohnoma bo'yicha ma'lumot topilmadi",
        raw: certResponse,
      };
    }

    return { update: certUpdate, source: "fhdyo", raw: certResponse };
  }

  // 2) JSHSHIR bor — GCP (pinfl).
  if (person.pinfl) {
    const gcpData = await fetchGcpData(String(person.pinfl), isoBirthDate, rateLimit);

    if (gcpData?.code === 0) {
      return { update: mapGcpUpdate(gcpData), source: "gcp", raw: gcpData };
    }

    if (isDeceased(gcpData) || isExpiredDocument(gcpData)) {
      return {
        notFound: true,
        expired: true,
        reason: isDeceased(gcpData)
          ? "Vafot etgan (davlat bazasi ma'lumoti)"
          : "Hujjati yaroqsiz / muddati o'tgan",
        raw: gcpData,
      };
    }

    return {
      notFound: true,
      reason: gcpData?.message || "Davlat bazasida ma'lumot topilmadi",
      raw: gcpData,
    };
  }

  // 3) JSHSHIR yo'q, hujjati pasport/ID — GCP (document).
  const { series, number } = documentParts(person);
  if (series && number) {
    const gcpData = await fetchGcpDocument(series, number, isoBirthDate, rateLimit);

    if (gcpData?.code === 0) {
      return { update: mapGcpUpdate(gcpData), source: "gcp-document", raw: gcpData };
    }

    if (isDeceased(gcpData) || isExpiredDocument(gcpData)) {
      return {
        notFound: true,
        expired: true,
        reason: isDeceased(gcpData)
          ? "Vafot etgan (davlat bazasi ma'lumoti)"
          : "Hujjati yaroqsiz / muddati o'tgan",
        raw: gcpData,
      };
    }

    return {
      notFound: true,
      reason: gcpData?.message || "Pasport bo'yicha ma'lumot topilmadi",
      raw: gcpData,
    };
  }

  return { notFound: true, reason: "JSHSHIR ham, hujjat ham yo'q" };
};

// Modeldagi mavjud maydonlarnigina $set'da qoldiradi (UncadastredCitizen
// Citizen'dagi barcha maydonlarga ega emas).
export const pickFields = (update, allowedKeys) => {
  const picked = {};
  for (const key of allowedKeys) {
    if (update[key] !== undefined) picked[key] = update[key];
  }
  return picked;
};
