import mongoose from "mongoose";

const { Schema, model } = mongoose;

/**
 * Kadastrsiz ma'lumotlar bazasidagi MFY GURUHI.
 *
 * Nega guruh alohida hujjat: kadastrsiz ma'lumot Excel'dan MFY
 * bo'yicha bo'lak-bo'lak yuklanadi ("Zulfiroq MFY", "Ko'l MFY"...)
 * va har bo'lakka alohida amal kerak bo'ladi — ustiga yozish,
 * qo'shish (append), o'chirish. Agar guruh faqat yozuvlardagi nom
 * orqali bilinsa, bo'sh guruh umuman ko'rinmasdi (yozuvi
 * o'chirilgach nom ham yo'qolardi) va "yangi guruh yaratish"
 * imkoni bo'lmasdi.
 *
 * Ma'lumot GLOBAL: `Citizen` (umumiy baza) kabi `userUid` yo'q —
 * faylni kim yuklaganidan qat'i nazar barcha hisoblar bir xil
 * ro'yxatni ko'radi.
 */
const uncadastredGroupSchema = new Schema(
  {
    // MFY nomi — foydalanuvchi ko'radigan ko'rinishi ("Zulfiroq").
    // Modalda qo'lda kiritiladi yoki mavjud MFY ro'yxatidan tanlanadi.
    name: { type: String, required: true },

    // Taqqoslash kaliti (`utils/mahalla.js: mahallaKey`). Bir MFY
    // o'nlab xil yoziladi ("ЗУЛФИРОҚ", "Zulfiroq MFY", "ZULFIROQ"),
    // shuning uchun guruh AYNAN shu kalit bo'yicha yagona bo'ladi:
    // xodim nomni boshqacha yozsa ham ikkinchi guruh paydo bo'lmaydi.
    mahallaKey: { type: String, required: true, unique: true, index: true },

    // Guruh qaysi MFY tokeniga biriktirilgan (`MfyToken.uid`).
    //
    // Nega kerak: "Kadastrsiz boshlash" faol MFY nomidan ketadi va
    // guruh aynan shu MFY ga tegishli bo'lishi kerak. Bo'sh bo'lsa
    // guruh faqat nom bo'yicha topiladi (eski yozuvlar uchun).
    mfyUid: { type: String, index: true },

    // Guruhdagi yozuvlar soni — ro'yxatda har guruh uchun alohida
    // `countDocuments` yubormaslik uchun saqlanadi.
    total: { type: Number, default: 0 },

    // Oxirgi yuklash qanday bajarildi: "replace" (ustiga yozish)
    // yoki "append" (qo'shish). Ro'yxatda izoh sifatida ko'rsatiladi.
    lastUploadMode: { type: String, enum: ["replace", "append"] },
    lastUploadAt: { type: Date },

    // Yuklangan faylning nomi — xodim qaysi faylni yuklaganini
    // keyinroq eslashi uchun.
    lastFileName: { type: String },
  },
  { timestamps: true },
);

export default model("UncadastredGroup", uncadastredGroupSchema);
