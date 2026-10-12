import mongoose from "mongoose";

const { Schema, model } = mongoose;

/**
 * Umumiy fuqarolar bazasi (umumiy_royxat_jshshr_kadastr.xlsx).
 *
 * Bu ma'lumot GLOBAL: boshqa to'plamlardan farqli o'laroq `userUid`
 * maydoni yo'q — faylni kim yuklaganidan qat'i nazar, barcha
 * foydalanuvchilar bir xil ro'yxatni ko'radi. Shuning uchun yuklash
 * ham butun kolleksiyani almashtiradi.
 *
 * Excel ustunlari:
 *   №, FIO, ФИШ, туғилган сана, хужжат серия ва рақами, ПНФЛ,
 *   кадастр рақами, манзили
 */
const citizenSchema = new Schema(
  {
    // Excel'dagi tartib raqami (№)
    rowNumber: { type: Number },

    // F.I.Sh. lotin yozuvida (FIO ustuni)
    fullName: { type: String, index: true },

    // F.I.Sh. kirill yozuvida (ФИШ ustuni)
    fullNameCyrillic: { type: String },

    // Tug'ilgan sana — "DD.MM.YYYY" ko'rinishida (loyihadagi boshqa
    // to'plamlar bilan bir xil format).
    birthDate: { type: String },

    // Hujjat seriya va raqami birga ("AA6658639", "III-AN0122343")
    document: { type: String, index: true },

    // Qidirish va taqqoslash uchun alohida ajratilgan holati
    documentSeries: { type: String },
    documentNumber: { type: String },

    // Hujjat turi — "Passport", "ID karta" yoki
    // "Tug'ilganlik guvohnomasi". Excel'da bu ustun yo'q, davlat
    // bazasidan yangilanganda to'ldiriladi.
    documentType: { type: String },

    // JSHSHIR. Excel'da bo'sh yoki "#Н/Д" bo'lishi mumkin — bunday
    // holatda null saqlanadi.
    pinfl: { type: String, index: true },

    cadasterNumber: { type: String, index: true },

    // Manzil (mahalla, ko'cha, uy)
    address: { type: String },

    // Excel qatorining asl ko'rinishi — kelajakda qo'shimcha ustun
    // chiqsa ham ma'lumot yo'qolmasligi uchun.
    raw: { type: Schema.Types.Mixed },

    // --- So'nggi ma'lumotlarga yangilash ---
    // Xom ma'lumot bo'limidagi bilan bir xil mantiq: JSHSHIR bo'lsa
    // GCP (pasport bazasi), bo'lmasa tug'ilganlik guvohnomasi
    // (FHDYO) orqali yangilanadi.

    // Davlat pasport bazasidan kelgan to'liq javob
    gcpData: { type: Schema.Types.Mixed },
    gcpSyncedAt: { type: Date },

    // FHDYO (guvohnoma) bazasidan kelgan to'liq javob
    birthCertData: { type: Schema.Types.Mixed },
    birthCertSyncedAt: { type: Date },

    // Guvohnoma orqali aniqlangan ota-ona ma'lumoti
    fatherFullName: { type: String },
    fatherPinfl: { type: String },
    fatherBirthDate: { type: String },
    motherFullName: { type: String },
    motherPinfl: { type: String },
    motherBirthDate: { type: String },

    // GCP shaxsni topdi, lekin hujjati yaroqsiz. Bunday yozuvga
    // qayta so'rov yuborilmaydi — javob o'zgarmaydi.
    documentExpired: { type: Boolean },
    documentExpiredAt: { type: Date },
  },
  { timestamps: true },
);

// Kirill ism va manzil bo'yicha qidiruv regex bilan ketadi, shuning
// uchun bu maydonga ham indeks kerak. ("text" indeks ishlatilmaydi:
// u so'z boshiga bog'lanmagan qidiruvni qo'llab-quvvatlamaydi va
// 150 ming yozuvda ortiqcha joy egallaydi.)
citizenSchema.index({ fullNameCyrillic: 1 });

// Sahifalash har doim shu tartibda ketadi.
citizenSchema.index({ rowNumber: 1, _id: 1 });

export default model("Citizen", citizenSchema);
