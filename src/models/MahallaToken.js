import mongoose from "mongoose";

const { Schema, model } = mongoose;

/**
 * MFY tokeni — bir nechta mahallani parallel ro'yxatga olish uchun.
 *
 * Har MFY ning o'z tokeni bor va tashqi API faqat o'sha token
 * egasining hududidagi xonadonlarni ko'rsatadi. Bitta xodim bir
 * nechta MFY ga mas'ul bo'lishi mumkin — shuning uchun tokenlar
 * ro'yxat sifatida saqlanadi va har biri bo'yicha alohida yurish
 * boshlanadi.
 *
 * Nega DB'da: yurish soatlab davom etadi va fonda ishlaydi. Token
 * brauzerda (localStorage) qolsa, sahifa yopilgach ishchi tokensiz
 * qolardi.
 */
const mahallaTokenSchema = new Schema(
  {
    // Tashqi platformadagi foydalanuvchi — token egasi.
    // Indeks pastda `unique` bilan e'lon qilingan, shuning uchun
    // bu yerda `index: true` yozilmaydi (ikki marta e'lon qilinsa
    // mongoose `unique` ni qo'llamaydi).
    uid: { type: String, required: true },
    username: { type: String },
    fullName: { type: String },

    // Hudud. Token qaysi MFY ga tegishli ekani shundan bilinadi.
    oblId: { type: Number },
    areaId: { type: Number },
    districtId: { type: Number },

    // Tokenning o'zi — maxfiy, javobda hech qachon qaytarilmaydi.
    token: { type: String, required: true, select: false },

    // Foydalanuvchi qo'ygan nom ("Sarnavul MFY") — ro'yxatda shu
    // ko'rinadi. Bo'sh bo'lsa username ishlatiladi.
    label: { type: String },

    // Oxirgi marta tekshirilgan vaqt va holati. Token muddati
    // o'tishi mumkin, shuning uchun holat saqlanadi.
    lastCheckedAt: { type: Date },
    isValid: { type: Boolean, default: true },

    // Tokenni kim qo'shgan (qaysi seansdan). Bir nechta xodim
    // ishlasa, o'zinikini ajrata olishi uchun.
    addedByUid: { type: String, index: true },
  },
  { timestamps: true },
);

// Bitta foydalanuvchining tokeni bir marta saqlanadi.
mahallaTokenSchema.index({ uid: 1 }, { unique: true });

export default model("MahallaToken", mahallaTokenSchema);
