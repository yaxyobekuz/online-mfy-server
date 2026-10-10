import mongoose from "mongoose";

const { Schema, model } = mongoose;

/**
 * Foydalanuvchi tomonidan Excel fayl orqali qo'lda yuklangan xom
 * ma'lumot (masalan yakuniy_royxat.xlsx). Tashqi API'ga bog'liq emas —
 * faqat shu foydalanuvchiga tegishli holda saqlanadi.
 *
 * Excel ustunlari: №, FISh, Kadastr raqami, Qarindoshligi, JSHSHR,
 * Hujjat turi, Hujjat seriyasi, Hujjat raqami, Tel raqam,
 * Kadastr manbasi, Tug'ilgan sana.
 */
const rawRecordSchema = new Schema(
  {
    // Excel'dagi tartib raqami (№)
    rowNumber: { type: Number },

    fullName: { type: String },
    cadasterNumber: { type: String },

    // Kadastr aniq bo'lmagan hollarda (odatda bolalar — ular davlat
    // reyestrida yo'q, kadastr oila a'zosidan olinadi) bir nechta
    // ehtimoliy variant bo'ladi. cadasterNumber — eng ishonchlisi,
    // bu yerda esa qolganlari ishonch tartibida turadi: asosiysi mos
    // kelmasa, shular bilan tekshirib ko'riladi.
    alternateCadasters: { type: [String], default: undefined },

    relationship: { type: String },
    pinfl: { type: String },
    documentType: { type: String },
    documentSeries: { type: String },
    documentNumber: { type: String },
    phone: { type: String },
    cadasterSource: { type: String },
    birthDate: { type: String },

    // Excel qatorining asl (xom) ko'rinishi — kelajakda qo'shimcha
    // ustunlar chiqsa ham ma'lumot yo'qolmasligi uchun.
    raw: { type: Schema.Types.Mixed },

    // Tug'ilganlik guvohnomasi bo'yicha (FHDYO bazasi) aniqlangan
    // ota-ona ma'lumotlari. Bolada JSHSHIR bo'lmagani uchun uni
    // oilasiga bog'lashning yagona ishonchli yo'li shu.
    fatherFullName: { type: String },
    fatherPinfl: { type: String },
    fatherBirthDate: { type: String },
    motherFullName: { type: String },
    motherPinfl: { type: String },
    motherBirthDate: { type: String },

    // FHDYO (tug'ilganlik guvohnomasi) bazasidan kelgan to'liq javob.
    birthCertData: { type: Schema.Types.Mixed },
    birthCertSyncedAt: { type: Date },

    // Davlat pasport bazasidan (GCP, pinfl+birth_date orqali) kelgan
    // so'nggi ma'lumotning to'liq javobi — kelajakda kerak bo'lsa
    // (masalan address, tin) ishlatish uchun saqlanadi.
    gcpData: { type: Schema.Types.Mixed },

    // GCP orqali so'nggi marta qachon yangilangani (lazy/ommaviy sync
    // holatini bilish uchun).
    gcpSyncedAt: { type: Date },

    // GCP shaxsni topdi, lekin uning amaldagi hujjati yaroqsiz
    // (muddati o'tgan, hali ID kartaga almashtirilmagan). Bunday
    // yozuvga qayta so'rov yuborilmaydi — odam hujjatini yangilamaguncha
    // javob o'zgarmaydi. Qayta urinish uchun bu maydonni tozalash kerak.
    documentExpired: { type: Boolean },
    documentExpiredAt: { type: Date },

    // --- Online Mahalla platformasiga oila a'zosi sifatida kiritish ---
    // Har bir urinish natijasi saqlanadi: muvaffaqiyatli ham, xato ham
    // qayta yuborilmaydi (platformada dublikat paydo bo'lmasligi uchun).
    // "pending" — hali urinilmagan (maydon umuman yo'q).
    familyAddStatus: { type: String, enum: ["success", "failed", "skipped"] },
    // Platforma qaytargan yozuv ID'si (muvaffaqiyatli bo'lsa)
    familyAddMemberId: { type: String },
    // Xato sababi yoki o'tkazib yuborish sababi
    familyAddError: { type: String },
    familyAddAt: { type: Date },
    // Qaysi xonadonga (platforma homeId) kiritilgani
    familyAddHomeId: { type: String },

    // Qaysi foydalanuvchi yuklagan
    userUid: { type: String, required: true, index: true },
  },
  { timestamps: true },
);

export default model("RawRecord", rawRecordSchema);
