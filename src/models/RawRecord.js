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

    // Qaysi foydalanuvchi yuklagan
    userUid: { type: String, required: true, index: true },
  },
  { timestamps: true },
);

export default model("RawRecord", rawRecordSchema);
