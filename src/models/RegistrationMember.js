import mongoose from "mongoose";

const { Schema, model } = mongoose;

/**
 * Yurish ichidagi BITTA ODAM — ro'yxatga olish urinishi.
 *
 * Har bir odam uchun butun yo'l saqlanadi: davlat bazasidan nima
 * kelgani, platformaga nima yuborilgani, platforma nima javob
 * bergani. Shuning uchun hisobotda "nega kirmadi?" degan savolga
 * taxmin bilan emas, aniq javob bilan qaraladi.
 */
const registrationMemberSchema = new Schema(
  {
    runId: { type: Schema.Types.ObjectId, ref: "RegistrationRun", required: true, index: true },
    homeRowId: { type: Schema.Types.ObjectId, ref: "RegistrationHome", required: true, index: true },

    cadasterNumber: { type: String, index: true },
    homeId: { type: String },

    // Fuqarolar bazasidagi manba yozuv (Citizen._id) — hisobotdan
    // asl qatorga qaytish uchun.
    citizenId: { type: Schema.Types.ObjectId, ref: "Citizen" },

    // --- Manbadagi (Excel) ko'rinishi ---
    fullName: { type: String },
    birthDate: { type: String },
    document: { type: String },
    pinfl: { type: String, index: true },

    // --- Davlat bazasidan tasdiqlangan ko'rinishi ---
    // Platforma yuborilgan F.I.Sh. va sanani rasmiy baza bilan
    // AYNAN solishtiradi, shuning uchun yuborishdan oldin shu
    // qiymatlar olinadi.
    verifiedFullName: { type: String },
    verifiedBirthDate: { type: String },
    verifiedPinfl: { type: String },
    verifiedDocSeries: { type: String },
    verifiedDocNumber: { type: String },
    verifiedDocumentType: { type: String },

    // Qaysi baza tasdiqladi: "gcp" (pasport) yoki "fhdyo" (guvohnoma).
    verifiedVia: { type: String },

    // Tashqi bazadan kelgan to'liq javob — tekshirish uchun.
    registryResponse: { type: Schema.Types.Mixed },

    // --- Platformaga yuborilgan va qaytgan ---
    // Qo'shishda ishlatilgan kodlar.
    relationshipCode: { type: String },
    studyLevelCode: { type: String },
    documentTypeCode: { type: String },

    // Aynan yuborilgan body va query — xato bo'lsa qayta tiklash mumkin.
    sentPayload: { type: Schema.Types.Mixed },
    sentParams: { type: Schema.Types.Mixed },

    // Platformaning to'liq javobi (muvaffaqiyat yoki xato tanasi).
    platformResponse: { type: Schema.Types.Mixed },
    httpStatus: { type: Number },

    // Platformada yaratilgan a'zo ID'si.
    memberId: { type: String },

    // --- Holat ---
    // pending  — navbatda
    // added    — platformaga qo'shildi
    // exists   — allaqachon ro'yxatda edi (JSHSHIR bo'yicha topildi)
    // skipped  — yubormadik (sababi `reason`da): egasi, JSHSHIR yo'q...
    // failed   — yubordik, platforma rad etdi
    status: {
      type: String,
      enum: ["pending", "added", "exists", "skipped", "failed"],
      default: "pending",
      index: true,
    },

    // Nega qo'shilmadi — odam tilida, hisobotda shu ko'rinadi.
    reason: { type: String },

    // Platforma "bu fuqaro boshqa xonadonda ro'yxatda" deb rad
    // etganda, xabar ichida O'SHA joyning manzili bo'ladi:
    //   "Ушбу фуқаро Фарғона вилояти, Фарғона тумани, Оқбилол
    //    маҳалласи ... хонадони ... да мавжуд"
    // Bu mahalla xodimi uchun qimmatli ma'lumot — odam ko'chib
    // ketganini bildiradi. Shuning uchun ajratib saqlanadi.
    registeredRegion: { type: String },
    registeredMahalla: { type: String },
    // O'z mahallamizdami yoki boshqa joydami.
    movedAway: { type: Boolean },

    // Xatolarni guruhlash uchun qisqa belgi ("pinfl_yoq",
    // "malumot_mos_emas", "vafot_etgan", ...). Hisobotda sabablar
    // shu bo'yicha sanaladi — erkin matnni guruhlab bo'lmaydi.
    reasonCode: { type: String, index: true },

    durationMs: { type: Number },
    attemptedAt: { type: Date },

    userUid: { type: String, required: true, index: true },
  },
  { timestamps: true },
);

registrationMemberSchema.index({ runId: 1, status: 1 });
registrationMemberSchema.index({ runId: 1, createdAt: 1 });

export default model("RegistrationMember", registrationMemberSchema);
