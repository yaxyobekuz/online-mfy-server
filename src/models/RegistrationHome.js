import mongoose from "mongoose";

const { Schema, model } = mongoose;

/**
 * Yurish ichidagi BITTA XONADON.
 *
 * Yurish boshlanishida MFY ning barcha ko'chalari va xonadonlari
 * yuklanib, shu kolleksiyaga navbat ko'rinishida yoziladi. Ishchi
 * ularni `queueIndex` tartibida bittadan oladi — shuning uchun
 * server qayta ishga tushsa ham navbat joyida qoladi.
 */
const registrationHomeSchema = new Schema(
  {
    runId: { type: Schema.Types.ObjectId, ref: "RegistrationRun", required: true, index: true },

    // Navbatdagi o'rni (0 dan boshlanadi) — ishchi shu tartibda yuradi.
    queueIndex: { type: Number, required: true },

    // --- Platformadagi xonadon ---
    homeId: { type: String, required: true },
    streetId: { type: String, required: true },
    streetName: { type: String },
    homeNum: { type: String },
    cadasterNumber: { type: String, index: true },

    // Xonadon egasi — a'zo qo'shishda `owner_pinfl` sifatida ketadi.
    ownerFullName: { type: String },
    ownerPinfl: { type: String },

    // Oila a'zolari endpointi uchun majburiy. Dastlab bo'sh bo'ladi,
    // xonadon ishlanganda /web/v1/forms/survey_homes/{id} dan olinadi.
    surveyUuid: { type: String },

    // --- Holat ---
    // pending     — navbatda
    // processing  — hozir ishlanmoqda
    // done        — tugadi (hammasi qo'shildi yoki qo'shadigani yo'q edi)
    // partial     — bir qismi qo'shildi, bir qismida xatolik
    // skipped     — bu xonadonda qo'shiladigan odam topilmadi
    // failed      — xonadonning o'zi ishlanmadi (survey_uuid yo'q va h.k.)
    status: {
      type: String,
      enum: ["pending", "processing", "done", "partial", "skipped", "failed"],
      default: "pending",
      index: true,
    },

    // Nega o'tkazib yuborildi / nega xato berdi.
    reason: { type: String },

    // --- Shu xonadon bo'yicha sonlar ---
    // Platformada allaqachon turgan a'zolar soni.
    existingCount: { type: Number, default: 0 },
    // Fuqarolar bazasidan topilgan, shu kadastrga tegishli odamlar.
    candidatesCount: { type: Number, default: 0 },
    // Shu yurishda haqiqatan qo'shilganlar.
    addedCount: { type: Number, default: 0 },
    failedCount: { type: Number, default: 0 },
    skippedCount: { type: Number, default: 0 },

    startedAt: { type: Date },
    finishedAt: { type: Date },
    // Ishlashga ketgan vaqt (ms) — hisobotda o'rtacha tezlikni
    // ko'rsatish uchun.
    durationMs: { type: Number },

    userUid: { type: String, required: true, index: true },
  },
  { timestamps: true },
);

// Ishchi navbatdagi keyingi xonadonni shu indeks orqali oladi.
registrationHomeSchema.index({ runId: 1, queueIndex: 1 });
registrationHomeSchema.index({ runId: 1, status: 1 });

export default model("RegistrationHome", registrationHomeSchema);
