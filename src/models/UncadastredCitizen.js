import mongoose from "mongoose";

const { Schema, model } = mongoose;

/**
 * KADASTRSIZ fuqarolar bazasi — umumiy bazadan (`Citizen`) ALOHIDA.
 *
 * Nega alohida kolleksiya: umumiy baza kadastr ustiga qurilgan —
 * jarayon odamni aynan kadastri bo'yicha xonadonga moslaydi
 * (`processHome`). Bu yerdagi ma'lumotda esa kadastr ODATDA YO'Q
 * (ba'zi yozuvlarda bo'lishi mumkin), buning o'rniga MFY, telefon,
 * qarindoshlik va hujjat ma'lumoti bor. Ikkisini bitta kolleksiyaga
 * qo'shsak:
 *   - kadastrsiz yozuvlar kadastr yurishining navbatiga tushmasdi,
 *     lekin "jami aholi" sonini shishirib yuborardi;
 *   - umumiy bazani almashtiradigan yuklash (`deleteMany({})`)
 *     kadastrsiz ma'lumotni ham o'chirib tashlardi.
 *
 * Ma'lumot GLOBAL (`Citizen` kabi): `userUid` yo'q. Ajratish MFY
 * GURUHI bo'yicha ketadi — har yozuv bitta guruhga tegishli.
 *
 * Excel ustunlari (fayldan faylga farq qiladi, shuning uchun
 * `uncadastred.controller.js` da bir nechta nom varianti
 * tekshiriladi): F.I.Sh. / Ism / Familiya / Sharif, tug'ilgan sana,
 * JSHSHIR, hujjat seriyasi va raqami, telefon, qarindoshlik, MFY.
 */
const uncadastredCitizenSchema = new Schema(
  {
    // --- Guruh (MFY) ---
    // Yozuv qaysi MFY guruhiga tegishli. O'chirish/ustiga yozish
    // AYNAN shu bo'yicha ketadi.
    groupId: {
      type: Schema.Types.ObjectId,
      ref: "UncadastredGroup",
      required: true,
      index: true,
    },

    // MFY nomi va kaliti — guruhdan ko'chirib yoziladi.
    //
    // Nega takrorlanadi: ro'yxat va qidiruv guruhga `$lookup`
    // qilmasdan ishlashi kerak (150 mingdan ortiq yozuv bo'lishi
    // mumkin), "Kadastrsiz boshlash" esa fuqarolarni to'g'ridan-to'g'ri
    // MFY kaliti bo'yicha oladi.
    mfyName: { type: String },
    mahallaKey: { type: String, index: true },

    // Excel'dagi tartib raqami (№)
    rowNumber: { type: Number },

    // --- F.I.Sh. ---
    // To'liq F.I.Sh. Fayl bo'laklab bergan bo'lsa (Familiya | Ism |
    // Sharif alohida ustun) shu uchtasidan yig'iladi — platforma
    // `full_name` ni yagona satr sifatida kutadi.
    fullName: { type: String, index: true },

    // Bo'laklari alohida ham saqlanadi: familiya bo'yicha moslash
    // (`Kadastrsiz boshlash`) aynan shu maydonga tayanadi.
    lastName: { type: String, index: true },
    firstName: { type: String },
    middleName: { type: String },

    // Familiyaning taqqoslash kaliti — kirill/lotin va O/U, Q/K
    // farqlarini yo'qotgan ko'rinishi (`utils/surname.js`).
    // Xonadon egasining familiyasi bilan solishtirishda ishlatiladi.
    lastNameKey: { type: String, index: true },

    // Tug'ilgan sana — "DD.MM.YYYY" (loyihadagi boshqa to'plamlar
    // bilan bir xil format).
    birthDate: { type: String },

    // JSHSHIR. Excel'da bo'sh yoki "#Н/Д" bo'lishi mumkin — bunday
    // holatda null saqlanadi.
    pinfl: { type: String, index: true },

    // --- Hujjat ---
    // Seriya va raqam birga ("AA6658639") hamda alohida.
    document: { type: String },
    documentSeries: { type: String },
    documentNumber: { type: String },

    // Telefon raqami — "998901234567" ko'rinishida saqlanadi.
    // Platformaga yuborishda shu ishlatiladi; bo'lmasa avto-generate
    // qilinadi (`utils/phone.js`).
    phone: { type: String },

    // --- Qarindoshlik ---
    // Excel'dagi asl matn ("O'g'li", "Турмуш ўртоғи").
    relationship: { type: String },
    // Platforma kodi (`RELATIONSHIP_CODES`). Topilmasa null —
    // yuborishda "Boshqa" (13) ishlatiladi.
    relationshipCode: { type: Number },

    // Kadastr — bu bazada ODATDA bo'sh, lekin ba'zi fayllarda
    // uchraydi. Bo'lsa, moslashda birinchi navbatda shu ishlatiladi.
    cadasterNumber: { type: String, index: true },

    // Manzil (fayl bergan bo'lsa)
    address: { type: String },

    // Excel qatorining asl ko'rinishi — kelajakda yangi ustun
    // chiqsa ham ma'lumot yo'qolmasligi uchun.
    raw: { type: Schema.Types.Mixed },
  },
  { timestamps: true },
);

// Sahifalash har doim shu tartibda ketadi.
uncadastredCitizenSchema.index({ groupId: 1, rowNumber: 1, _id: 1 });

// "Kadastrsiz boshlash" navbatini tuzish: guruh ichida familiya
// bo'yicha moslash.
uncadastredCitizenSchema.index({ groupId: 1, lastNameKey: 1 });

export default model("UncadastredCitizen", uncadastredCitizenSchema);
