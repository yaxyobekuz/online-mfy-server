import * as XLSX from "xlsx";
import Citizen from "../models/Citizen.js";
import { getRequestUser } from "../utils/request-context.js";
import { invalidateMahallaCache } from "./mahalla.controller.js";

const PAGE_SIZE = 100;

// 150 mingdan ortiq qator kelishi mumkin — hammasini bitta
// insertMany'ga bersak xotira ham, MongoDB'ning hujjat limiti ham
// yetmaydi. Shuning uchun bo'laklab yozamiz.
const INSERT_CHUNK = 5000;

const parsePage = (value) => {
  const page = Number.parseInt(value, 10);
  return Number.isFinite(page) && page > 0 ? page : 1;
};

// Excel ustun nomlari fayldan faylga biroz farq qiladi (lotin/kirill,
// katta-kichik harf, ortiqcha bo'shliq). Shuning uchun bir nechta
// variantni ketma-ket tekshiramiz.
const pick = (row, ...keys) => {
  for (const key of keys) {
    const value = row[key];
    if (value === undefined || value === null) continue;

    const text = String(value).trim();
    // Excel'dagi formula xatolari ("#Н/Д", "#N/A") — qiymat emas.
    if (!text || text.startsWith("#")) continue;

    return text;
  }
  return null;
};

// Hujjatni seriya va raqamga ajratadi:
//   "AA6658639"     -> AA     + 6658639   (pasport / ID karta)
//   "III-AN0122343" -> III-AN + 0122343   (tug'ilganlik guvohnomasi)
const splitDocument = (document) => {
  const value = String(document ?? "").trim().replace(/\s+/g, "");
  if (!value) return { series: null, number: null };

  const cert = value.match(/^([IVX]+-[A-Z]{2})(\d+)$/i);
  if (cert) return { series: cert[1].toUpperCase(), number: cert[2] };

  const passport = value.match(/^([A-Z]{2})(\d+)$/i);
  if (passport) return { series: passport[1].toUpperCase(), number: passport[2] };

  return { series: null, number: value };
};

// Excel sanalari ba'zan matn ("30.11.2020"), ba'zan seriya raqami
// (45000 kabi) bo'lib keladi. Ikkalasini ham "DD.MM.YYYY" ga keltiramiz.
const toDottedDate = (value) => {
  if (value === null || value === undefined) return null;

  const text = String(value).trim();
  if (!text) return null;

  if (/^\d{2}\.\d{2}\.\d{4}$/.test(text)) return text;

  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[3]}.${iso[2]}.${iso[1]}`;

  const slash = text.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (slash) {
    return `${slash[1].padStart(2, "0")}.${slash[2].padStart(2, "0")}.${slash[3]}`;
  }

  // Excel seriya raqami (1900-yil 1-yanvardan boshlab kunlar soni)
  const serial = Number(text);
  if (Number.isFinite(serial) && serial > 0 && serial < 60000) {
    const date = new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
    if (!Number.isNaN(date.getTime())) {
      const day = String(date.getUTCDate()).padStart(2, "0");
      const month = String(date.getUTCMonth() + 1).padStart(2, "0");
      return `${day}.${month}.${date.getUTCFullYear()}`;
    }
  }

  return text;
};

const mapRow = (row) => {
  const document = pick(row, "хужжат серия ва рақами", "Hujjat seriya va raqami");
  const { series, number } = splitDocument(document);

  return {
    rowNumber: Number(pick(row, "№", "N", "Т/р")) || null,
    fullName: pick(row, "FIO", "FISh", "F.I.Sh."),
    fullNameCyrillic: pick(row, "ФИШ", "Ф.И.Ш."),
    birthDate: toDottedDate(pick(row, "туғилган сана", "Tug'ilgan sana")),
    document,
    documentSeries: series,
    documentNumber: number,
    pinfl: pick(row, "ПНФЛ", "JSHSHIR", "ЖШШИР", "PINFL"),
    cadasterNumber: pick(row, "кадастр рақами", "Kadastr raqami"),
    address: pick(row, "манзили", "Manzili", "Manzil"),
    raw: row,
  };
};

/**
 * Excel faylni qabul qilib, umumiy fuqarolar bazasini almashtiradi.
 * Ma'lumot global bo'lgani uchun eski yozuvlar butunlay o'chiriladi —
 * fayl har safar to'liq ro'yxat bo'lib keladi.
 */
export const uploadCitizens = async (req, res) => {
  const user = getRequestUser();
  if (!user) return res.status(401).json({ message: "Access key noto'g'ri" });

  if (!req.file) {
    return res.status(400).json({ message: "Fayl yuborilmadi" });
  }

  try {
    const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
    const sheetName = workbook.SheetNames[0];

    if (!sheetName) {
      return res.status(400).json({ message: "Fayl ichida varaq topilmadi" });
    }

    // raw: false — sanalar va raqamlar matn ko'rinishida kelsin,
    // shunda JSHSHIR kabi uzun raqamlar eksponensial yozuvga
    // aylanib ketmaydi.
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
      defval: null,
      raw: false,
    });

    if (!rows.length) {
      return res.status(400).json({ message: "Fayl bo'sh" });
    }

    const mapped = rows
      .map(mapRow)
      // F.I.Sh. ham, JSHSHIR ham bo'lmagan qator — bo'sh/sarlavha
      // qatori bo'lishi mumkin, bunday yozuvdan foyda yo'q.
      .filter((item) => item.fullName || item.fullNameCyrillic || item.pinfl);

    if (!mapped.length) {
      return res.status(400).json({
        message: "Faylda mos ustunlar topilmadi (FIO, ПНФЛ, кадастр рақами)",
      });
    }

    await Citizen.deleteMany({});

    for (let i = 0; i < mapped.length; i += INSERT_CHUNK) {
      await Citizen.insertMany(mapped.slice(i, i + INSERT_CHUNK), {
        ordered: false,
      });
    }

    // Mahallalar ro'yxati shu ma'lumotdan hisoblanadi — keshni
    // tozalaymiz, aks holda eski ro'yxat ko'rinib qoladi.
    invalidateMahallaCache();

    return res.status(200).json({ total: mapped.length });
  } catch {
    return res
      .status(400)
      .json({ message: "Faylni o'qishda xatolik yuz berdi" });
  }
};

// Qidiruv so'rovidan MongoDB filtri yasaydi. Raqamlardan iborat so'rov
// JSHSHIR yoki hujjat raqami bo'lishi mumkin, qolgani — F.I.Sh. yoki
// manzil. Regex'ni boshiga bog'laymiz ("^..."), chunki 150 ming yozuvda
// o'rtadan qidirish indeksdan foydalana olmaydi.
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const buildFilter = (search) => {
  const query = String(search ?? "").trim();
  if (!query) return {};

  const safe = escapeRegex(query);

  // Kadastr raqami ("17:03:01:01:01:0001")
  if (/^[\d:]+$/.test(query) && query.includes(":")) {
    return { cadasterNumber: new RegExp(`^${safe}`) };
  }

  // Faqat raqam — JSHSHIR yoki hujjat raqami
  if (/^\d+$/.test(query)) {
    return {
      $or: [
        { pinfl: new RegExp(`^${safe}`) },
        { documentNumber: new RegExp(`^${safe}`) },
      ],
    };
  }

  // Hujjat seriyasi bilan ("AA6658639", "III-AN0122343")
  if (/^[A-Za-z]/.test(query) && /\d/.test(query)) {
    return {
      $or: [
        { document: new RegExp(`^${safe}`, "i") },
        { fullName: new RegExp(escapeRegex(query), "i") },
        { fullNameCyrillic: new RegExp(escapeRegex(query), "i") },
      ],
    };
  }

  // F.I.Sh. yoki manzil bo'yicha
  return {
    $or: [
      { fullName: new RegExp(safe, "i") },
      { fullNameCyrillic: new RegExp(safe, "i") },
      { address: new RegExp(safe, "i") },
    ],
  };
};

/**
 * Fuqarolar ro'yxatini sahifalab qaytaradi (qidiruv bilan).
 */
export const getCitizens = async (req, res) => {
  const user = getRequestUser();
  if (!user) return res.status(401).json({ message: "Access key noto'g'ri" });

  const page = parsePage(req.query.page);
  const filter = buildFilter(req.query.search);

  try {
    const total = await Citizen.countDocuments(filter);
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const safePage = Math.min(page, totalPages);

    const items = await Citizen.find(filter)
      .sort({ rowNumber: 1, _id: 1 })
      .skip((safePage - 1) * PAGE_SIZE)
      .limit(PAGE_SIZE)
      .lean();

    return res.status(200).json({
      items,
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
 * Umumiy statistika: jami, JSHSHIR'i bor/yo'q, kadastri bor.
 */
export const getCitizensStats = async (req, res) => {
  const user = getRequestUser();
  if (!user) return res.status(401).json({ message: "Access key noto'g'ri" });

  try {
    const [total, withPinfl, withCadaster, synced, expired] = await Promise.all([
      Citizen.estimatedDocumentCount(),
      Citizen.countDocuments({ pinfl: { $nin: [null, ""] } }),
      Citizen.countDocuments({ cadasterNumber: { $nin: [null, ""] } }),
      // Biror manbadan (GCP yoki guvohnoma) yangilanganlar
      Citizen.countDocuments({
        $or: [
          { gcpSyncedAt: { $ne: null } },
          { birthCertSyncedAt: { $ne: null } },
        ],
      }),
      Citizen.countDocuments({ documentExpired: true }),
    ]);

    return res.status(200).json({
      total,
      withPinfl,
      withoutPinfl: total - withPinfl,
      withCadaster,
      synced,
      notSynced: total - synced,
      expired,
    });
  } catch {
    return res.status(500).json({ message: "Server xatoligi" });
  }
};

/**
 * Butun bazani tozalaydi. Global ma'lumot bo'lgani uchun bu amal
 * barcha foydalanuvchilarga ta'sir qiladi.
 */
export const deleteCitizens = async (req, res) => {
  const user = getRequestUser();
  if (!user) return res.status(401).json({ message: "Access key noto'g'ri" });

  try {
    const result = await Citizen.deleteMany({});
    invalidateMahallaCache();

    return res.status(200).json({ deleted: result.deletedCount });
  } catch {
    return res.status(500).json({ message: "Server xatoligi" });
  }
};
