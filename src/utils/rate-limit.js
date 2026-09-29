export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Berilgan funksiyani (odatda tashqi API chaqiruvini) rate-limit'ga
 * qarshi himoya bilan bajaradi:
 *  - har chaqiruvdan oldin belgilangan miqdorda kutadi (throttle),
 *  - 429 (Too Many Requests) kelsa, eksponensial backoff bilan qayta
 *    urinadi (Retry-After headeri bo'lsa, o'shani hurmat qiladi).
 */
export const withRateLimit = async (
  fn,
  { delayMs = 300, maxRetries = 4 } = {},
) => {
  if (delayMs > 0) await sleep(delayMs);

  let attempt = 0;

  while (true) {
    try {
      return await fn();
    } catch (err) {
      const status = err.response?.status;

      if (status !== 429 || attempt >= maxRetries) {
        throw err;
      }

      const retryAfterHeader = err.response?.headers?.["retry-after"];
      const retryAfterMs = retryAfterHeader
        ? Number(retryAfterHeader) * 1000
        : null;

      const backoffMs = retryAfterMs ?? delayMs * 2 ** attempt;
      await sleep(backoffMs);
      attempt += 1;
    }
  }
};
