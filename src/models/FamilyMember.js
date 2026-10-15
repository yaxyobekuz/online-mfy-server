import mongoose from "mongoose";

const { Schema, model } = mongoose;

/**
 * Xonadon (uy) tarkibidagi oila a'zosi.
 *
 * Ro'yxat:  /web/v1/tables/pa_survey_family/data   (a'zolar + to'g'ri id)
 * Detal:    /web/v1/forms/survey_v3_family/{id}     (relationship kodi,
 *                                                    hujjat, family_num)
 *
 * Har a'zoga XONADON KADASTRI biriktiriladi: umumiy fuqarolar
 * bazasi bilan bog'lash va Excel'ga chiqarishda shu ustun kerak.
 */
const familyMemberSchema = new Schema(
  {
    // Tashqi tizimdagi a'zo identifikatori (pa_survey_family.id) —
    // detal so'rovi aynan shu bo'yicha ketadi.
    memberId: { type: String, required: true },

    // Qaysi xonadonga tegishli
    homeId: { type: String, required: true, index: true },

    // Xonadonning kadastr raqami — har a'zoga biriktiriladi.
    cadasterNumber: { type: String, index: true },

    // Xonadon so'rovnomasi (survey_uuid) — a'zolar shu bo'yicha olinadi.
    surveyUuid: { type: String },

    // Ko'cha ma'lumoti (ko'rsatish/Excel uchun)
    streetId: { type: String },
    streetName: { type: String },
    homeNum: { type: String },

    // F.I.Sh.
    fullName: { type: String },

    // Qarindoshlik — MATN ("Ўғли", "Турмуш ўртоғи", "хонадон эгаси").
    // Ro'yxat endpointidan keladi.
    relationship: { type: String },

    // Qarindoshlik — KOD (9, 7, ...). Detal endpointidan keladi.
    relationshipCode: { type: Number },

    // Xonadon egasimi (ro'yxatda relationship = "хонадон эгаси").
    isOwner: { type: Boolean, default: false },

    // JSHSHIR umumiy fuqarolar bazasida (Citizen) bormi. Egalar
    // POST uchun saqlanadi, lekin bazada bo'lsa sahifada ko'rsatilmaydi
    // ("Qo'shimcha a'zolar" = bazada YO'Qlar). Haqiqiy a'zolar bazada
    // bo'lsa umuman saqlanmaydi, shuning uchun ularda bu doim false.
    inBase: { type: Boolean, default: false },

    // Tug'ilgan sana ("DD.MM.YYYY")
    birthDate: { type: String },

    // JSHSHIR
    pinfl: { type: String, index: true },

    // Telefon raqami
    phone: { type: String },

    // --- Detal (survey_v3_family) ---
    docSerial: { type: String },
    docNumber: { type: String },
    // Hujjat turi kodi (1 — pasport/ID, 2 — guvohnoma)
    documentType: { type: Number },
    // Oiladagi tartib raqami (family_num)
    familyNum: { type: Number },

    // Detal yuklab olinganmi (lazy: bo'sh natija ham qayta
    // so'ralmasligi uchun).
    detailsSyncedAt: { type: Date },

    // Tashqi bazadan kelgan xom detal javobi — kelajakda yangi
    // ustun chiqsa ham ma'lumot yo'qolmasin.
    rawDetail: { type: Schema.Types.Mixed },

    // User
    userUid: { type: String, required: true, index: true },
  },
  { timestamps: true },
);

// Bir xonadon + bir a'zo ikki marta yozilmasin.
familyMemberSchema.index({ userUid: 1, memberId: 1 }, { unique: true });

// Sahifalash tartibi.
familyMemberSchema.index({ userUid: 1, cadasterNumber: 1, _id: 1 });

export default model("FamilyMember", familyMemberSchema);
