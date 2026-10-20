/**
 * Familiyani taqqoslash uchun bitta shaklga keltirish.
 *
 * "Kadastrsiz boshlash" rejimida fuqaro xonadonga FAMILIYASI
 * bo'yicha moslanadi: platformadagi xonadon egasi "ERGASHEV
 * SUXBATJON ABDULLA O'G'LI" bo'lsa, kadastrsiz bazadagi "ERGASHEV
 * XUDOYBERDI SUXBATJON O'G'LI" aynan shu xonadonga tushishi kerak —
 * ular bir oila.
 *
 * Muammo shundaki, bitta familiya manbadan manbaga turlicha
 * yoziladi:
 *   platforma (kirill):   "ЭРГАШЕВ", "ЕРГАШЕВ"
 *   Excel (lotin):        "ERGASHEV", "ERGASHOV"
 *   apostrof shakllari:   "O`G`LI", "O'G'LI", "Oʻgʻli"
 *
 * Shuning uchun taqqoslash ASL MATN bo'yicha emas, `mahallaKey` ga
 * o'xshash "kalit" bo'yicha ketadi: kirill lotinga o'tkaziladi va
 * manbada aralash ishlatiladigan tovushlar birlashtiriladi.
 *
 * `mahalla.js` dagi `mahallaKey` qayta ishlatilmadi: u A ni ham E
 * ni ham bitta harfga aylantiradi ("ERGASHEV" -> "ARGASHAV"), bu
 * mahalla nomlari uchun to'g'ri (ro'yxat qisqa, to'qnashuv yo'q),
 * lekin familiyada xato beradi — "KARIMOV" bilan "KORIMOV" dan
 * tashqari "KERIMOV" ham qo'shilib ketardi. Familiyalar ro'yxati
 * esa minglab, to'qnashuv ehtimoli yuqori.
 */

import { transliterate } from "./mahalla.js";

// Erkak/ayol qo'shimchalari — familiyaning o'zi emas, shuning uchun
// taqqoslashdan oldin olib tashlanadi: "ERGASHEVA" ayol, "ERGASHEV"
// erkak, lekin OILA bitta.
const GENDER_SUFFIX = /(OVA|EVA|OV|EV|OVICH|EVICH|OVNA|EVNA)$/;

/**
 * Taqqoslash kaliti. Bo'sh/noaniq qiymat uchun null.
 */
export const surnameKey = (value) => {
  let key = transliterate(value)
    // Apostrof va chiziqchaning har qanday shakli — ma'no tashimaydi.
    .replace(/[^A-Z0-9]/g, "")
    // Manbada aralash keladigan tovushlar.
    .replace(/Q/g, "K")
    .replace(/H/g, "X")
    .replace(/W/g, "V")
    // O va U: "ПОЛВОНКЎЛ"/"ПОЛВОНКУЛ" kabi almashinuv familiyada ham
    // uchraydi ("YUSUPOV"/"YUSOPOV").
    .replace(/U/g, "O")
    // Unli oldidagi/orasidagi Y — yozilishi beqaror tovush:
    // "SAIDOV"/"SAYIDOV", "ALIEV"/"ALIYEV", "SAFAROV"/"SAFARYOV".
    // Ikki unli orasida yoki unlidan keyin so'z oxirida tushiriladi;
    // so'z boshidagi Y qoladi ("YUSUPOV" o'zakni boshlaydi).
    .replace(/(?<=[AOIE])Y(?=[AOIE]|$)/g, "")
    // Takroriy harf: "ABDULLAEV"/"ABDULLLAEV" kabi terish xatosi.
    .replace(/(.)\1+/g, "$1");

  if (!key) return null;

  // Qo'shimchani olib tashlaymiz — lekin faqat o'zak qolsa.
  // "OVA" ning o'zi familiya bo'lishi mumkin emas, ammo qisqa
  // familiyada ("OROV") o'zakni butunlay yo'q qilib qo'ymasin.
  const stem = key.replace(GENDER_SUFFIX, "");
  if (stem.length >= 3) key = stem;

  // Juda qisqa kalit ishonchsiz: tasodifiy mos kelib, odam butunlay
  // boshqa oilaga tushib qolardi.
  return key.length >= 3 ? key : null;
};

/**
 * To'liq F.I.Sh. dan familiyani ajratadi.
 *
 * Ikkala manbada ham tartib bir xil: FAMILIYA ISM SHARIF
 * ("ABDIXOKIMOV ABDULLOH ABDILAZIZ O`G`LI") — ya'ni familiya
 * birinchi so'z.
 */
export const extractLastName = (fullName) => {
  const text = String(fullName ?? "").trim();
  if (!text) return null;

  const first = text.split(/\s+/)[0];
  return first || null;
};

/**
 * To'liq F.I.Sh. dan to'g'ridan-to'g'ri taqqoslash kaliti.
 */
export const fullNameSurnameKey = (fullName) =>
  surnameKey(extractLastName(fullName));
