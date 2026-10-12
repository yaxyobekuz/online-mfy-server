import mongoose from "mongoose";

const { Schema, model } = mongoose;

/**
 * MFY bo'yicha oila a'zolarini ro'yxatdan o'tkazish YURISHI (kampaniya).
 *
 * Bitta yurish = bitta mahalla (MFY) uchun boshidan oxirigacha olib
 * boriladigan jarayon. Jarayon uzoq davom etadi (minglab xonadon,
 * har biri uchun bir nechta tashqi so'rov), shuning uchun holat
 * XOTIRADA EMAS, DB'da saqlanadi:
 *   - sahifa yangilansa ham kuzatuv yo'qolmaydi;
 *   - server qayta ishga tushsa, yurish aynan to'xtagan joyidan
 *     davom etadi (xonadon va a'zo yozuvlari bosqichma-bosqich
 *     belgilanadi, "qaytadan boshlash" shart emas).
 *
 * Boshqaruv: `control` maydoni orqali — ishchi (worker) har qadamda
 * uni o'qiydi va "pause"/"stop" ko'rsatmasiga bo'ysunadi.
 */
const registrationRunSchema = new Schema(
  {
    // Mahalla (MFY) — umumiy fuqarolar bazasidagi manzildan
    // hisoblangan kalit (utils/mahalla.js: mahallaKey).
    mahallaKey: { type: String, required: true, index: true },
    mahallaName: { type: String },

    // --- Jarayon holati ---
    // pending   — yaratildi, hali boshlanmagan
    // preparing — MFY ko'chalari/xonadonlari yuklanmoqda
    // running   — xonadonlar ketma-ket ishlanmoqda
    // paused    — foydalanuvchi to'xtatib turdi (davom ettirish mumkin)
    // done      — barcha xonadon ishlandi
    // stopped   — foydalanuvchi butunlay to'xtatdi
    // error     — kutilmagan xatolik (sabab `error` maydonida)
    status: {
      type: String,
      enum: ["pending", "preparing", "running", "paused", "done", "stopped", "error"],
      default: "pending",
      index: true,
    },

    // Ishchiga ko'rsatma. Ishchi har xonadondan oldin o'qiydi.
    //   run   — davom et
    //   pause — joriy xonadonni tugatib, to'xtab tur
    //   stop  — joriy xonadonni tugatib, yurishni yop
    control: {
      type: String,
      enum: ["run", "pause", "stop"],
      default: "run",
    },

    // Qaysi bosqichda ekani (clientda bir qatorli izoh sifatida
    // ko'rsatiladi): "Ko'chalar yuklanmoqda", "12/340 — xonadon ..."
    stage: { type: String },

    // --- Hisoblagichlar ---
    // Barchasi DB'da yurishning o'zida saqlanadi: sahifa qayta
    // ochilganda ham son to'g'ri ko'rinishi uchun.
    homesTotal: { type: Number, default: 0 },
    homesDone: { type: Number, default: 0 },
    homesFailed: { type: Number, default: 0 },

    // Nomzodlar — fuqarolar bazasidan topilgan, qo'shilishi kerak
    // bo'lgan odamlar.
    membersTotal: { type: Number, default: 0 },
    membersAdded: { type: Number, default: 0 },
    membersFailed: { type: Number, default: 0 },
    membersSkipped: { type: Number, default: 0 },

    // Rate-limit tufayli kutilayotgan bo'lsa — shu vaqtgacha.
    waitingUntil: { type: Number, default: null },

    // --- Egalik (bir nechta server uchun) ---
    //
    // Bitta bazaga bir nechta server ulanishi mumkin (har biri o'z
    // IP'sidan so'rov yuboradi). Ishchining "faol" belgisi xotirada
    // bo'lgani uchun ikkinchi server birinchisining ishlayotganini
    // ko'rmaydi — natijada bir xonadonga ikki marta so'rov ketardi.
    //
    // Shuning uchun egalik DB'da belgilanadi: yurishni faqat bitta
    // server oladi, qolganlari uning heartbeat'i eskirgunicha
    // tegmaydi.
    ownerId: { type: String },
    ownerName: { type: String },

    // Oxirgi marta jonli belgi qo'yilgan vaqt. Server kutilmaganda
    // o'chsa, "running" holatida qotib qolgan yurishni shu orqali
    // aniqlaymiz (davom ettirish taklif qilinadi).
    heartbeatAt: { type: Date },

    error: { type: String },

    startedAt: { type: Date },
    finishedAt: { type: Date },

    // Yurishni boshlagan foydalanuvchi. Tashqi API so'rovlari shu
    // foydalanuvchining hududi (obl/area/district) bo'yicha ketadi.
    userUid: { type: String, required: true, index: true },

    // Yurish qaysi token bilan ketyapti.
    //
    // Nega saqlanadi: har MFY ning o'z tokeni bor va tashqi API
    // faqat o'sha token egasining hududini ko'rsatadi. Ishchi esa
    // fonda, so'rov tugagandan keyin ham ishlaydi — ya'ni so'rov
    // kontekstidagi tokenga tayanib bo'lmaydi.
    //
    // DIQQAT: bu maxfiy ma'lumot. Hech qaysi endpoint uni
    // qaytarmaydi (`describeRun` da ataylab olib tashlanadi).
    token: { type: String, select: false },

    // Yurish egasining hudud ID'lari — tashqi API so'rovlari uchun.
    // Token bilan birga saqlanadi, chunki ishchi qayta tiklanganda
    // foydalanuvchi ma'lumotini qayta so'ramasligi kerak.
    oblId: { type: Number },
    areaId: { type: Number },
    districtId: { type: Number },
  },
  { timestamps: true },
);

// Bitta mahalla uchun bir vaqtda bitta faol yurish bo'lishi kerak —
// ro'yxatda eng yangisi birinchi chiqadi.
registrationRunSchema.index({ userUid: 1, createdAt: -1 });

export default model("RegistrationRun", registrationRunSchema);
