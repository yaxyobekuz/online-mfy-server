/**
 * Platformaga oila a'zosi qo'shishda ishlatiladigan kod jadvallari
 * va ularni ma'lumotdan kelib chiqib tanlash mantiqi.
 *
 * Kodlar manbasi: add_family_member/*.json (platformaning o'zidan
 * olingan ro'yxatlar).
 */

// --- Qarindoshlik (relationship.json) ---
export const RELATIONSHIP_CODES = {
  Otasi: 1,
  Onasi: 2,
  Opasi: 3,
  Akasi: 4,
  Singlisi: 5,
  Ukasi: 6,
  "Turmush o'rtog'i": 7,
  Qizi: 8,
  "O'g'li": 9,
  Qaynotasi: 10,
  Qaynonasi: 11,
  Kelini: 12,
  Boshqa: 13,
  Kuyovi: 14,
  Nabira: 15,
};

// MFY bo'yicha ommaviy ro'yxatga olishda qarindoshlik darajasini
// aniqlab bo'lmaydi: umumiy fuqarolar bazasida faqat kadastr bor,
// kim kimga nima bo'lishi yozilmagan. Noto'g'ri daraja ko'rsatgandan
// ko'ra "Boshqa" deb belgilash to'g'riroq — keyin mahalla xodimi
// aniqlab, platformada o'zi tuzatadi.
export const DEFAULT_RELATIONSHIP = RELATIONSHIP_CODES.Boshqa; // 13

// --- Hujjat turi (document_type.json) ---
export const DOCUMENT_TYPE_CODES = {
  passport: 1,
  "id karta": 1,
  "id-karta": 1,
  "passport / id-karta": 1,
  "tug'ilganlik guvohnomasi": 2,
  guvohnoma: 2,
};

const normalizeKey = (value) =>
  String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[`‘’ʻ']/g, "'");

export const documentTypeCode = (documentType) =>
  DOCUMENT_TYPE_CODES[normalizeKey(documentType)] ?? null;

// --- Ta'lim darajasi (study_level.json) ---
export const STUDY_LEVELS = {
  OLIY: 1,
  TUGALLANMAGAN_OLIY: 2,
  ORTA_MAXSUS: 3,
  ORTA: 4,
  YOQ: 5,
};

/**
 * Ta'lim darajasi na Excel'da, na davlat bazasida bor — platforma
 * esa uni majburiy talab qiladi. Shuning uchun yosh va jinsga qarab
 * O'zbekiston statistikasiga yaqin taqsimot bilan belgilanadi.
 *
 * Mantiq (O'zbekiston ta'lim tizimi bo'yicha):
 *   0–6 yosh   — maktabgacha, ma'lumoti yo'q (5)
 *   7–17 yosh  — umumiy o'rta maktabda o'qiydi (4 — "O'rta")
 *   18–22 yosh — bir qismi kollej/texnikumda, bir qismi OTMda
 *                (hali tugatmagan — 2), ko'pchiligi o'rta bilan
 *   23+ yosh   — ma'lumot tugallangan: oliy / o'rta maxsus / o'rta
 *
 * Jins farqi: O'zbekistonda oliy ta'lim qamrovi erkaklarda bir oz
 * yuqori, shuning uchun 23+ yoshda ulush farqlanadi.
 *
 * Taqsimot tasodifiy emas, BARQAROR: bir xil odam (JSHSHIR) uchun
 * har safar bir xil natija chiqadi. Random ishlatilsa, qayta
 * urinishda boshqa qiymat ketib, hisobot ham chalkashardi.
 */
const WEIGHTS = {
  // [kod, ulush %]
  male: {
    youngAdult: [
      [STUDY_LEVELS.ORTA, 45],
      [STUDY_LEVELS.TUGALLANMAGAN_OLIY, 22],
      [STUDY_LEVELS.ORTA_MAXSUS, 33],
    ],
    adult: [
      [STUDY_LEVELS.OLIY, 26],
      [STUDY_LEVELS.ORTA_MAXSUS, 30],
      [STUDY_LEVELS.ORTA, 44],
    ],
    senior: [
      [STUDY_LEVELS.OLIY, 16],
      [STUDY_LEVELS.ORTA_MAXSUS, 30],
      [STUDY_LEVELS.ORTA, 54],
    ],
  },
  female: {
    youngAdult: [
      [STUDY_LEVELS.ORTA, 50],
      [STUDY_LEVELS.TUGALLANMAGAN_OLIY, 18],
      [STUDY_LEVELS.ORTA_MAXSUS, 32],
    ],
    adult: [
      [STUDY_LEVELS.OLIY, 20],
      [STUDY_LEVELS.ORTA_MAXSUS, 32],
      [STUDY_LEVELS.ORTA, 48],
    ],
    senior: [
      [STUDY_LEVELS.OLIY, 11],
      [STUDY_LEVELS.ORTA_MAXSUS, 27],
      [STUDY_LEVELS.ORTA, 62],
    ],
  },
};

/**
 * JSHSHIR'dan barqaror (0–99) son chiqaradi. Bir xil JSHSHIR har
 * safar bir xil son beradi — shuning uchun tanlov takrorlanadi.
 */
const stableRoll = (seed) => {
  const text = String(seed ?? "");
  let hash = 2166136261;

  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  return Math.abs(hash) % 100;
};

const pickWeighted = (weights, roll) => {
  let remaining = roll;

  for (const [code, share] of weights) {
    remaining -= share;
    if (remaining < 0) return code;
  }

  return weights[weights.length - 1][0];
};

/**
 * JSHSHIR'ning birinchi raqami jinsni va tug'ilgan asrni bildiradi:
 *   1, 3, 5 — erkak;  2, 4, 6 — ayol.
 */
export const genderFromPinfl = (pinfl) => {
  const first = String(pinfl ?? "").trim()[0];
  if (!first) return null;

  const digit = Number(first);
  if (!Number.isFinite(digit) || digit < 1) return null;

  return digit % 2 === 1 ? "male" : "female";
};

export const yearsOld = (isoBirthDate) => {
  const birth = new Date(isoBirthDate);
  if (Number.isNaN(birth.getTime())) return null;

  const now = new Date();
  let age = now.getUTCFullYear() - birth.getUTCFullYear();

  const monthDiff = now.getUTCMonth() - birth.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getUTCDate() < birth.getUTCDate())) {
    age -= 1;
  }

  return age;
};

/**
 * Yosh va jinsga qarab ta'lim darajasi kodini qaytaradi.
 *
 * @param {number|null} age   yoshi (yillarda)
 * @param {string|null} pinfl barqaror tanlov va jins uchun
 */
export const pickStudyLevel = (age, pinfl) => {
  // Yoshi noma'lum bo'lsa, eng keng tarqalgan daraja.
  if (age === null || age === undefined) return STUDY_LEVELS.ORTA;

  // Maktabgacha yoshdagi bola — ta'lim darajasi yo'q.
  if (age <= 6) return STUDY_LEVELS.YOQ;

  // Maktab yoshi: 7–17. Bu oraliqda bola umumiy o'rta ta'limda
  // bo'ladi, boshqa daraja bo'lishi mumkin emas.
  if (age <= 17) return STUDY_LEVELS.ORTA;

  const gender = genderFromPinfl(pinfl) ?? "male";
  const table = WEIGHTS[gender];
  const roll = stableRoll(pinfl ?? age);

  if (age <= 22) return pickWeighted(table.youngAdult, roll);
  if (age <= 59) return pickWeighted(table.adult, roll);
  return pickWeighted(table.senior, roll);
};

/**
 * Xato sababini qisqa kodga keltiradi — hisobotda sabablarni
 * guruhlab sanash uchun. Erkin matnni guruhlab bo'lmaydi: platforma
 * bir xil sababni turli so'z bilan qaytaradi.
 */
export const reasonCodeOf = (reason) => {
  const text = String(reason ?? "");

  if (!text) return "nomalum";
  // Platforma apostrofni ikki marta qaytaradi ("Bo''sh"), shuning
  // uchun apostrofning har qanday soni va shakliga moslashamiz.
  if (/Бўш\s+бўлмаслиги|Bo['`‘’ʻ]*sh\s+bo['`‘’ʻ]*lmasligi/i.test(text)) {
    return "pinfl_yoq";
  }
  if (/мувофиқ эмас|muvofiq emas|mos kelmadi/i.test(text)) return "malumot_mos_emas";

  // Platforma bir shaxsni ikki joyda ro'yxatga olishga yo'l
  // bermaydi. Ikki xil xabar keladi:
  //   "... хонадон эгаси сифатида ..." — boshqa xonadonning egasi;
  //   "... хонадони аъзоси ..."        — boshqa xonadonning a'zosi.
  // Ikkisi ham bir ma'noni beradi, lekin sababni ajratib ko'rsatish
  // foydali: biri egalik, ikkinchisi a'zolik.
  if (/хонадон\s+эгаси|xonadon\s+egasi\s+sifatida/i.test(text)) {
    return "boshqa_xonadon_egasi";
  }
  // Uchinchi shakl: "... хонадони ... мавжуд, қайта киритиб
  // бўлмайди!" — ma'nosi yuqoridagilar bilan bir xil.
  if (
    /хонадони\s+аъзоси|хонадон\s+аъзолари|a'zosi\s+sifatida|қайта\s+киритиб\s+бўлмайди/i.test(
      text,
    )
  ) {
    return "boshqa_xonadon_azosi";
  }

  // Davlat bazasi qaytargan hujjat raqami platformaning talabiga
  // mos emas (masalan 8 belgidan qisqa). Bu ma'lumotning o'zidagi
  // nuqson — qayta urinish yordam bermaydi.
  if (/doc_number|doc_serial|Qiymat uzunligi/i.test(text)) {
    return "hujjat_notogri";
  }

  if (/киритилган|kiritilgan|allaqachon/i.test(text)) return "allaqachon_mavjud";
  if (/vafot etgan/i.test(text)) return "vafot_etgan";
  // GCP xabari ("doc_status = Yaroqsiz hujjat") va bizning o'z
  // matnimiz ("Hujjati yaroqsiz / muddati o'tgan") — ikkisi ham.
  if (/Yaroqsiz hujjat|Yaroqli hujjat yo|Hujjati yaroqsiz|muddati o'tgan/i.test(text)) {
    return "hujjat_yaroqsiz";
  }
  // JSHSHIR yo'q va hujjati guvohnoma ham emas — na GCP, na FHDYO
  // orqali topib bo'lmaydi. Bu alohida sabab: uni "So'nggi
  // ma'lumotlarga yangilash" ham hal qilmaydi, Excel yangilanishi
  // kerak.
  if (/qidirib bo'lmaydi|guvohnoma emas/i.test(text)) return "qidirib_bolmaydi";
  // Pasport bo'yicha MIP bazasidan ham topilmadi — hujjat eskirgan
  // yoki manbadagi raqam xato bo'lishi mumkin.
  if (/pasport \(.*\) bo'yicha ham topilmadi/i.test(text)) {
    return "pasport_topilmadi";
  }
  if (/JSHSHIR ham, hujjat ham yo'q/i.test(text)) return "hujjat_yoq";
  if (/JSHSHIR hali berilmagan/i.test(text)) return "jshshir_berilmagan";

  if (/topilmadi/i.test(text)) return "bazada_topilmadi";
  if (/Internal Server Error/i.test(text)) return "server_xatosi";
  if (
    /ENOTFOUND|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ECONNABORTED|timeout|tarmoq/i.test(
      text,
    )
  ) {
    return "tarmoq";
  }
  if (/sana/i.test(text)) return "sana_notogri";
  if (/survey_uuid/i.test(text)) return "survey_uuid_yoq";
  if (/egasi/i.test(text)) return "xonadon_egasi";

  return "boshqa";
};

/**
 * Platforma "bu fuqaro boshqa xonadonda ro'yxatda" deb rad etganda,
 * xabar ichida o'sha joyning manzili bo'ladi:
 *
 *   "Ушбу фуқаро Фарғона вилояти, Фарғона тумани, Оқбилол маҳалласи
 *    AMINJONOV DILSHOD ... хонадони ... да мавжуд"
 *
 * Shu matndan viloyat va mahalla nomini ajratadi. Mahalla xodimi
 * uchun bu qimmatli ma'lumot: odam ko'chib ketganini va qayerda
 * ro'yxatda turganini bildiradi.
 *
 * Qaytaradi: { region, mahalla } yoki null.
 */
export const parseRegisteredPlace = (reason) => {
  const text = String(reason ?? "");
  if (!text) return null;

  // "<Viloyat> вилояти, <Tuman> тумани, <Mahalla> маҳалласи"
  const match = text.match(
    /([^,]+?)\s*вилояти\s*,\s*([^,]+?)\s*тумани\s*,\s*([^,]+?)\s*ма[ҳх]алласи/i,
  );

  if (!match) return null;

  const clean = (value) => String(value).replace(/^[\s,.]+|[\s,.]+$/g, "");

  // Viloyat nomi oldida xizmat matni turadi: "pinfl: Ушбу фуқаро".
  // Uni olib tashlaymiz — nomning o'zi qoladi.
  //
  // Diqqat: `\b` kirill harflari bilan ishlamaydi (ASCII'ga
  // bog'langan), shuning uchun so'z chegarasi o'rniga oxirgi
  // "фуқаро" dan keyingi qismni olamiz.
  const rawRegion = clean(match[1]);
  const afterMarker = rawRegion.split(/фу[қк]аро/i).pop();
  const region = clean(afterMarker ?? rawRegion).replace(/^.*?:\s*/, "");

  return {
    region: region || clean(match[1]),
    district: clean(match[2]),
    mahalla: clean(match[3]),
  };
};

// Hisobotda sabab kodini odam tilida ko'rsatish uchun.
export const REASON_LABELS = {
  pinfl_yoq: "JSHSHIR yo'q",
  malumot_mos_emas: "Ma'lumot davlat bazasiga mos emas",
  boshqa_xonadon_egasi: "Boshqa xonadonning egasi",
  boshqa_xonadon_azosi: "Boshqa xonadonning a'zosi",
  hujjat_notogri: "Hujjat raqami platforma talabiga mos emas",
  allaqachon_mavjud: "Allaqachon ro'yxatda",
  vafot_etgan: "Vafot etgan",
  // Diqqat: odamning o'zi aktiv bo'lishi mumkin
  // ("status_name = aktiv"), faqat HUJJATI yaroqsiz — ya'ni yangi
  // pasport olgan, bazadagi ro'yxat esa eskisini ko'rsatyapti.
  hujjat_yaroqsiz: "Hujjati yaroqsiz — yangi hujjat olingan bo'lishi mumkin",
  qidirib_bolmaydi: "JSHSHIR yo'q, hujjati guvohnoma emas — qidirib bo'lmaydi",
  pasport_topilmadi: "Pasport bo'yicha davlat bazasida topilmadi",
  hujjat_yoq: "JSHSHIR ham, hujjat ham yo'q",
  jshshir_berilmagan: "Guvohnoma bor, JSHSHIR hali berilmagan",
  bazada_topilmadi: "Davlat bazasida topilmadi",
  server_xatosi: "Tashqi server xatosi",
  tarmoq: "Tarmoq uzilishi",
  sana_notogri: "Tug'ilgan sana noto'g'ri",
  survey_uuid_yoq: "Xonadon so'rovnomasi topilmadi",
  xonadon_egasi: "Xonadon egasi (a'zo qilinmaydi)",
  nomalum: "Noma'lum",
  boshqa: "Boshqa",
};

/**
 * Qayta so'rashdan foyda yo'q sabablar — "o'zgarmas" sabablar.
 *
 * Bazada bir odam bir nechta kadastrda uchraydi, random rejimda esa
 * tasodifiy tanlov o'sha odamni qayta chiqarishi mumkin. Bu
 * sabablar bilan chetda qolgan odamni davlat bazasidan qayta
 * so'rash bekorga vaqt va rate-limit sarflaydi — javob o'sha-o'sha
 * keladi. Shuning uchun ular bir marta aniqlangach eslab qolinadi.
 *
 * Diqqat: ro'yxatga FAQAT manbadagi ma'lumotning o'zidan kelib
 * chiqadigan sabablar kiradi. Tarmoq uzilishi yoki server xatosi
 * (`tarmoq`, `server_xatosi`) vaqtinchalik — ular qayta urinishga
 * arziydi, shuning uchun bu yerda yo'q.
 */
export const PERMANENT_REASON_CODES = [
  // Odamning holati boshqa o'zgarmaydi.
  "vafot_etgan",
  // Hujjati yaroqsiz — yangi hujjat olinmaguncha javob o'zgarmaydi.
  "hujjat_yaroqsiz",
  // Davlat bazasidan topilmadi: manbadagi hujjat raqami xato yoki
  // eskirgan. Excel yangilanmaguncha qayta so'rov ham topmaydi.
  "bazada_topilmadi",
  "pasport_topilmadi",
  // Qidirish uchun ma'lumotning o'zi yetarli emas.
  "qidirib_bolmaydi",
  "hujjat_yoq",
  // Guvohnoma bor, lekin JSHSHIR hali berilmagan.
  "jshshir_berilmagan",
  // Davlat bazasi qaytargan hujjat platforma talabiga mos emas —
  // bu ma'lumotning o'zidagi nuqson.
  "hujjat_notogri",
];
