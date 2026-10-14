import mongoose from "mongoose";

const { Schema, model } = mongoose;

/**
 * MFY (mahalla) platforma tokeni — SERVER TOMONDA saqlanadi.
 *
 * Avval tokenlar brauzerda (localStorage) turardi va har so'rovda
 * `Authorization` sarlavhasida kelardi. Endi ular serverda: client
 * faqat QAYSI MFY ustida ishlashini (`uid`) aytadi, server esa o'sha
 * MFY ning tokenini shu yerdan oladi.
 *
 * Token maxfiy: hech bir endpoint uni qaytarmaydi (`select: false`).
 */
const mfyTokenSchema = new Schema(
  {
    // Platformadagi foydalanuvchi (MFY) identifikatori — kalit.
    uid: { type: String, required: true, unique: true, index: true },

    username: { type: String },
    mahallaName: { type: String },

    // Platforma tokeni — MAXFIY, hech qachon qaytarilmaydi.
    token: { type: String, required: true, select: false },

    // Holat:
    //   active  — ishlaydi
    //   expired — platforma 401 qaytardi (muddati o'tgan/bekor)
    status: {
      type: String,
      enum: ["active", "expired"],
      default: "active",
      index: true,
    },

    // Hudud ID'lari — tashqi API so'rovlari uchun (tokendan kelib
    // chiqadi, qayta so'ramaslik uchun saqlanadi).
    oblId: { type: Number },
    areaId: { type: Number },
    districtId: { type: Number },

    // Oxirgi marta tekshirilgan/ishlatilgan vaqt.
    lastCheckedAt: { type: Date },

    // Panelda yashirilganmi — faqat KO'RINISH uchun. Yashirilgan MFY
    // ro'yxatda ko'rinmaydi, lekin tokeni, jarayonlari va
    // statistikasi o'z joyida qoladi. Istalgan vaqt qayta ochiladi.
    hidden: { type: Boolean, default: false },
  },
  { timestamps: true },
);

export default model("MfyToken", mfyTokenSchema);
