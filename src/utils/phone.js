/**
 * Tasodifiy O'zbek mobil raqami yaratish.
 *
 * Qo'shimcha a'zolarni platformaga qo'shishda telefon majburiy
 * bo'lishi mumkin. A'zoning o'z raqami bo'lsa, o'sha ishlatiladi;
 * bo'lmasa shu funksiya yaroqli ko'rinishdagi tasodifiy raqam
 * qaytaradi.
 *
 * Format: 998 + operator kodi + 7 raqam = 12 raqamli ("998901234567").
 */

// O'zbekistondagi haqiqiy mobil operator kodlari.
const OPERATOR_CODES = [
  "90",
  "91",
  "93",
  "94",
  "95",
  "97",
  "98",
  "99",
  "88",
  "33",
  "77",
];

const randomDigits = (n) => {
  let out = "";
  for (let i = 0; i < n; i += 1) out += Math.floor(Math.random() * 10);
  return out;
};

export const randomUzPhone = () => {
  const code = OPERATOR_CODES[Math.floor(Math.random() * OPERATOR_CODES.length)];
  return `998${code}${randomDigits(7)}`;
};

/**
 * Berilgan raqam yaroqli ko'rinishdami (kamida 9 raqam). Aks holda
 * null qaytaradi — chaqiruvchi avto-generate qiladi.
 */
export const normalizePhone = (value) => {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (digits.length < 9) return null;
  // 9 xonali bo'lsa (operator kodidan boshlangan) — 998 qo'shamiz.
  if (digits.length === 9) return `998${digits}`;
  return digits;
};
