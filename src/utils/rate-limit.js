export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Xato javobidan kutish vaqtini (millisekundda) aniqlaydi:
//  1. HTTP "Retry-After" headeri (soniyada) bo'lsa — o'shani ishlatadi;
//  2. bo'lmasa, xato xabari ichidagi "Retry after N seconds" matnini
//     qidiradi (ba'zi tashqi API'lar buni faqat matnda qaytaradi,
//     header'da emas — screenshot'da ko'rilgan holat);
//  3. ikkalasi ham topilmasa, ishonchli standart qiymatga tushadi.
// Server "Retry after 0 seconds" deb qaytarishi mumkin (oyna yangilanish
// arafasida). Kutmasdan darhol qayta urinsak, ketma-ket 429'lar yog'ilib,
// API'ni bekorga uramiz — shuning uchun eng kam kutish chegarasi.
const MIN_RETRY_WAIT_MS = 1000;

const extractRetryAfterMs = (err, fallbackMs) => {
  const header = err.response?.headers?.["retry-after"];
  if (header) return Math.max(MIN_RETRY_WAIT_MS, Number(header) * 1000);

  const message =
    err.response?.data?.message ?? err.message ?? "";
  const match = String(message).match(/retry after (\d+(?:\.\d+)?)\s*second/i);
  if (match) return Math.max(MIN_RETRY_WAIT_MS, Number(match[1]) * 1000);

  return fallbackMs;
};

const MIN_DELAY_MS = 120;
// Tashqi GCP API amalda ~5 so'rov / ~56 soniya limitini qo'llaydi va
// limitga yetganda 56 soniyagacha bloklaydi. Shuning uchun throttle
// shuncha kattalasha olishi kerak — so'rovlarni teng taqsimlab
// yuborish (masalan har ~12 soniyada bitta) 429'ga umuman uchramaslik
// imkonini beradi: o'tkazuvchanlik bir xil qoladi, lekin uzun
// bloklanishlar va xatolar yo'qoladi.
const MAX_DELAY_MS = 30000;
// Har nechta ketma-ket muvaffaqiyatli so'rovdan keyin throttle'ni
// bir bosqich pasaytiramiz (tashqi API'ning haqiqiy limitini
// bilmagani uchun, asta-sekin sinab ko'rish orqali topamiz).
// Kamaytirish sekin (kichik qadam) bo'lishi kerak — aks holda
// tez-tez limitga qaytib tushib qolamiz.
const SUCCESS_STREAK_TO_SPEED_UP = 10;
const SPEED_UP_FACTOR = 0.9;

// Har bir mustaqil oqim (masalan "gcp:<userUid>") o'z throttle
// holatini saqlaydi — bittasining sekinlashishi boshqasiga ta'sir
// qilmasin, va keyingi chaqiruvlar oldingi tajribadan foydalansin.
const adaptiveStateByKey = new Map();

const getAdaptiveState = (key, initialDelayMs) => {
  if (!adaptiveStateByKey.has(key)) {
    adaptiveStateByKey.set(key, {
      delayMs: initialDelayMs,
      successStreak: 0,
      // Muvaffaqiyatli so'rovlarning vaqt shtamplari. 429 kelganda
      // server aytgan kutish vaqti — oynaning qolgan qismi, shuning
      // uchun sig'imni o'sha oyna ichiga tushgan so'rovlar soni bo'yicha
      // hisoblaymiz (oxirgi 429'dan beri emas — aks holda 1 ta so'rovni
      // butun oynaga bo'lib, throttle keskin oshib ketardi).
      successTimestamps: [],
    });
  }
  return adaptiveStateByKey.get(key);
};

/**
 * Berilgan funksiyani (odatda tashqi API chaqiruvini) bitta so'rov
 * ketma-ket, boshqasi tugagach yuboriladigan qilib bajaradi:
 *  - har chaqiruvdan oldin tanaffus (delayMs) qo'yiladi — ketma-ket
 *    yuklashda ham so'rovlar tashqi API'ga "parallel"ga o'xshab
 *    tez-tez kelib qolmasligi uchun;
 *  - `adaptiveKey` berilsa, tanaffus statik emas, moslashuvchan
 *    bo'ladi: bir nechta muvaffaqiyatli so'rovdan keyin asta-sekin
 *    tezlashadi (MIN_DELAY_MS'gacha), 429'ga uchrasa esa darhol
 *    ikki baravar sekinlashadi (MAX_DELAY_MS'gacha) — shu bilan
 *    tashqi API'ning haqiqiy limitini oldindan bilmasdan ham eng
 *    tez xavfsiz tezlikka moslashadi;
 *  - 429 (rate limit) kelsa, server ko'rsatgan "Retry-After" vaqtiga
 *    qarab kutadi va CHEKSIZ qayta uradi — bu vaqtinchalik holat,
 *    yozuvni xato deb hisoblab o'tkazib yubormaslik kerak;
 *  - boshqa har qanday xato (404, 500, ...) darhol yuqoriga uzatiladi,
 *    qayta urinilmaydi.
 *
 * `onWait(untilTimestampMs | null)` — 429'ga uchraganda kutish
 * boshlanganini (tugash vaqti bilan) va tugaganda (null bilan)
 * bildiradi. Progress-tracker'ga ulash uchun ixtiyoriy.
 */
export const withRateLimit = async (
  fn,
  { delayMs = 400, fallbackRetryMs = 5000, onWait, adaptiveKey } = {},
) => {
  const state = adaptiveKey ? getAdaptiveState(adaptiveKey, delayMs) : null;
  const currentDelay = state ? state.delayMs : delayMs;

  if (currentDelay > 0) await sleep(currentDelay);

  while (true) {
    try {
      const result = await fn();

      if (state) {
        state.successStreak += 1;
        state.successTimestamps.push(Date.now());
        if (state.successStreak >= SUCCESS_STREAK_TO_SPEED_UP) {
          state.successStreak = 0;
          state.delayMs = Math.max(
            MIN_DELAY_MS,
            Math.round(state.delayMs * SPEED_UP_FACTOR),
          );
        }
      }

      return result;
    } catch (err) {
      const status = err.response?.status;

      if (status !== 429) {
        throw err;
      }

      const waitMs = extractRetryAfterMs(err, fallbackRetryMs);

      if (state) {
        state.successStreak = 0;

        // Server aytgan kutish vaqti — joriy oynaning qolgan qismi,
        // ya'ni oyna uzunligi shundan katta emas. Shu oyna ichiga
        // tushgan muvaffaqiyatli so'rovlarni sanab, API'ning sig'imini
        // (N so'rov / oyna) topamiz va so'rovlarni oynaga teng
        // taqsimlaymiz (oyna / N). Shunda 429'ga umuman uchramaymiz:
        // o'tkazuvchanlik o'sha-o'sha, lekin uzun bloklanishlar
        // yo'qoladi va progress silliq boradi.
        const now = Date.now();
        const windowStart = now - waitMs;
        const inWindow = state.successTimestamps.filter(
          (ts) => ts >= windowStart,
        ).length;

        if (inWindow > 0) {
          state.delayMs = Math.min(
            MAX_DELAY_MS,
            Math.round(waitMs / inWindow),
          );
        }

        // Oynadan chiqib ketgan eski yozuvlarni tashlab yuboramiz —
        // ro'yxat cheksiz o'smasin.
        state.successTimestamps = state.successTimestamps.filter(
          (ts) => ts >= windowStart,
        );
      }

      onWait?.(Date.now() + waitMs);
      await sleep(waitMs);
      onWait?.(null);
      // Qayta uramiz — urinishlar soniga chegara yo'q.
    }
  }
};
