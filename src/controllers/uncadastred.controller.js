import * as XLSX from "xlsx";
import mongoose from "mongoose";
import UncadastredCitizen from "../models/UncadastredCitizen.js";
import UncadastredGroup from "../models/UncadastredGroup.js";
import MfyToken from "../models/MfyToken.js";
import { getRequestUser } from "../utils/request-context.js";
import { mahallaKey, extractMahallaName } from "../utils/mahalla.js";
import { surnameKey, extractLastName } from "../utils/surname.js";
import { RELATIONSHIP_CODES } from "../utils/registration-codes.js";
import { normalizePhone } from "../utils/phone.js";

/**
 * KADASTRSIZ ma'lumotlar bazasi — yuklash, ko'rish, o'chirish.
 *
 * Umumiy bazadan (`citizen.controller.js`) ikki jihatda farq qiladi:
 *
 *   1. Ma'lumot MFY GURUHLARIGA bo'linadi. Umumiy baza bitta
 *      yaxlit ro'yxat va yuklash uni butunlay almashtiradi; bu yerda
 *      esa har MFY alohida yuklanadi va qolgan guruhlarga tegilmaydi.
 *
 *   2. Kadastr YO'Q (ba'zi yozuvlarda bo'lishi mumkin). Buning
 *      o'rniga familiya kaliti hisoblanadi — "Kadastrsiz boshlash"
 *      fuqaroni xonadonga shu bo'yicha moslaydi.
 */

const PAGE_SIZE = 100;

// Kadastrsiz ro'yxat ham katta bo'lishi mumkin — bo'laklab yozamiz
// (umumiy baza bilan bir xil sabab: xotira va MongoDB hujjat limiti).
const INSERT_CHUNK = 5000;

const requireUser = (res) => {
  const user = getRequestUser();
  if (!user) {
    res.status(401).json({ message: "Access key noto'g'ri" });
    return null;
  }
  return user;
};

// ---------------------------------------------------------------
// Excel o'qish
// ---------------------------------------------------------------

/**
 * Ustun nomini topish.
 *
 * Fayllar bir xil emas: ustun lotin yoki kirill bo'ladi, katta-kichik
 * harf va ortiqcha bo'shliq aralashadi ("JSHSHR", "ЖШШИР", " PINFL").
 * Shuning uchun AYNAN nom emas, normallashtirilgan ko'rinish bo'yicha
 * qidiramiz.
 */
const normalizeHeader = (value) =>
  String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[`‘’ʻ']/g, "")
    .replace(/[^a-zа-яёўқғҳ0-9]/gi, "");

/**
 * Qatordan qiymat oladi: berilgan nom variantlaridan birinchi
 * to'ldirilganini qaytaradi.
 *
 * Qator kaliti bir marta normallashtirilib `lookup` jadvaliga
 * yoziladi — har ustun uchun qatorni qayta aylanib chiqmaslik uchun.
 */
const makeReader = (row) => {
  const lookup = new Map();
  for (const [key, value] of Object.entries(row)) {
    lookup.set(normalizeHeader(key), value);
  }

  // Matn sifatida o'qish — aksariyat ustunlar uchun.
  const read = (...names) => {
    for (const name of names) {
      const value = lookup.get(normalizeHeader(name));
      if (value === undefined || value === null) continue;

      const text = String(value).trim();
      // Excel formula xatolari ("#Н/Д", "#N/A") — qiymat emas.
      if (!text || text.startsWith("#")) continue;

      return text;
    }
    return null;
  };

  // XOM qiymat — sana va JSHSHIR uchun.
  //
  // Nega kerak: `cellDates` bilan sana `Date` bo'lib keladi, uni
  // matnga aylantirsak "Mon Jul 24 2023 23:59:49 GMT+0500..."
  // bo'lib qoladi va hech qaysi shablonga tushmaydi (tekshirilgan:
  // 1402 ta sana shu ko'rinishda saqlanib qolgan edi). JSHSHIR ham
  // shunday: u `number` bo'lib keladi va matnga o'tishda katta
  // qiymat eksponensialga aylanishi mumkin.
  read.raw = (...names) => {
    for (const name of names) {
      const value = lookup.get(normalizeHeader(name));
      if (value === undefined || value === null) continue;

      if (typeof value === "string") {
        const text = value.trim();
        if (!text || text.startsWith("#")) continue;
        return text;
      }

      return value;
    }
    return null;
  };

  return read;
};

/**
 * Hujjatni seriya va raqamga ajratadi.
 *
 * `utils/person-data.js: splitDocument` bilan bir xil vazifa, lekin
 * u davlat bazasidan kelgan javob uchun. Bu yerda Excel'dagi erkin
 * yozilish qoplanadi — ikkisini birlashtirmadim: manbalar mustaqil
 * o'zgaradi va bir joydagi tuzatish ikkinchisini buzishi mumkin.
 */
const splitDocument = (document) => {
  const value = String(document ?? "")
    .trim()
    .replace(/[\s№#-]/g, "");
  if (!value) return { series: null, number: null };

  const cert = value.match(/^([IVX]{1,4})([A-Z]{2})(\d+)$/i);
  if (cert) {
    return {
      series: `${cert[1].toUpperCase()}-${cert[2].toUpperCase()}`,
      number: cert[3],
    };
  }

  const passport = value.match(/^([A-Z]{2})(\d+)$/i);
  if (passport) {
    return { series: passport[1].toUpperCase(), number: passport[2] };
  }

  return { series: null, number: value };
};

/**
 * Sanani "DD.MM.YYYY" ga keltiradi.
 *
 * Manbada uch xil keladi (tekshirilgan: "Zulfiroq MFY" fayli):
 *   - haqiqiy Excel sanasi      -> JS `Date` (xlsx `cellDates`)
 *   - nuqtali matn              -> "25.07.2023"
 *   - VERGULLI matn             -> "25,07,2023"   (xodim xatosi)
 *   - faqat yil                 -> "1987"
 *
 * Diqqat (tekshirilgan, "Zulfiroq MFY" fayli): `xlsx` Excel
 * sanasini aniq yarim tun qilib bermaydi — "25.07.2023" qiymati
 * `2023-07-24T18:59:49Z`, ya'ni mahalliy vaqtda 24-iyul 23:59:49
 * bo'lib keladi (11 soniya kam). Shuning uchun na UTC, na mahalliy
 * bo'laklarni to'g'ridan-to'g'ri olish mumkin: ikkisi ham bir kun
 * orqaga ketadi. Qiymat ENG YAQIN KUNGA yaxlitlanadi.
 */
const toDottedDate = (value) => {
  if (value === null || value === undefined) return null;

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;

    // Mahalliy yarim tunga yaxlitlash: soat 12:00 dan keyin bo'lsa
    // keyingi kunga o'tadi (yuqoridagi izoh — 23:59:49 -> 25-iyul).
    const rounded = new Date(value.getTime());
    if (rounded.getHours() >= 12) rounded.setDate(rounded.getDate() + 1);

    const day = String(rounded.getDate()).padStart(2, "0");
    const month = String(rounded.getMonth() + 1).padStart(2, "0");
    return `${day}.${month}.${rounded.getFullYear()}`;
  }

  const text = String(value).trim();
  if (!text) return null;

  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[3]}.${iso[2]}.${iso[1]}`;

  // Ajratuvchi nuqta, vergul, chiziqcha, slash yoki bo'shliq bo'lishi
  // mumkin — manbada hammasi uchraydi ("25.07.2023", "25,07,2023",
  // "28, 09,2020", "22,05,2018,"). Ortiqcha ajratuvchi va oxiridagi
  // vergul ham qoplanadi.
  const parts = text.match(
    /^(\d{1,2})\s*[.,/\-\s]\s*(\d{1,2})\s*[.,/\-\s]\s*(\d{4})\s*[.,]?$/,
  );

  if (parts) {
    const day = Number(parts[1]);
    const month = Number(parts[2]);
    const year = Number(parts[3]);

    // Haqiqiy sana ekanini tekshiramiz: manbada "110,06,2019" yoki
    // "30,06,20107" kabi terish xatolari bor. Bunday qiymatni
    // saqlash zararli — platforma uni rad etadi va sabab
    // tushunarsiz bo'lardi. Null qaytaramiz: yozuv "sanasi yo'q"
    // bo'lib qoladi va jarayonda ochiq sabab bilan chetda qoladi.
    if (
      day >= 1 &&
      day <= 31 &&
      month >= 1 &&
      month <= 12 &&
      year >= 1900 &&
      year <= new Date().getFullYear()
    ) {
      return `${String(day).padStart(2, "0")}.${String(month).padStart(2, "0")}.${year}`;
    }

    return null;
  }

  // Excel seriya raqami (1900-yil 1-yanvardan boshlab kunlar soni).
  //
  // Faqat `number` uchun: matn ko'rinishidagi "1987" sana emas,
  // FAQAT YIL — uni seriya deb o'qish "09.06.1905" kabi ma'nosiz
  // natija berardi (tekshirilgan).
  if (typeof value === "number" && value > 0 && value < 60000) {
    const date = new Date(Date.UTC(1899, 11, 30) + value * 86400000);
    if (!Number.isNaN(date.getTime())) {
      const day = String(date.getUTCDate()).padStart(2, "0");
      const month = String(date.getUTCMonth() + 1).padStart(2, "0");
      return `${day}.${month}.${date.getUTCFullYear()}`;
    }
  }

  // Tanilmagan ko'rinish — saqlamaymiz. Yaroqsiz sana platformada
  // baribir rad etiladi, lekin bazada turgani "sana bor" degan
  // noto'g'ri taassurot qoldirardi.
  return null;
};

/**
 * JSHSHIR ni tozalaydi.
 *
 * Eng ko'p uchraydigan nuqson: Excel uzun raqamni EKSPONENSIAL
 * ko'rinishda ko'rsatadi ("5.25072E+13"). Agar fayl `raw: false`
 * bilan o'qilsa, AYNAN shu matn keladi va JSHSHIR butunlay buziladi
 * (tekshirilgan). Shuning uchun fayl `raw: true` bilan o'qiladi va
 * raqam `number` bo'lib keladi — bu yerda esa ikkala holat ham
 * qoplanadi.
 *
 * JSHSHIR — AYNAN 14 raqam. Boshqa uzunlik xodimning terish xatosi
 * (faylda 15 raqamli qiymat ham uchradi): bunday qiymatni saqlash
 * zararli, platforma uni baribir rad etadi va sabab tushunarsiz
 * bo'lardi. Shuning uchun null qaytaramiz — odam "JSHSHIR yo'q"
 * sifatida ko'rinadi.
 */
const normalizePinfl = (value) => {
  if (value === null || value === undefined) return null;

  let text = String(value).trim();
  if (!text) return null;

  // Eksponensial yozuv — aniq raqamni tiklab bo'lmaydi (oxirgi
  // raqamlar yo'qolgan). Null qaytaramiz: buzilgan JSHSHIR'dan
  // ko'ra "yo'q" to'g'riroq.
  if (/e\+?\d+$/i.test(text)) return null;

  // `number` sifatida kelgan juda katta qiymat ham eksponensialga
  // aylangan bo'lishi mumkin — faqat raqamlarni olamiz.
  text = text.replace(/\D/g, "");

  return text.length === 14 ? text : null;
};

// Excel'dagi qarindoshlik matnini platforma kodiga aylantiradi.
//
// Manbada ham lotin ("O'g'li"), ham kirill ("Ўғли") uchraydi,
// shuning uchun kalit transliteratsiyadan keyin taqqoslanadi.
const RELATIONSHIP_LOOKUP = new Map();
{
  // Platformaning o'z ro'yxati (lotin).
  for (const [name, code] of Object.entries(RELATIONSHIP_CODES)) {
    RELATIONSHIP_LOOKUP.set(mahallaKey(name), code);
  }

  // Manbada uchraydigan qo'shimcha shakllar — kirill yozuvi va
  // so'zlashuv variantlari.
  const extra = {
    Ўғли: RELATIONSHIP_CODES["O'g'li"],
    Угли: RELATIONSHIP_CODES["O'g'li"],
    Qizi: RELATIONSHIP_CODES.Qizi,
    Қизи: RELATIONSHIP_CODES.Qizi,
    Кизи: RELATIONSHIP_CODES.Qizi,
    "Турмуш ўртоғи": RELATIONSHIP_CODES["Turmush o'rtog'i"],
    Xotini: RELATIONSHIP_CODES["Turmush o'rtog'i"],
    Rafiqasi: RELATIONSHIP_CODES["Turmush o'rtog'i"],
    Eri: RELATIONSHIP_CODES["Turmush o'rtog'i"],
    Отаси: RELATIONSHIP_CODES.Otasi,
    Онаси: RELATIONSHIP_CODES.Onasi,
    Опаси: RELATIONSHIP_CODES.Opasi,
    Акаси: RELATIONSHIP_CODES.Akasi,
    Синглиси: RELATIONSHIP_CODES.Singlisi,
    Укаси: RELATIONSHIP_CODES.Ukasi,
    Невараси: RELATIONSHIP_CODES.Nabira,
    Набираси: RELATIONSHIP_CODES.Nabira,
    Келини: RELATIONSHIP_CODES.Kelini,
    Куёви: RELATIONSHIP_CODES.Kuyovi,
    Қайнотаси: RELATIONSHIP_CODES.Qaynotasi,
    Қайнонаси: RELATIONSHIP_CODES.Qaynonasi,
    "Хонадон эгаси": RELATIONSHIP_CODES.Boshqa,
    "Xonadon egasi": RELATIONSHIP_CODES.Boshqa,
  };

  for (const [name, code] of Object.entries(extra)) {
    RELATIONSHIP_LOOKUP.set(mahallaKey(name), code);
  }
}

const relationshipCodeOf = (value) => {
  const key = mahallaKey(value);
  return key ? (RELATIONSHIP_LOOKUP.get(key) ?? null) : null;
};

/**
 * Excel qatorini bazadagi yozuvga aylantiradi.
 *
 * F.I.Sh. ikki xil kelishi mumkin: yagona ustun ("FISH") yoki
 * bo'laklab ("Familiya" | "Ism" | "Sharif"). Ikkalasi ham qo'llanadi
 * va natijada HAR IKKI ko'rinish saqlanadi:
 *   - `fullName`  — platformaga yuborish uchun (u yagona satr kutadi);
 *   - `lastName`  — familiya bo'yicha moslash uchun.
 */
const mapRow = (row) => {
  const read = makeReader(row);

  // Alohida ustunlar.
  const firstName = read("Ism", "Ismi", "Имя", "Исми", "FirstName", "Name");
  const lastNameRaw = read(
    "Familiya",
    "Familiyasi",
    "Фамилия",
    "Фамилияси",
    "LastName",
    "Surname",
  );
  const middleName = read(
    "Sharif",
    "Sharifi",
    "Otasining ismi",
    "Отчество",
    "Шарифи",
    "MiddleName",
    "Patronymic",
  );

  // Yagona ustun. "Ismi va familyasi" — namunadagi fayl ustuni.
  const fullNameRaw = read(
    "FISH",
    "FIO",
    "FISh",
    "F.I.Sh.",
    "ФИШ",
    "Ф.И.Ш.",
    "ФИО",
    "Ismi va familyasi",
    "Ismi va familiyasi",
    "Ism familiya",
    "To'liq ismi",
    "FullName",
  );

  // To'liq ism: yagona ustun bo'lsa o'shani, bo'lmasa bo'laklardan.
  //
  // Diqqat: bo'laklardan yig'ishda tartib FAMILIYA ISM SHARIF —
  // platforma va kadastrsiz manba ikkisi ham shu tartibda yozadi.
  const fullName =
    fullNameRaw ??
    [lastNameRaw, firstName, middleName]
      .filter(Boolean)
      .join(" ")
      .trim() ??
    null;

  // Familiya: alohida ustun bo'lsa o'shani, bo'lmasa to'liq ismning
  // birinchi so'zi.
  const lastName = lastNameRaw ?? extractLastName(fullName);

  const document = read(
    "Hujjat seriyasi va raqami",
    "Hujjat seriya va raqami",
    "хужжат серия ва рақами",
    "Хужжат серия ва раками",
    "Hujjat",
    "Passport",
    "Pasport",
    "Паспорт",
    "Hujjat raqami",
  );
  const { series, number } = splitDocument(document);

  const mfyName = read(
    "MFY",
    "МФЙ",
    "Mahalla",
    "Маҳалла",
    "Махалла",
    "MFY nomi",
    "Mahalla nomi",
  );

  const relationship = read(
    "Qarindoshlik",
    "Qarindoshligi",
    "Қариндошлик",
    "Қариндошлиги",
    "Родство",
    "Relationship",
    "Kim bo'ladi",
  );

  const phone = read(
    "Telefon",
    "Telefon raqami",
    "Telefon raqam",
    "Телефон",
    "Телефон рақами",
    "Phone",
    "Tel",
  );

  return {
    rowNumber: Number(read("№", "N", "T/r", "Т/р", "Tartib")) || null,

    fullName: fullName || null,
    lastName: lastName || null,
    firstName,
    middleName,
    lastNameKey: surnameKey(lastName),

    // Sana va JSHSHIR XOM qiymatdan o'qiladi (`read.raw` izohiga
    // qarang): `Date` matnga aylansa shablon topilmaydi, uzun raqam
    // esa eksponensialga o'tib ketadi.
    birthDate: toDottedDate(
      read.raw(
        "Tug'ilgan sana",
        "Tugilgan sana",
        "Tug'ilgan yili",
        "Tugilgan yili",
        "туғилган сана",
        "тугилган сана",
        "Туғилган йили",
        "JSHSHIR tug'ilgan sana",
        "BirthDate",
      ),
    ),

    pinfl: normalizePinfl(
      read.raw(
        "JSHSHIR",
        "JSHSHR",
        "ЖШШИР",
        "ПНФЛ",
        "PINFL",
        "PNFL",
        "JSHSHIR raqami",
      ),
    ),

    document,
    documentSeries: series,
    documentNumber: number,

    phone: normalizePhone(phone),

    relationship,
    relationshipCode: relationshipCodeOf(relationship),

    cadasterNumber: read("Kadastr", "Kadastr raqami", "кадастр рақами", "Кадастр"),

    address: read("Manzil", "Manzili", "манзили", "Манзил", "Address"),

    // Faylning o'z MFY ustuni — guruh nomini aniqlashda ishlatiladi.
    mfyNameFromRow: mfyName,

    raw: row,
  };
};

// ---------------------------------------------------------------
// Guruhlar
// ---------------------------------------------------------------

/**
 * GET /api/uncadastred/groups
 *
 * MFY guruhlari ro'yxati. Har guruh uchun yozuvlar soni va oxirgi
 * yuklash ma'lumoti qaytariladi.
 */
export const getUncadastredGroups = async (req, res) => {
  const user = requireUser(res);
  if (!user) return;

  try {
    const groups = await UncadastredGroup.find({}).sort({ name: 1 }).lean();

    // MFY tokenlari — guruhni qaysi MFY ga biriktirish mumkinligini
    // client'ga ko'rsatish uchun (modalda tanlanadi).
    const tokens = await MfyToken.find({}, "uid username mahallaName").lean();

    return res.status(200).json({
      groups: groups.map((group) => ({
        id: String(group._id),
        name: group.name,
        mahallaKey: group.mahallaKey,
        mfyUid: group.mfyUid ?? null,
        total: group.total ?? 0,
        lastUploadMode: group.lastUploadMode ?? null,
        lastUploadAt: group.lastUploadAt ?? null,
        lastFileName: group.lastFileName ?? null,
      })),
      mfys: tokens.map((token) => ({
        uid: token.uid,
        name: token.mahallaName ?? token.username ?? token.uid,
      })),
    });
  } catch {
    return res.status(500).json({ message: "Server xatoligi" });
  }
};

/**
 * POST /api/uncadastred/groups  { name, mfyUid? }
 *
 * Bo'sh guruh yaratadi — ma'lumot keyin yuklanadi.
 */
export const createUncadastredGroup = async (req, res) => {
  const user = requireUser(res);
  if (!user) return;

  const name = String(req.body?.name ?? "").trim();
  if (!name) return res.status(400).json({ message: "MFY nomi kiritilmadi" });

  const key = mahallaKey(name);
  if (!key) {
    return res.status(400).json({ message: "MFY nomi noto'g'ri" });
  }

  try {
    const existing = await UncadastredGroup.findOne({ mahallaKey: key }).lean();
    if (existing) {
      return res.status(409).json({
        message: `"${existing.name}" guruhi allaqachon mavjud`,
      });
    }

    const group = await UncadastredGroup.create({
      name,
      mahallaKey: key,
      mfyUid: req.body?.mfyUid ? String(req.body.mfyUid) : undefined,
      total: 0,
    });

    return res.status(201).json({
      id: String(group._id),
      name: group.name,
      mahallaKey: group.mahallaKey,
      mfyUid: group.mfyUid ?? null,
      total: 0,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message || "Server xatoligi" });
  }
};

/**
 * PUT /api/uncadastred/groups/:groupId  { name?, mfyUid? }
 *
 * Guruh nomini yoki biriktirilgan MFY ni o'zgartiradi.
 */
export const updateUncadastredGroup = async (req, res) => {
  const user = requireUser(res);
  if (!user) return;

  const { groupId } = req.params;
  if (!mongoose.isValidObjectId(groupId)) {
    return res.status(400).json({ message: "Guruh ID noto'g'ri" });
  }

  try {
    const group = await UncadastredGroup.findById(groupId);
    if (!group) return res.status(404).json({ message: "Guruh topilmadi" });

    if (req.body?.name !== undefined) {
      const name = String(req.body.name).trim();
      const key = mahallaKey(name);
      if (!name || !key) {
        return res.status(400).json({ message: "MFY nomi noto'g'ri" });
      }

      // Nom o'zgarishi kalitni ham o'zgartiradi — boshqa guruh bilan
      // to'qnashmasligi kerak.
      if (key !== group.mahallaKey) {
        const clash = await UncadastredGroup.findOne({
          mahallaKey: key,
          _id: { $ne: group._id },
        }).lean();

        if (clash) {
          return res.status(409).json({
            message: `"${clash.name}" guruhi bilan bir xil nom`,
          });
        }
      }

      group.name = name;
      group.mahallaKey = key;

      // Yozuvlardagi nusxa ham yangilanadi — ular guruhdan mustaqil
      // o'qiladi (model izohiga qarang).
      await UncadastredCitizen.updateMany(
        { groupId: group._id },
        { $set: { mfyName: name, mahallaKey: key } },
      );
    }

    if (req.body?.mfyUid !== undefined) {
      group.mfyUid = req.body.mfyUid ? String(req.body.mfyUid) : null;
    }

    await group.save();

    return res.status(200).json({
      id: String(group._id),
      name: group.name,
      mahallaKey: group.mahallaKey,
      mfyUid: group.mfyUid ?? null,
      total: group.total ?? 0,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message || "Server xatoligi" });
  }
};

/**
 * DELETE /api/uncadastred/groups/:groupId
 *
 * Guruhni va undagi BARCHA yozuvlarni o'chiradi.
 */
export const deleteUncadastredGroup = async (req, res) => {
  const user = requireUser(res);
  if (!user) return;

  const { groupId } = req.params;
  if (!mongoose.isValidObjectId(groupId)) {
    return res.status(400).json({ message: "Guruh ID noto'g'ri" });
  }

  try {
    const group = await UncadastredGroup.findById(groupId).lean();
    if (!group) return res.status(404).json({ message: "Guruh topilmadi" });

    const result = await UncadastredCitizen.deleteMany({ groupId: group._id });
    await UncadastredGroup.deleteOne({ _id: group._id });

    return res.status(200).json({
      deleted: result.deletedCount,
      message: `"${group.name}" guruhi o'chirildi — ${result.deletedCount} ta yozuv`,
    });
  } catch {
    return res.status(500).json({ message: "Server xatoligi" });
  }
};

// ---------------------------------------------------------------
// Yuklash
// ---------------------------------------------------------------

/**
 * POST /api/uncadastred/upload
 *
 * Excel faylni guruhga yuklaydi.
 *
 * Maydonlar (form-data):
 *   file     — Excel fayl
 *   groupId  — mavjud guruhga yuklash
 *   mfyName  — yoki yangi guruh nomi (groupId berilmasa)
 *   mfyUid   — guruhni MFY tokeniga biriktirish (ixtiyoriy)
 *   mode     — "replace" (ustiga yozish) yoki "append" (qo'shish)
 *
 * `replace` guruhning FAQAT O'Z yozuvlarini o'chiradi — qolgan
 * guruhlarga tegilmaydi. (Umumiy bazada yuklash butun kolleksiyani
 * almashtiradi, bu yerda esa bunday qilish boshqa MFY ning ishini
 * yo'q qilib yuborardi.)
 */
export const uploadUncadastred = async (req, res) => {
  const user = requireUser(res);
  if (!user) return;

  if (!req.file) {
    return res.status(400).json({ message: "Fayl yuborilmadi" });
  }

  const mode = req.body?.mode === "append" ? "append" : "replace";

  try {
    const workbook = XLSX.read(req.file.buffer, {
      type: "buffer",
      // Sanalar `Date` bo'lib kelsin — matn ko'rinishida Excel ularni
      // turli formatda beradi va ajratish ishonchsiz bo'lardi.
      cellDates: true,
    });

    const sheetName = workbook.SheetNames[0];
    if (!sheetName) {
      return res.status(400).json({ message: "Fayl ichida varaq topilmadi" });
    }

    // raw: true — MUHIM. `false` bo'lsa Excel uzun raqamni
    // eksponensial MATN qilib beradi ("5.25072E+13") va JSHSHIR
    // butunlay buziladi (namunadagi faylda tekshirilgan).
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
      defval: null,
      raw: true,
    });

    if (!rows.length) {
      return res.status(400).json({ message: "Fayl bo'sh" });
    }

    const mapped = rows
      .map(mapRow)
      // F.I.Sh. ham, JSHSHIR ham bo'lmagan qator — bo'sh yoki
      // sarlavha qatori, undan foyda yo'q.
      .filter((item) => item.fullName || item.pinfl);

    if (!mapped.length) {
      return res.status(400).json({
        message:
          "Faylda mos ustunlar topilmadi (F.I.Sh. yoki Ism/Familiya, JSHSHIR)",
      });
    }

    // --- Guruhni aniqlaymiz ---
    let group = null;

    if (req.body?.groupId) {
      if (!mongoose.isValidObjectId(req.body.groupId)) {
        return res.status(400).json({ message: "Guruh ID noto'g'ri" });
      }

      group = await UncadastredGroup.findById(req.body.groupId);
      if (!group) return res.status(404).json({ message: "Guruh topilmadi" });
    } else {
      // Guruh ko'rsatilmagan — nomni modaldagi qiymatdan, u ham
      // bo'lmasa fayldagi MFY ustunidan olamiz.
      const fromRow = mapped.find((item) => item.mfyNameFromRow)?.mfyNameFromRow;
      const fromAddress = mapped
        .map((item) => extractMahallaName(item.address))
        .find(Boolean);

      const name = String(
        req.body?.mfyName ?? fromRow ?? fromAddress ?? "",
      ).trim();

      if (!name) {
        return res.status(400).json({
          message:
            "MFY nomi aniqlanmadi — modalda nom kiriting yoki faylga MFY ustunini qo'shing",
        });
      }

      const key = mahallaKey(name);
      if (!key) return res.status(400).json({ message: "MFY nomi noto'g'ri" });

      // Shu kalitli guruh bo'lsa unga yuklanadi, bo'lmasa yaratiladi.
      group = await UncadastredGroup.findOne({ mahallaKey: key });

      if (!group) {
        group = await UncadastredGroup.create({
          name,
          mahallaKey: key,
          mfyUid: req.body?.mfyUid ? String(req.body.mfyUid) : undefined,
          total: 0,
        });
      }
    }

    // MFY biriktirilishi so'ralgan bo'lsa — yangilaymiz.
    if (req.body?.mfyUid && group.mfyUid !== String(req.body.mfyUid)) {
      group.mfyUid = String(req.body.mfyUid);
    }

    // --- Yozuvlar ---
    if (mode === "replace") {
      await UncadastredCitizen.deleteMany({ groupId: group._id });
    }

    // Yozuvdagi MFY nomi guruhdan olinadi: faylda har qator uchun
    // boshqa nom bo'lishi mumkin, lekin guruh bitta — chalkashmaslik
    // uchun guruh nomi ustun.
    const documents = mapped.map((item, index) => {
      const { mfyNameFromRow, ...fields } = item;

      return {
        ...fields,
        groupId: group._id,
        mfyName: group.name,
        mahallaKey: group.mahallaKey,
        // Tartib raqami faylda bo'lmasa — o'zimiz qo'yamiz, shunda
        // sahifalash tartibi barqaror bo'ladi.
        rowNumber: fields.rowNumber ?? index + 1,
      };
    });

    for (let i = 0; i < documents.length; i += INSERT_CHUNK) {
      await UncadastredCitizen.insertMany(
        documents.slice(i, i + INSERT_CHUNK),
        { ordered: false },
      );
    }

    const total = await UncadastredCitizen.countDocuments({
      groupId: group._id,
    });

    group.total = total;
    group.lastUploadMode = mode;
    group.lastUploadAt = new Date();
    group.lastFileName = req.file.originalname ?? null;
    await group.save();

    // Nechta yozuvda JSHSHIR yo'q — xodim faylni tuzatishi uchun
    // darhol bilishi kerak (bunday odam platformaga kirmaydi).
    const withoutPinfl = documents.filter((item) => !item.pinfl).length;

    return res.status(200).json({
      groupId: String(group._id),
      groupName: group.name,
      mode,
      // Shu yuklashda qo'shilgan son.
      uploaded: documents.length,
      // Guruhdagi umumiy son (append bo'lsa oldingisi bilan).
      total,
      withoutPinfl,
      message:
        mode === "append"
          ? `"${group.name}" guruhiga ${documents.length} ta yozuv qo'shildi — jami ${total} ta`
          : `"${group.name}" guruhiga ${documents.length} ta yozuv yuklandi`,
    });
  } catch (err) {
    return res.status(400).json({
      message: err.message || "Faylni o'qishda xatolik yuz berdi",
    });
  }
};

// ---------------------------------------------------------------
// Ro'yxat va statistika
// ---------------------------------------------------------------

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Qidiruv filtri.
 *
 * Umumiy bazadagi (`citizen.controller.js: buildFilter`) bilan bir
 * xil mantiq: regex so'z BOSHIGA bog'lanadi, chunki katta
 * kolleksiyada o'rtadan qidirish indeksdan foydalana olmaydi.
 */
const buildFilter = (search, groupId) => {
  const filter = {};

  if (groupId) filter.groupId = new mongoose.Types.ObjectId(groupId);

  const query = String(search ?? "").trim();
  if (!query) return filter;

  const safe = escapeRegex(query);

  // Faqat raqam — JSHSHIR, hujjat raqami yoki telefon.
  if (/^\d+$/.test(query)) {
    filter.$or = [
      { pinfl: new RegExp(`^${safe}`) },
      { documentNumber: new RegExp(`^${safe}`) },
      { phone: new RegExp(safe) },
    ];
    return filter;
  }

  // Hujjat seriyasi bilan ("AA6658639", "III-AN0122343").
  if (/^[A-Za-z]/.test(query) && /\d/.test(query)) {
    filter.$or = [
      { document: new RegExp(`^${safe}`, "i") },
      { fullName: new RegExp(safe, "i") },
    ];
    return filter;
  }

  // F.I.Sh., MFY yoki manzil bo'yicha.
  filter.$or = [
    { fullName: new RegExp(safe, "i") },
    { lastName: new RegExp(`^${safe}`, "i") },
    { mfyName: new RegExp(safe, "i") },
    { address: new RegExp(safe, "i") },
  ];

  return filter;
};

const parsePage = (value) => {
  const page = Number.parseInt(value, 10);
  return Number.isFinite(page) && page > 0 ? page : 1;
};

/**
 * GET /api/uncadastred?groupId=&search=&page=
 *
 * Fuqarolar ro'yxatini sahifalab qaytaradi. `groupId` berilmasa —
 * barcha guruhlar bo'yicha.
 */
export const getUncadastred = async (req, res) => {
  const user = requireUser(res);
  if (!user) return;

  const groupId = req.query.groupId ? String(req.query.groupId) : null;

  if (groupId && !mongoose.isValidObjectId(groupId)) {
    return res.status(400).json({ message: "Guruh ID noto'g'ri" });
  }

  const page = parsePage(req.query.page);
  const filter = buildFilter(req.query.search, groupId);

  try {
    const total = await UncadastredCitizen.countDocuments(filter);
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const safePage = Math.min(page, totalPages);

    const items = await UncadastredCitizen.find(filter)
      .sort({ rowNumber: 1, _id: 1 })
      .skip((safePage - 1) * PAGE_SIZE)
      .limit(PAGE_SIZE)
      .lean();

    return res.status(200).json({
      items: items.map((item) => ({ ...item, id: String(item._id) })),
      page: safePage,
      pageSize: PAGE_SIZE,
      total,
      totalPages,
    });
  } catch {
    return res.status(500).json({ message: "Server xatoligi" });
  }
};

/**
 * GET /api/uncadastred/stats
 *
 * Umumiy ko'rsatkichlar: jami, JSHSHIR'i bor/yo'q, telefoni bor,
 * guruhlar soni.
 */
export const getUncadastredStats = async (req, res) => {
  const user = requireUser(res);
  if (!user) return;

  try {
    const [total, withPinfl, withPhone, withCadaster, groups] =
      await Promise.all([
        UncadastredCitizen.estimatedDocumentCount(),
        UncadastredCitizen.countDocuments({ pinfl: { $nin: [null, ""] } }),
        UncadastredCitizen.countDocuments({ phone: { $nin: [null, ""] } }),
        UncadastredCitizen.countDocuments({
          cadasterNumber: { $nin: [null, ""] },
        }),
        UncadastredGroup.countDocuments({}),
      ]);

    return res.status(200).json({
      total,
      withPinfl,
      withoutPinfl: total - withPinfl,
      withPhone,
      withCadaster,
      groups,
    });
  } catch {
    return res.status(500).json({ message: "Server xatoligi" });
  }
};

/**
 * DELETE /api/uncadastred/:citizenId
 *
 * Bitta yozuvni o'chiradi (xodim xato qatorni topib tashlasin).
 */
export const deleteUncadastredCitizen = async (req, res) => {
  const user = requireUser(res);
  if (!user) return;

  const { citizenId } = req.params;
  if (!mongoose.isValidObjectId(citizenId)) {
    return res.status(400).json({ message: "ID noto'g'ri" });
  }

  try {
    const citizen = await UncadastredCitizen.findById(citizenId).lean();
    if (!citizen) return res.status(404).json({ message: "Yozuv topilmadi" });

    await UncadastredCitizen.deleteOne({ _id: citizen._id });

    // Guruh sanog'ini to'g'rilaymiz.
    const total = await UncadastredCitizen.countDocuments({
      groupId: citizen.groupId,
    });
    await UncadastredGroup.updateOne(
      { _id: citizen.groupId },
      { $set: { total } },
    );

    return res.status(200).json({ deleted: 1, total });
  } catch {
    return res.status(500).json({ message: "Server xatoligi" });
  }
};
