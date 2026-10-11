import api from "../config/api.js";
import RawRecord from "../models/RawRecord.js";
import Home from "../models/Home.js";
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

const familyAddKey = (userUid) => `familyAdd:${userUid}`;

// Platformaning qarindoshlik kodlari (add_family_member/relationship.json).
// Xom ma'lumotdagi nomlar biroz boshqacha yozilgan, shuning uchun
// moslashtirish jadvali alohida.
const RELATIONSHIP_CODES = {
  "o'g'li": 9,
  qizi: 8,
  ayoli: 7, // platformada "Turmush o'rtog'i"
  "turmush o'rtog'i": 7,
  kelini: 12,
  kuyovi: 14,
  nabirasi: 15,
  nabira: 15,
  otasi: 1,
  onasi: 2,
  opasi: 3,
  akasi: 4,
  singlisi: 5,
  ukasi: 6,
  qaynotasi: 10,
  qaynonasi: 11,
  jiyani: 13, // platformada aniq turi yo'q — "Boshqa"
  boshqa: 13,
};

// Hujjat turi kodlari (add_family_member/document_type.json).
const DOCUMENT_TYPE_CODES = {
  passport: 1,
  "id karta": 1,
  "tug'ilganlik guvohnomasi": 2,
};

// Apostrof shakllari (' ` ʻ ‘ ’) va katta-kichik harf farqini
// yo'qotib, moslashtirish jadvalidagi kalitga keltiradi.
const normalizeKey = (value) =>
  String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[`‘’ʻ']/g, "'");

const relationshipCode = (relationship) =>
  RELATIONSHIP_CODES[normalizeKey(relationship)] ?? null;

const documentTypeCode = (documentType) =>
  DOCUMENT_TYPE_CODES[normalizeKey(documentType)] ?? null;

// "DD.MM.YYYY" -> "YYYY-MM-DD" (platforma shu formatni kutadi).
const toIsoDate = (date) => {
  const match = String(date ?? "").match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!match) return null;

  const [, day, month, year] = match;
  return `${year}-${month}-${day}`;
};

const yearsOld = (isoBirthDate) => {
  const birth = new Date(isoBirthDate);
  if (Number.isNaN(birth.getTime())) return null;

  const diff = Date.now() - birth.getTime();
  return Math.floor(diff / (365.25 * 24 * 60 * 60 * 1000));
};

// Ta'lim darajasi xom ma'lumotda yo'q, lekin platforma uni talab
// qiladi. Yosh guruhiga qarab O'zbekiston bo'yicha taxminiy statistik
// taqsimot asosida tayinlanadi. Kodlar: 1-Oliy, 2-Tugallanmagan oliy,
// 3-O'rta maxsus, 4-O'rta, 5-Ma'lumoti yo'q.
const STUDY_LEVEL_WEIGHTS = [
  { maxAge: 6, weights: [[5, 100]] },
  { maxAge: 17, weights: [[4, 100]] },
  { maxAge: 24, weights: [[4, 50], [2, 25], [3, 25]] },
  { maxAge: 40, weights: [[1, 30], [3, 30], [4, 40]] },
  { maxAge: 60, weights: [[1, 20], [3, 35], [4, 45]] },
  { maxAge: Infinity, weights: [[1, 12], [3, 28], [4, 60]] },
];

const pickStudyLevel = (age) => {
  if (age === null) return 4;

  const group = STUDY_LEVEL_WEIGHTS.find((g) => age <= g.maxAge);
  let roll = Math.random() * 100;

  for (const [code, weight] of group.weights) {
    roll -= weight;
    if (roll <= 0) return code;
  }

  return group.weights[group.weights.length - 1][0];
};

// Oila boshlig'i platformada allaqachon xonadon egasi sifatida
// mavjud — uni qayta qo'shmaymiz.
const isHead = (relationship) =>
  /oila boshlig/i.test(String(relationship ?? ""));

/**
 * Bitta xom yozuvni platformaga yuborish uchun tayyorlaydi.
 * Yuborib bo'lmaydigan holatlarda { skip: sabab } qaytaradi —
 * bunday yozuv "skipped" deb belgilanadi va qayta urinilmaydi.
 */
const buildPayload = (record, home) => {
  if (isHead(record.relationship)) {
    return { skip: "Oila boshlig'i — platformada allaqachon mavjud" };
  }

  // Xom ma'lumotdagi "oila boshlig'i" platformadagi xonadon egasi
  // bilan har doim ham bir odam emas: ko'p holatda ro'yxat egasi
  // ayoli yoki farzandi nomiga rasmiylashtirilgan. Shunday yozuvni
  // a'zo sifatida qo'shib bo'lmaydi — u allaqachon egasi sifatida
  // turibdi, platforma 400 bilan rad etadi.
  if (record.pinfl && home.pinfl && String(record.pinfl) === String(home.pinfl)) {
    return {
      skip: "Platformada xonadon egasi sifatida ro'yxatda (a'zo qilib qo'shilmaydi)",
    };
  }

  const relationship = relationshipCode(record.relationship);
  if (!relationship) {
    return {
      skip: `Qarindoshlik turi mos kelmadi: "${record.relationship ?? "bo'sh"}"`,
    };
  }

  const documentType = documentTypeCode(record.documentType);
  if (!documentType) {
    return {
      skip: `Hujjat turi mos kelmadi: "${record.documentType ?? "bo'sh"}"`,
    };
  }

  const birthDate = toIsoDate(record.birthDate);
  if (!birthDate) {
    return { skip: "Tug'ilgan sana noto'g'ri yoki yo'q" };
  }

  // Guvohnomali bolalarda JSHSHIR bo'lmasligi mumkin — platforma
  // buni qabul qiladi (hujjat seriya/raqami orqali aniqlanadi).
  if (!record.documentSeries || !record.documentNumber) {
    return { skip: "Hujjat seriyasi yoki raqami yo'q" };
  }

  if (!home.pinfl) {
    return { skip: "Xonadon egasining JSHSHIR'i noma'lum" };
  }

  if (!home.surveyUuid) {
    return { skip: "Xonadonning survey_uuid'i yo'q (tafsilot yuklanmagan)" };
  }

  return {
    payload: {
      pinfl: record.pinfl ? Number(record.pinfl) : null,
      full_name: record.fullName,
      address: null,
      phone: record.phone ?? "",
      birth_date: birthDate,
      study_level_id: String(pickStudyLevel(yearsOld(birthDate))),
      doc_serial: record.documentSeries,
      doc_number: record.documentNumber,
      relationship: String(relationship),
      document_type: String(documentType),
    },
  };
};

// Platformaga bitta oila a'zosini qo'shadi va yangi yozuv ID'sini
// qaytaradi.
const postFamilyMember = (user, home, record, payload, progressKey) =>
  withRateLimit(
    () =>
      api.post("/web/v1/forms/survey_homes_family", payload, {
        params: {
          _target: "modal",
          pinfl: record.pinfl ?? home.pinfl,
          obl_id: user.oblId,
          area_id: user.areaId,
          district_id: user.districtId,
          street_id: home.streetId,
          survey_uuid: home.surveyUuid,
          owner_pinfl: home.pinfl,
        },
      }),
    {
      delayMs: 150,
      adaptiveKey: progressKey,
      onWait: progressKey
        ? (until) => {
            setSyncWaiting(progressKey, until);
            if (!until) return;

            const seconds = Math.ceil((until - Date.now()) / 1000);
            if (seconds >= 3) {
              console.log(
                `[Oila qo'shish] rate limitga yetildi, ${seconds} soniya kutilmoqda...`,
              );
            }
          }
        : undefined,
    },
  );

/**
 * Tashqi platforma xatoni turli shakllarda qaytaradi: ba'zan
 * { message }, ba'zan { errors: { maydon: [...] } }, ba'zan oddiy
 * matn. Axios'ning o'z xabari ("Request failed with status code 400")
 * esa sababni umuman ko'rsatmaydi. Shuning uchun javobni bosqichma-
 * bosqich ochib, eng foydali matnni chiqaramiz.
 */
const describeError = (err) => {
  const data = err.response?.data;

  if (!data) return err.message || "Noma'lum xatolik";

  if (typeof data === "string") {
    return data.slice(0, 300);
  }

  // Laravel/Yii uslubidagi validatsiya xatolari:
  // { errors: { full_name: ["majburiy"], pinfl: ["noto'g'ri"] } }
  if (data.errors && typeof data.errors === "object") {
    const parts = Object.entries(data.errors).map(([field, messages]) => {
      const text = Array.isArray(messages) ? messages.join(", ") : messages;
      return `${field}: ${text}`;
    });

    if (parts.length) return parts.join(" | ").slice(0, 400);
  }

  // Maydon -> xabar ko'rinishidagi tekis obyekt
  const direct = data.message ?? data.error ?? data.detail ?? data.title;
  if (typeof direct === "string" && direct) return direct.slice(0, 300);

  // Hech biri mos kelmasa — butun javobni ko'rsatamiz, chunki
  // "status code 400" dan ko'ra foydaliroq.
  try {
    return JSON.stringify(data).slice(0, 400);
  } catch {
    return err.message || "Noma'lum xatolik";
  }
};

// Jarayonning har bir qadami client terminaliga uzatiladi. Oxirgi
// N ta hodisa xotirada saqlanadi — client polling orqali o'qiydi.
const LOG_LIMIT = 500;
const logsByKey = new Map();

const pushLog = (key, entry) => {
  if (!logsByKey.has(key)) logsByKey.set(key, []);

  const logs = logsByKey.get(key);
  logs.push({ ...entry, at: Date.now() });
  if (logs.length > LOG_LIMIT) logs.shift();
};

export const getFamilyAddLogs = (key) => logsByKey.get(key) ?? [];

/**
 * Berilgan yozuvlarni ketma-ket platformaga qo'shadi. Har bir
 * natija (muvaffaqiyat, xato, o'tkazib yuborish) DB'ga yoziladi —
 * shuning uchun qayta ishga tushirilganda bir xil yozuv ikkinchi
 * marta yuborilmaydi.
 */
const addFamilyMembers = async (user, records, homesByCadaster) => {
  const key = familyAddKey(user.uid);
  const total = records.length;
  startSync(key, total);
  logsByKey.set(key, []);

  // Birinchi xatoda to'liq javobni bir marta chiqarish uchun.
  let firstErrorLogged = false;

  pushLog(key, { level: "info", message: `Boshlandi: ${total} ta yozuv` });
  console.log(`[Oila qo'shish] boshlandi: ${total} ta yozuv`);

  try {
    for (const [index, record] of records.entries()) {
      const position = index + 1;
      const startedAt = Date.now();
      const home = homesByCadaster.get(record.cadasterNumber);

      if (!home) {
        const reason = "Bu kadastr platformada topilmadi";
        await RawRecord.updateOne(
          { _id: record._id },
          {
            $set: {
              familyAddStatus: "skipped",
              familyAddError: reason,
              familyAddAt: new Date(),
            },
          },
        );

        pushLog(key, {
          level: "skip",
          position,
          total,
          fullName: record.fullName,
          message: reason,
        });
        tickSync(key, {
          failed: true,
          error: {
            recordId: String(record._id),
            fullName: record.fullName,
            reason,
          },
        });
        continue;
      }

      const { payload, skip } = buildPayload(record, home);

      if (skip) {
        await RawRecord.updateOne(
          { _id: record._id },
          {
            $set: {
              familyAddStatus: "skipped",
              familyAddError: skip,
              familyAddAt: new Date(),
              familyAddHomeId: home.homeId,
            },
          },
        );

        pushLog(key, {
          level: "skip",
          position,
          total,
          fullName: record.fullName,
          message: skip,
        });
        tickSync(key);
        continue;
      }

      pushLog(key, {
        level: "request",
        position,
        total,
        fullName: record.fullName,
        message: `POST survey_homes_family — ${record.relationship}, ${record.documentSeries} ${record.documentNumber}`,
        payload,
      });

      try {
        const response = await postFamilyMember(
          user,
          home,
          record,
          payload,
          key,
        );

        const memberId = response?.id != null ? String(response.id) : null;
        const ms = Date.now() - startedAt;

        await RawRecord.updateOne(
          { _id: record._id },
          {
            $set: {
              familyAddStatus: "success",
              familyAddMemberId: memberId,
              familyAddError: null,
              familyAddAt: new Date(),
              familyAddHomeId: home.homeId,
            },
          },
        );

        // Platformada yangi a'zo paydo bo'ldi — mahalliy nusxani
        // keyingi ochilishda qayta yuklash uchun belgini tozalaymiz.
        await Home.updateOne(
          { _id: home._id },
          { $set: { familySyncedAt: null } },
        );

        pushLog(key, {
          level: "success",
          position,
          total,
          fullName: record.fullName,
          message: `Qo'shildi — ID ${memberId}`,
          ms,
        });
        console.log(
          `[Oila qo'shish] ${position}/${total} — OK (${record.fullName}) ID=${memberId} ${ms}ms`,
        );

        tickSync(key);
      } catch (err) {
        const ms = Date.now() - startedAt;
        const reason = describeError(err);

        // Birinchi xatoda javobning to'liq tarkibini jurnalga
        // chiqaramiz — qisqartirilgan xabar sababni ko'rsatmasa,
        // shu yerdan aniqlanadi.
        if (!firstErrorLogged) {
          firstErrorLogged = true;

          const raw = (() => {
            try {
              return JSON.stringify(err.response?.data);
            } catch {
              return String(err.response?.data);
            }
          })();

          pushLog(key, {
            level: "error",
            message: `To'liq javob [HTTP ${err.response?.status}]: ${String(raw).slice(0, 900)}`,
          });
          console.log("--- Platforma javobi (diagnostika) ---");
          console.log("status :", err.response?.status);
          console.log("data   :", raw);
          console.log("payload:", JSON.stringify(payload));
          console.log("params :", JSON.stringify(err.config?.params));
          console.log("--------------------------------------");
        }

        await RawRecord.updateOne(
          { _id: record._id },
          {
            $set: {
              familyAddStatus: "failed",
              familyAddError: reason,
              familyAddAt: new Date(),
              familyAddHomeId: home.homeId,
            },
          },
        );

        pushLog(key, {
          level: "error",
          position,
          total,
          fullName: record.fullName,
          message: reason,
          status: err.response?.status,
          ms,
        });
        console.log(
          `[Oila qo'shish] ${position}/${total} — XATO (${record.fullName}): ${reason} ${ms}ms`,
        );

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

    const failed = getSyncProgress(key)?.failed ?? 0;
    pushLog(key, {
      level: "info",
      message: `Tugadi: ${total} tadan ${total - failed} tasi muvaffaqiyatli`,
    });
    console.log(
      `[Oila qo'shish] tugadi: ${total} tadan ${total - failed} tasi muvaffaqiyatli`,
    );
    finishSync(key);
  } catch (err) {
    pushLog(key, { level: "error", message: `Jarayon to'xtadi: ${err.message}` });
    failSync(key, err.message);
  }
};

// Kiritishga tayyor yozuvlar:
//  - hali urinilmagan (muvaffaqiyatli, xato va o'tkazib yuborilganlar
//    qayta yuborilmaydi — platformada dublikat paydo bo'lmasin);
//  - va so'nggi ma'lumotlarga yangilangan. Yangilanmagan yozuvni
//    kiritmaymiz: uning F.I.Sh./hujjati Excel'dagi eski holatda
//    bo'lishi mumkin, platformaga esa ishonchli ma'lumot kerak.
const pendingFilter = (userUid) => ({
  userUid,
  familyAddStatus: { $exists: false },
  $or: [
    { gcpSyncedAt: { $ne: null } },
    { birthCertSyncedAt: { $ne: null } },
  ],
});

/**
 * Oila a'zolarini platformaga qo'shishni background'da boshlaydi.
 */
export const startFamilyAdd = async (req, res) => {
  const user = getRequestUser();
  if (!user) return res.status(401).json({ message: "Access key noto'g'ri" });

  const key = familyAddKey(user.uid);
  if (isSyncRunning(key)) {
    return res.status(409).json({ message: "Jarayon allaqachon ketmoqda" });
  }

  const records = await RawRecord.find(pendingFilter(user.uid)).sort({
    cadasterNumber: 1,
    rowNumber: 1,
  });

  if (!records.length) {
    return res.status(200).json({ message: "Kiritiladigan yozuv yo'q" });
  }

  // Kadastr -> platforma xonadoni. Bir so'rovda yig'ib olamiz,
  // har yozuv uchun alohida DB so'rovi bo'lmasin.
  const homes = await Home.find({ userUid: user.uid });
  const homesByCadaster = new Map();
  for (const home of homes) {
    if (home.cadasterNumber) homesByCadaster.set(home.cadasterNumber, home);
  }

  addFamilyMembers(user, records, homesByCadaster);

  return res.status(202).json({ total: records.length });
};

/**
 * Jarayon holati + terminal loglari.
 */
export const getFamilyAddStatus = async (req, res) => {
  const user = getRequestUser();
  if (!user) return res.status(401).json({ message: "Access key noto'g'ri" });

  const key = familyAddKey(user.uid);
  const progress = getSyncProgress(key);

  // Client faqat yangi loglarni so'raydi (since = oxirgi olingan vaqt).
  const since = Number(req.query.since) || 0;
  const logs = getFamilyAddLogs(key).filter((entry) => entry.at > since);

  if (!progress) {
    return res.status(200).json({ status: "idle", logs });
  }

  return res.status(200).json({ ...progress, logs });
};

/**
 * Qo'shish bo'yicha umumiy statistika.
 */
export const getFamilyAddStats = async (req, res) => {
  const user = getRequestUser();
  if (!user) return res.status(401).json({ message: "Access key noto'g'ri" });

  try {
    const filter = { userUid: user.uid };

    const [total, success, failed, skipped, pending] = await Promise.all([
      RawRecord.countDocuments(filter),
      RawRecord.countDocuments({ ...filter, familyAddStatus: "success" }),
      RawRecord.countDocuments({ ...filter, familyAddStatus: "failed" }),
      RawRecord.countDocuments({ ...filter, familyAddStatus: "skipped" }),
      RawRecord.countDocuments(pendingFilter(user.uid)),
    ]);

    return res.status(200).json({
      total,
      success,
      failed,
      skipped,
      // Kiritishga tayyor (yangilangan va hali urinilmagan)
      pending,
      // Yangilanmagani uchun hozircha kiritib bo'lmaydiganlar
      notSynced: total - success - failed - skipped - pending,
    });
  } catch {
    return res.status(500).json({ message: "Server xatoligi" });
  }
};

/**
 * Xato bergan yozuvlarni qayta urinish uchun belgini tozalaydi.
 * Muvaffaqiyatli qo'shilganlarga tegilmaydi — platformada dublikat
 * paydo bo'lmasligi kerak.
 */
export const resetFailedFamilyAdd = async (req, res) => {
  const user = getRequestUser();
  if (!user) return res.status(401).json({ message: "Access key noto'g'ri" });

  try {
    const result = await RawRecord.updateMany(
      { userUid: user.uid, familyAddStatus: "failed" },
      {
        $unset: {
          familyAddStatus: 1,
          familyAddError: 1,
          familyAddAt: 1,
        },
      },
    );

    return res.status(200).json({ reset: result.modifiedCount });
  } catch {
    return res.status(500).json({ message: "Server xatoligi" });
  }
};
