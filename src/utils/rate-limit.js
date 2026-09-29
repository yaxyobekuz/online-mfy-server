export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Xato javobidan kutish vaqtini (millisekundda) aniqlaydi:
//  1. HTTP "Retry-After" headeri (soniyada) bo'lsa — o'shani ishlatadi;
//  2. bo'lmasa, xato xabari ichidagi "Retry after N seconds" matnini
//     qidiradi (ba'zi tashqi API'lar buni faqat matnda qaytaradi,
//     header'da emas — screenshot'da ko'rilgan holat);
//  3. ikkalasi ham topilmasa, ishonchli standart qiymatga tushadi.
const extractRetryAfterMs = (err, fallbackMs) => {
  const header = err.response?.headers?.["retry-after"];
  if (header) return Number(header) * 1000;

  const message =
    err.response?.data?.message ?? err.message ?? "";
  const match = String(message).match(/retry after (\d+(?:\.\d+)?)\s*second/i);
  if (match) return Number(match[1]) * 1000;

  return fallbackMs;
};

const MIN_DELAY_MS = 120;
const MAX_DELAY_MS = 3000;
const BACKOFF_MULTIPLIER = 2;
// Har nechta ketma-ket muvaffaqiyatli so'rovdan keyin throttle'ni
// bir bosqich pasaytiramiz (tashqi API'ning haqiqiy limitini
// bilmagani uchun, asta-sekin sinab ko'rish orqali topamiz).
const SUCCESS_STREAK_TO_SPEED_UP = 5;
const SPEED_UP_FACTOR = 0.85;

// Har bir mustaqil oqim (masalan "gcp:<userUid>") o'z throttle
// holatini saqlaydi — bittasining sekinlashishi boshqasiga ta'sir
// qilmasin, va keyingi chaqiruvlar oldingi tajribadan foydalansin.
const adaptiveStateByKey = new Map();

const getAdaptiveState = (key, initialDelayMs) => {
  if (!adaptiveStateByKey.has(key)) {
    adaptiveStateByKey.set(key, { delayMs: initialDelayMs, successStreak: 0 });
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

      if (state) {
        state.successStreak = 0;
        state.delayMs = Math.min(
          MAX_DELAY_MS,
          Math.round(state.delayMs * BACKOFF_MULTIPLIER),
        );
      }

      const waitMs = extractRetryAfterMs(err, fallbackRetryMs);
      onWait?.(Date.now() + waitMs);
      await sleep(waitMs);
      onWait?.(null);
      // Qayta uramiz — urinishlar soniga chegara yo'q.
    }
  }
};
