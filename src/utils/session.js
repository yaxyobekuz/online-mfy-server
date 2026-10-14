import crypto from "node:crypto";

/**
 * Oddiy, imzolangan sessiya tokeni — tashqi kutubxonasiz.
 *
 * Nega JWT emas: bizda bitta parol va bitta "admin" bor, rollar yoki
 * da'volar yo'q. Shuning uchun `payload.sig` ko'rinishidagi HMAC
 * yetarli — Node'ning o'z `crypto` moduli bilan.
 *
 * Token ichida faqat yaroqlilik muddati bor. Imzo `SESSION_SECRET`
 * bilan tekshiriladi: sir o'zgarsa yoki muddati o'tsa — token
 * yaroqsiz.
 */

const secret = () => process.env.SESSION_SECRET || "insecure-dev-secret";

// Sessiya qancha amal qiladi (7 kun).
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

const sign = (data) =>
  crypto.createHmac("sha256", secret()).update(data).digest("base64url");

/**
 * Yangi sessiya tokeni yaratadi.
 */
export const createSession = () => {
  const payload = JSON.stringify({ exp: Date.now() + TTL_MS });
  const body = Buffer.from(payload).toString("base64url");
  return `${body}.${sign(body)}`;
};

/**
 * Tokenni tekshiradi. Yaroqli bo'lsa `true`, aks holda `false`.
 */
export const verifySession = (token) => {
  if (!token || typeof token !== "string") return false;

  const [body, sig] = token.split(".");
  if (!body || !sig) return false;

  // Imzo mosmi (vaqt bo'yicha barqaror taqqoslash).
  const expected = sign(body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;

  try {
    const { exp } = JSON.parse(Buffer.from(body, "base64url").toString());
    return typeof exp === "number" && exp > Date.now();
  } catch {
    return false;
  }
};

/**
 * Kiritilgan parol serverning parolига mosmi.
 */
export const checkPassword = (password) => {
  const expected = process.env.ADMIN_PASSWORD || "";
  if (!expected) return false;

  const a = Buffer.from(String(password ?? ""));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
