/**
 * Davlat bazalaridan (GCP — pasport, FHDYO — tug'ilganlik guvohnomasi)
 * kelgan javoblarni o'qish uchun umumiy yordamchilar.
 *
 * Bu mantiq xom ma'lumot va umumiy fuqarolar bazasida bir xil
 * ishlatiladi, shuning uchun bitta joyda turadi — biridagi tuzatish
 * ikkinchisiga ham tegsin.
 */

// "DD.MM.YYYY" -> "YYYY-MM-DD" (API shu formatni kutadi).
export const toIsoDate = (date) => {
  const match = String(date ?? "").match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!match) return null;

  const [, day, month, year] = match;
  return `${year}-${month}-${day}`;
};

// "YYYY-MM-DD" -> "DD.MM.YYYY" (bazada shu formatda saqlanadi).
export const toDottedDate = (isoDate) => {
  const match = String(isoDate ?? "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return isoDate ?? null;

  const [, year, month, day] = match;
  return `${day}.${month}.${year}`;
};

// GCP hujjat turini uzun rasmiy nom bilan qaytaradi
// ("O'zbekiston Respublikasi fuqarosining ID-kartasi"). Qisqa va
// bir xil shaklga keltiramiz.
export const shortenDocumentType = (type) => {
  if (!type) return null;
  if (/ID[- ]?karta/i.test(type)) return "ID karta";
  if (/pasport|passport/i.test(type)) return "Passport";
  if (/gu?vohnoma/i.test(type)) return "Tug'ilganlik guvohnomasi";
  return type;
};

// Hujjatni seriya va raqamga ajratadi. Manbada yozilish juda xilma-xil:
//   "AE8520186"     -> AE     + 8520186  (pasport / ID karta)
//   "I-AN0833845"   -> I-AN   + 0833845  (tug'ilganlik guvohnomasi)
//   "IAN0467568"    -> I-AN   + 0467568  (chiziqchasiz yozilgan)
//   "I-AN<tab>1004" -> I-AN   + 1004     (ichida tab/bo'shliq)
//   "I-AN№0706778"  -> I-AN   + 0706778  (№ belgisi bilan)
//   "T42920371"     -> T      + 42920371 (elektron guvohnoma, chaqaloqlar)
export const splitDocument = (document) => {
  // Bo'shliq, tab va "№" belgisini tashlaymiz — ular ajratishga xalaqit
  // beradi, lekin ma'no tashimaydi.
  const value = String(document ?? "")
    .trim()
    .replace(/[\s №#]/g, "");
  if (!value) return { series: null, number: null };

  // Guvohnoma: rim raqami + ikki harf. Chiziqcha bo'lmasligi mumkin.
  const cert = value.match(/^([IVX]{1,4})-?([A-Z]{2})(\d+)$/i);
  if (cert) {
    return {
      series: `${cert[1].toUpperCase()}-${cert[2].toUpperCase()}`,
      number: cert[3],
    };
  }

  // Elektron guvohnoma: bitta "T" harfi + raqam (odatda chaqaloqlar).
  const temporary = value.match(/^(T)(\d{6,})$/i);
  if (temporary) {
    return { series: temporary[1].toUpperCase(), number: temporary[2] };
  }

  const passport = value.match(/^([A-Z]{2})(\d{7})$/i);
  if (passport) {
    return { series: passport[1].toUpperCase(), number: passport[2] };
  }

  return { series: null, number: document ?? null };
};

// Hujjat tug'ilganlik guvohnomasimi? Faqat shunday hujjat bilan FHDYO
// bazasiga murojaat qilish mumkin — pasport seriyasini (AA, AB, AE...)
// yuborish har doim "Ma'lumot topilmadi" beradi.
export const isBirthCertificate = (series) => {
  const value = String(series ?? "").trim().toUpperCase();
  if (!value) return false;

  // "I-AN", "III-AN" kabi rim raqamli seriya yoki elektron "T".
  return /^[IVX]{1,4}-[A-Z]{2}$/.test(value) || value === "T";
};

// FHDYO javobi ko'p qavatli. api interceptor birinchi qavatni,
// so'rov funksiyasi ikkinchisini ochadi — shundan keyin haqiqiy
// ma'lumot `info.data` ichida bo'ladi.
export const extractBirthCertPerson = (response) =>
  response?.info?.data ?? response?.data?.info?.data ?? null;

// FHDYO ismni uch bo'lakda qaytaradi.
export const joinName = (surname, name, patronym) =>
  [surname, name, patronym]
    .map((part) => String(part ?? "").trim())
    .filter(Boolean)
    .join(" ")
    .toUpperCase() || null;

// GCP shaxsni topdi, lekin amaldagi hujjati yaroqsiz (muddati o'tgan).
// Odam hujjatini yangilamaguncha javob o'zgarmaydi.
export const isExpiredDocument = (gcpData) => {
  const message = String(gcpData?.message ?? "");
  return /doc_status\s*=\s*(Yaroqsiz hujjat|Yaroqli hujjat yo)/i.test(message);
};
