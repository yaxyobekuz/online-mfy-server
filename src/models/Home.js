import mongoose from "mongoose";

const { Schema, model } = mongoose;

/**
 * Ko'cha ichidagi individual kadastr/xonadon (uy) ma'lumoti.
 * Ro'yxat: /api/v1/survey_homes_street/cache/data
 * Tafsilot: /web/v1/forms/survey_homes/:homeId
 */
const homeSchema = new Schema(
  {
    // Tashqi tizimdagi asosiy identifikator
    homeId: { type: String, required: true },

    // Qaysi ko'chaga tegishli
    streetId: { type: String, required: true, index: true },

    // Xonadon (kvartira/uy) raqami
    homeNum: { type: String },

    // Kadastr raqami
    cadasterNumber: { type: String },

    // F.I.Sh.
    fullName: { type: String },

    // Telefon raqami
    mobilePhone: { type: String },

    // JSHSHIR
    pinfl: { type: String },

    // Mulkning mansubligi (masalan "шахсий")
    ownershipType: { type: String },

    // Xatlov (tekshiruv) o'tkazilgan sana
    surveyDate: { type: String },

    // Batafsil ma'lumot havolasi
    nextLink: { type: String },

    // Kamchiliklar (defects_info ichidagi JSON parslangan holda)
    defects: { type: Schema.Types.Mixed, default: {} },

    // --- Batafsil ma'lumot (survey_homes/:homeId formData'sidan) ---

    // Passport / shaxsiy ma'lumot
    passport: { type: String },
    birthDate: { type: String },
    address: { type: String },

    // So'rovnoma identifikatori — survey_homes_family (oila a'zolari)
    // endpointi shu orqali filtrlanadi.
    surveyUuid: { type: String, index: true },

    // Mulk / uy haqida
    homeType: { type: Schema.Types.Mixed },
    homeRegistered: { type: Schema.Types.Mixed },
    ownership: { type: Schema.Types.Mixed },
    propertyType: { type: Schema.Types.Mixed },

    // Kommunal xizmatlar holati
    electricity: { type: Schema.Types.Mixed },
    gas: { type: Schema.Types.Mixed },
    drinkingWater: { type: Schema.Types.Mixed },
    irrigationWater: { type: Schema.Types.Mixed },
    sewerage: { type: Schema.Types.Mixed },

    // Ijtimoiy-iqtisodiy holat
    incomeId: { type: Schema.Types.Mixed },
    monthIncomeId: { type: Schema.Types.Mixed },
    hasDebt: { type: Schema.Types.Mixed },
    debtType: { type: Schema.Types.Mixed },
    debtTypeOther: { type: String },
    debtPurpose: { type: Schema.Types.Mixed },
    debtPurposeOther: { type: String },
    debtCausesShortage: { type: Schema.Types.Mixed },
    monthlyPayment: { type: Schema.Types.Mixed },
    overduePayment: { type: Schema.Types.Mixed },

    // Boshqa ijtimoiy ko'rsatkichlar
    studyLevelId: { type: Schema.Types.Mixed },
    socialRegister: { type: Schema.Types.Mixed },
    womenNotebook: { type: Schema.Types.Mixed },
    youngNotebook: { type: Schema.Types.Mixed },
    subsidyApplications: { type: Schema.Types.Mixed },
    creditApplications: { type: Schema.Types.Mixed },

    // Tafsilot yuklab olinganligi (lazy-load qilingandan keyin true bo'ladi)
    detailsSyncedAt: { type: Date },

    // Oila a'zolari yuklab olinganligi (lazy-load qilingandan keyin
    // true bo'ladi — bo'sh natija ham qayta so'rov yubormaslik uchun)
    familySyncedAt: { type: Date },

    // User
    userUid: { type: String, required: true, index: true },
  },
  { timestamps: true },
);

export default model("Home", homeSchema);
