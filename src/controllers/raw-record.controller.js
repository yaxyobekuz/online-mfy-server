import * as XLSX from "xlsx";
import api from "../config/api.js";
import RawRecord from "../models/RawRecord.js";
import { getRequestUser } from "../utils/request-context.js";
import { withRateLimit } from "../utils/rate-limit.js";
import {
  startSync,
  tickSync,
  finishSync,
  failSync,
  getSyncProgress,
  isSyncRunning,
  setSyncWaiting,
} from "../utils/home-sync-progress.js";

const PAGE_SIZE = 100;

const parsePage = (value) => {
  const page = Number.parseInt(value, 10);
  return Number.isFinite(page) && page > 0 ? page : 1;
};

// Excel'ning bitta qatorini (obyekt, ustun nomi -> qiymat) RawRecord
// schema maydonlariga moslashtiradi. Ustun nomlari fayl bo'yicha biroz
// farq qilishi mumkin bo'lgani uchun bir nechta variant tekshiriladi.
const pick = (row, ...keys) => {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && row[key] !== "") {
      return String(row[key]).trim();
    }
  }
  return null;
};

const mapRow = (row, userUid) => ({
  rowNumber: Number(pick(row, "№", "N", "Т/р", "T/r")) || null,
  fullName: pick(row, "FISh", "F.I.Sh.", "Ф.И.Ш."),
  cadasterNumber: pick(row, "Kadastr raqami", "Кадастр рақами"),
  relationship: pick(row, "Qarindoshligi", "Қариндошлиги"),
  pinfl: pick(row, "JSHSHR", "JSHSHIR", "ЖШШИР"),
  documentType: pick(row, "Hujjat turi"),
  documentSeries: pick(row, "Hujjat seriyasi"),
  documentNumber: pick(row, "Hujjat raqami"),
  phone: pick(row, "Tel raqam", "Telefon raqami"),
  cadasterSource: pick(row, "Kadastr manbasi"),
  birthDate: pick(row, "Tug'ilgan sana", "Tugilgan sana"),
  raw: row,
  userUid,
});

// Excel faylni (buffer) qabul qilib, birinchi varaqni o'qib, DB'ga
// saqlaydi. Foydalanuvchining avvalgi xom yozuvlari butunlay
// o'chirilib, yangi fayl bilan almashtiriladi.
export const uploadRawRecords = async (req, res) => {
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

    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: null });

    if (!rows.length) {
      return res.status(400).json({ message: "Fayl bo'sh" });
    }

    await RawRecord.deleteMany({ userUid: user.uid });

    const records = await RawRecord.insertMany(
      rows.map((row) => mapRow(row, user.uid)),
    );

    return res.status(200).json({ total: records.length });
  } catch {
    return res
      .status(400)
      .json({ message: "Faylni o'qishda xatolik yuz berdi" });
  }
};

// Joriy foydalanuvchining xom ma'lumotlarini sahifalab qaytaradi.
export const getRawRecords = async (req, res) => {
  const user = getRequestUser();
  if (!user) return res.status(401).json({ message: "Access key noto'g'ri" });

  const page = parsePage(req.query.page);

  try {
    const filter = { userUid: user.uid };
    const total = await RawRecord.countDocuments(filter);
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const safePage = Math.min(page, totalPages);

    const items = await RawRecord.find(filter)
      .sort({ rowNumber: 1 })
      .skip((safePage - 1) * PAGE_SIZE)
      .limit(PAGE_SIZE);

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

// O'zbekiston mobil operator kodlari — tasodifiy raqam generatsiya
// qilishda ishlatiladi.
const MOBILE_OPERATOR_CODES = ["90", "91", "93", "94", "95", "97", "99"];

const randomDigits = (length) =>
  Array.from({ length }, () => Math.floor(Math.random() * 10)).join("");

// 998 + operator kodi + 7 ta tasodifiy raqam = 12 xonali raqam.
const generateRandomPhone = () => {
  const operator =
    MOBILE_OPERATOR_CODES[
      Math.floor(Math.random() * MOBILE_OPERATOR_CODES.length)
    ];
  return `998${operator}${randomDigits(7)}`;
};

// Berilgan qiymatning faqat raqamlardan iboratligini (bo'shliq, tire,
// qavs, + belgilarini olib tashlagandan keyin) tekshiradi.
const extractDigits = (value) => String(value ?? "").replace(/\D/g, "");

// Telefon maydonini to'g'irlaydi:
//  - bo'sh bo'lsa yoki raqam bo'lmasa (masalan "Vafot etgan"): tasodifiy
//    12 xonali raqam bilan almashtiriladi;
//  - 9 xonali bo'lsa (masalan "91-609-14-57" -> "916091457"): oldiga
//    "998" prefiks qo'shilib 12 xonaga formatlanadi;
//  - allaqachon 12 xonali (va 998 bilan boshlansa) bo'lsa: o'zgarishsiz
//    qoladi.
const fixPhoneValue = (phone) => {
  const digits = extractDigits(phone);

  if (!digits) return generateRandomPhone();
  if (digits.length === 9) return `998${digits}`;
  if (digits.length === 12 && digits.startsWith("998")) return digits;
  if (digits.length === 12) return digits;

  // Boshqa uzunlikdagi (ehtimol matn ichidan chiqqan tasodifiy raqamlar)
  // qiymatlarni ham ishonchli bo'lmagani uchun tasodifiy raqam bilan
  // almashtiramiz.
  return generateRandomPhone();
};

// Joriy foydalanuvchining barcha yozuvlaridagi telefon raqamlarini
// tuzatadi: bo'sh/matn qiymatlarni tasodifiy raqam bilan to'ldiradi,
// 9 xonali raqamlarni 998 prefiksi bilan 12 xonaga formatlaydi.
export const fixRawRecordPhones = async (req, res) => {
  const user = getRequestUser();
  if (!user) return res.status(401).json({ message: "Access key noto'g'ri" });

  try {
    const records = await RawRecord.find({ userUid: user.uid });

    if (!records.length) {
      return res.status(200).json({ fixed: 0 });
    }

    const operations = records.map((record) => ({
      updateOne: {
        filter: { _id: record._id },
        update: { $set: { phone: fixPhoneValue(record.phone) } },
      },
    }));

    await RawRecord.bulkWrite(operations);

    return res.status(200).json({ fixed: operations.length });
  } catch {
    return res.status(500).json({ message: "Server xatoligi" });
  }
};

// Joriy foydalanuvchining xom yozuvlari bo'yicha jami/yangilangan/
// yangilanmagan sonini qaytaradi (GCP sync KPI cardlar uchun).
export const getRawRecordsStats = async (req, res) => {
  const user = getRequestUser();
  if (!user) return res.status(401).json({ message: "Access key noto'g'ri" });

  try {
    const filter = { userUid: user.uid };
    const total = await RawRecord.countDocuments(filter);
    const synced = await RawRecord.countDocuments({
      ...filter,
      gcpSyncedAt: { $ne: null },
    });

    return res.status(200).json({ total, synced, notSynced: total - synced });
  } catch {
    return res.status(500).json({ message: "Server xatoligi" });
  }
};

const gcpSyncKey = (userUid) => `gcp:${userUid}`;

// RawRecord.birthDate Excel'dan "DD.MM.YYYY" formatida keladi, GCP
// API esa "YYYY-MM-DD" formatini talab qiladi.
const toIsoDate = (birthDate) => {
  const match = String(birthDate ?? "").match(
    /^(\d{2})\.(\d{2})\.(\d{4})$/,
  );
  if (!match) return null;

  const [, day, month, year] = match;
  return `${year}-${month}-${day}`;
};

// GCP'dan keladigan "YYYY-MM-DD" formatini, mavjud RawRecord
// yozuvlarida ishlatiladigan "DD.MM.YYYY" formatiga o'tkazadi.
const toDottedDate = (isoDate) => {
  const match = String(isoDate ?? "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return isoDate ?? null;

  const [, year, month, day] = match;
  return `${day}.${month}.${year}`;
};

// Berilgan pinfl + tug'ilgan sana bo'yicha davlat pasport bazasidan
// (GCP) foydalanuvchining eng so'nggi ma'lumotini olib qaytaradi.
// `progressKey` berilsa, rate-limitga uchrab kutayotgan payt progress'da
// ko'rsatiladi (client "N soniya kutilmoqda" deb ko'rsatishi uchun).
const fetchGcpData = (pinfl, birthDate, progressKey) =>
  withRateLimit(
    () =>
      api.get("/api/v1/gcp/pinfl", {
        params: {
          pinfl,
          birth_date: birthDate,
          form_name: "survey_homes_family",
        },
      }),
    {
      delayMs: 150,
      adaptiveKey: progressKey,
      onWait: progressKey
        ? (until) => setSyncWaiting(progressKey, until)
        : undefined,
    },
  ).then((response) => response.data);

// GCP javobidan RawRecord'ning F.I.Sh./hujjat/sana maydonlarini
// yangilash uchun kerakli qismini chiqarib oladi. GCP biror maydon
// uchun bo'sh/mavjud bo'lmagan qiymat qaytarsa, o'sha maydon $set'ga
// umuman kiritilmaydi — shunda mavjud (Excel'dan kelgan) qiymat DB'da
// o'zgarishsiz saqlanib qoladi, bo'sh qiymat bilan ustidan yozilmaydi.
const mapGcpUpdate = (gcpData) => {
  const document = gcpData.documents?.[0];

  const candidates = {
    fullName: gcpData.full_name,
    birthDate: toDottedDate(gcpData.birth_date),
    documentType: document?.type,
    documentNumber: gcpData.current_document,
  };

  const update = { gcpData, gcpSyncedAt: new Date() };

  for (const [field, value] of Object.entries(candidates)) {
    if (value !== null && value !== undefined && value !== "") {
      update[field] = value;
    }
  }

  return update;
};

// Joriy foydalanuvchining BARCHA xom yozuvlarini GCP orqali
// yangilashni background'da (rate-limit himoyasi bilan, ketma-ket)
// boshlaydi. Bitta yozuv xato bersa (masalan pinfl/sana noto'g'ri),
// qolganlarini yuklashda davom etadi — butun jarayon to'xtamaydi.
const syncRawRecordsWithGcp = async (user, records) => {
  const key = gcpSyncKey(user.uid);
  startSync(key, records.length);

  try {
    for (const record of records) {
      try {
        const isoBirthDate = toIsoDate(record.birthDate);

        if (!record.pinfl || !isoBirthDate) {
          throw new Error("JSHSHIR yoki tug'ilgan sana noto'g'ri/yo'q");
        }

        const gcpData = await fetchGcpData(record.pinfl, isoBirthDate, key);

        if (!gcpData || Object.keys(gcpData).length === 0) {
          throw new Error("GCP'da ma'lumot topilmadi");
        }

        await RawRecord.updateOne(
          { _id: record._id },
          { $set: mapGcpUpdate(gcpData) },
        );

        tickSync(key);
      } catch (err) {
        const reason =
          err.response?.data?.message || err.message || "Noma'lum xatolik";

        tickSync(key, {
          failed: true,
          error: {
            recordId: String(record._id),
            fullName: record.fullName,
            pinfl: record.pinfl,
            reason,
          },
        });
      }
    }

    finishSync(key);
  } catch (err) {
    failSync(key, err.message);
  }
};

// Foydalanuvchining barcha xom yozuvlarini GCP orqali yangilashni
// background'da boshlaydi (javobni darhol qaytaradi).
export const syncRawRecordsGcp = async (req, res) => {
  const user = getRequestUser();
  if (!user) return res.status(401).json({ message: "Access key noto'g'ri" });

  const key = gcpSyncKey(user.uid);
  if (isSyncRunning(key)) {
    return res.status(409).json({ message: "Yuklash allaqachon ketmoqda" });
  }

  const onlyMissing = req.query.onlyMissing === "true";
  const filter = { userUid: user.uid };
  if (onlyMissing) filter.gcpSyncedAt = null;

  const records = await RawRecord.find(filter);

  if (!records.length) {
    return res.status(200).json({ message: "Yangilanadigan yozuv yo'q" });
  }

  // Background'da ishga tushiramiz, javobni kutmasdan darhol qaytaramiz.
  syncRawRecordsWithGcp(user, records);

  return res.status(202).json({ total: records.length });
};

// GCP orqali ommaviy yangilashning joriy progressini qaytaradi.
export const getRawRecordsGcpSyncStatus = async (req, res) => {
  const user = getRequestUser();
  if (!user) return res.status(401).json({ message: "Access key noto'g'ri" });

  const progress = getSyncProgress(gcpSyncKey(user.uid));
  if (!progress) {
    return res.status(200).json({ status: "idle" });
  }

  return res.status(200).json(progress);
};

// Joriy foydalanuvchining barcha xom ma'lumotlarini o'chiradi.
export const deleteRawRecords = async (req, res) => {
  const user = getRequestUser();
  if (!user) return res.status(401).json({ message: "Access key noto'g'ri" });

  try {
    await RawRecord.deleteMany({ userUid: user.uid });

    return res.status(200).json({ message: "O'chirildi" });
  } catch {
    return res.status(500).json({ message: "Server xatoligi" });
  }
};
