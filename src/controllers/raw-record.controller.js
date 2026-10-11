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
    // Yozuv ikki manbadan yangilanishi mumkin: JSHSHIR'i borlar GCP
    // orqali, guvohnomalilar FHDYO orqali. Ikkalasidan birortasi
    // bo'lsa — yangilangan hisoblanadi.
    const synced = await RawRecord.countDocuments({
      ...filter,
      $or: [{ gcpSyncedAt: { $ne: null } }, { birthCertSyncedAt: { $ne: null } }],
    });

    // Hujjati eskirgan yozuvlar qayta so'ralmaydi, shuning uchun ular
    // "yangilanmagan" sonidan chiqariladi — aks holda bu son hech
    // qachon nolga tushmaydi va chalg'itadi.
    const expired = await RawRecord.countDocuments({
      ...filter,
      documentExpired: true,
    });

    return res.status(200).json({
      total,
      synced,
      expired,
      notSynced: total - synced - expired,
    });
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
        ? (until) => {
            setSyncWaiting(progressKey, until);
            if (!until) return;

            // Qisqa (1-2 soniyalik) qayta urinishlarni logga chiqarmaymiz —
            // ular oyna yangilanishini kutayotgan oddiy holat, va ketma-ket
            // kelganda terminalni bir xil qator bilan to'ldirib yuboradi.
            const seconds = Math.ceil((until - Date.now()) / 1000);
            if (seconds >= 3) {
              console.log(`[GCP sync] rate limitga yetildi, ${seconds} soniya kutilmoqda...`);
            }
          }
        : undefined,
    },
  ).then((response) => response.data);

// GCP hujjat turini uzun rasmiy nom bilan qaytaradi
// ("O'zbekiston Respublikasi fuqarosining ID-kartasi"). Jadvalda
// qisqa va o'qish oson bo'lishi uchun ikki nomga keltiramiz.
const shortenDocumentType = (type) => {
  if (!type) return null;
  if (/ID[- ]?karta/i.test(type)) return "ID karta";
  if (/pasport|passport/i.test(type)) return "Passport";
  // Guvohnomani ham bir xil shaklga keltiramiz. GCP uni turli
  // apostrof belgilari bilan qaytaradi ("Tug‘ilganlik", "Tug'ilganlik")
  // — platformaga yuborishdagi hujjat turi jadvali esa aniq matn
  // bo'yicha moslashtiradi, shuning uchun yagona shaklda yozamiz.
  if (/gu?vohnoma/i.test(type)) return "Tug'ilganlik guvohnomasi";
  return type;
};

// GCP "current_document" ni seriya va raqam birga yopishgan holda
// beradi. Ikki shakl uchraydi:
//   pasport/ID karta — "AE8520186"     (seriya "AE" + raqam "8520186")
//   guvohnoma        — "I-AN0833845"   (seriya "I-AN" + raqam "0833845")
// Jadvalda ular alohida ustunlarda ko'rinishi kerak, platformaga
// yuborishda ham doc_serial/doc_number alohida ketadi — shuning uchun
// ikkala shaklni ham ajratamiz. Kutilmagan shakl kelsa, ajratmasdan
// raqam sifatida qoldiramiz.
const splitDocument = (document) => {
  const value = String(document ?? "").trim().replace(/\s+/g, "");

  // Guvohnoma: rim raqami + "-" + ikki harf, keyin raqamlar.
  const cert = value.match(/^([IVX]+-[A-Z]{2})(\d+)$/i);
  if (cert) return { series: cert[1].toUpperCase(), number: cert[2] };

  const passport = value.match(/^([A-Z]{2})(\d{7})$/i);
  if (passport) return { series: passport[1].toUpperCase(), number: passport[2] };

  return { series: null, number: document ?? null };
};

// GCP javobidan RawRecord'ning F.I.Sh./hujjat/sana maydonlarini
// yangilash uchun kerakli qismini chiqarib oladi. GCP biror maydon
// uchun bo'sh/mavjud bo'lmagan qiymat qaytarsa, o'sha maydon $set'ga
// umuman kiritilmaydi — shunda mavjud (Excel'dan kelgan) qiymat DB'da
// o'zgarishsiz saqlanib qoladi, bo'sh qiymat bilan ustidan yozilmaydi.
//
// Javob { code, data: {...} } ko'rinishida keladi — haqiqiy maydonlar
// "data" ichida. Yuqori qatlamdan o'qisak hammasi undefined bo'lib,
// hech narsa yangilanmaydi.
const mapGcpUpdate = (gcpData) => {
  const person = gcpData.data ?? {};
  const document = person.documents?.[0];
  const { series, number } = splitDocument(person.current_document);

  const candidates = {
    fullName: person.full_name,
    birthDate: toDottedDate(person.birth_date),
    documentType: shortenDocumentType(document?.type),
    documentSeries: series,
    documentNumber: number,
  };

  const update = { gcpData, gcpSyncedAt: new Date() };

  for (const [field, value] of Object.entries(candidates)) {
    if (value !== null && value !== undefined && value !== "") {
      update[field] = value;
    }
  }

  return update;
};

// Tug'ilganlik guvohnomasi (seriya + raqam + sana) bo'yicha FHDYO
// bazasidan bolaning ma'lumotini olib qaytaradi. Bolalarda JSHSHIR
// bo'lmagani uchun GCP (pasport bazasi) ularni topa olmaydi —
// shuning uchun alohida manba.
const fetchBirthCertData = (series, number, birthDate, progressKey) =>
  withRateLimit(
    () =>
      api.get("/api/v2/fhdyo/act/birth", {
        params: { serial: series, number, birth_date: birthDate },
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
              console.log(`[Sync] rate limitga yetildi, ${seconds} soniya kutilmoqda...`);
            }
          }
        : undefined,
    },
  ).then((response) => response.data);

// FHDYO javobi ko'p qavatli. api config'dagi interceptor birinchi
// qavatni (axios'ning `res.data`), fetchBirthCertData esa ikkinchisini
// (javobning `data` maydonini) ochib beradi. Shuning uchun bu yerga
// { insert_data, birth_date2, info: { data: {...} } } ko'rinishida
// keladi va haqiqiy ma'lumot `info.data` ichida bo'ladi.
//
// Ilgari bu yerda yana bir `data` qavati o'qilgan edi — natijada
// funksiya HAR DOIM null qaytarib, guvohnomali bolalarning hammasi
// "Guvohnoma bo'yicha ma'lumot topilmadi" xatosi bilan tushgan.
const extractBirthCertPerson = (response) =>
  response?.info?.data ?? response?.data?.info?.data ?? null;

// FHDYO javobidan to'liq ismni yig'adi (u uch bo'lakda keladi).
const joinName = (surname, name, patronym) =>
  [surname, name, patronym]
    .map((part) => String(part ?? "").trim())
    .filter(Boolean)
    .join(" ")
    .toUpperCase() || null;

// FHDYO javobidan RawRecord maydonlarini tayyorlaydi. GCP mapping'i
// kabi, faqat haqiqiy qiymat kelgan maydonlar $set'ga kiritiladi —
// bo'sh javob mavjud (Excel'dan kelgan) ma'lumotni o'chirib yubormasin.
const mapBirthCertUpdate = (response) => {
  const person = extractBirthCertPerson(response);
  if (!person) return null;

  const candidates = {
    fullName: joinName(person.surname, person.name, person.patronym),
    birthDate: person.birth_date,
    // Guvohnoma seriyasi/raqami ham yangilanishi mumkin (masalan
    // dastlabki yozuvda xato bo'lsa).
    documentSeries: person.cert_series,
    documentNumber: person.cert_number,
    // Hujjat turini aniq yozib qo'yamiz: platformaga yuborishda
    // document_type kodi (2 = tug'ilganlik guvohnomasi) shu maydon
    // orqali aniqlanadi. Excel'da bu ustun bo'sh qolgan bo'lsa,
    // yozuv "Hujjat turi mos kelmadi" deb o'tkazib yuborilardi.
    documentType: "Tug'ilganlik guvohnomasi",
    // Bolaga JSHSHIR berilgan bo'lsa — saqlaymiz. Shundan keyin u
    // GCP orqali ham tekshiriladi (pasport/ID karta olgan bo'lishi
    // mumkin).
    pinfl: person.pinfl != null ? String(person.pinfl) : null,
    fatherFullName: joinName(
      person.father_surname,
      person.father_name,
      person.father_patronym,
    ),
    fatherPinfl: person.father_pinfl != null ? String(person.father_pinfl) : null,
    fatherBirthDate: person.father_birth_date,
    motherFullName: joinName(
      person.mother_surname,
      person.mother_name,
      person.mother_patronym,
    ),
    motherPinfl: person.mother_pinfl != null ? String(person.mother_pinfl) : null,
    motherBirthDate: person.mother_birth_date,
  };

  const update = { birthCertData: response, birthCertSyncedAt: new Date() };

  for (const [field, value] of Object.entries(candidates)) {
    if (value !== null && value !== undefined && value !== "") {
      update[field] = value;
    }
  }

  return update;
};

// Yozuv guvohnoma bo'yicha yangilanadimi? JSHSHIR bo'lmasa va
// guvohnoma seriyasi/raqami bo'lsa — ha.
const needsBirthCert = (record) =>
  !record.pinfl && record.documentSeries && record.documentNumber;

// GCP shaxsni topdi, lekin uning amaldagi hujjati yaroqsiz. Javob
// shunday keladi:
//   "Ma'lumot topilmadi (status = 1, status_name = aktiv,
//    doc_status = Yaroqsiz hujjat)"
// yoki "... doc_status = Yaroqli hujjat yo'q". Ikkalasi ham bir xil
// ma'noda: odam hujjatini yangilamaguncha javob o'zgarmaydi.
const isExpiredDocument = (gcpData) => {
  const message = String(gcpData?.message ?? "");
  return /doc_status\s*=\s*(Yaroqsiz hujjat|Yaroqli hujjat yo)/i.test(message);
};

// Joriy foydalanuvchining BARCHA xom yozuvlarini GCP orqali
// yangilashni background'da (rate-limit himoyasi bilan, ketma-ket)
// boshlaydi. Bitta yozuv xato bersa (masalan pinfl/sana noto'g'ri),
// qolganlarini yuklashda davom etadi — butun jarayon to'xtamaydi.
const syncRawRecordsWithGcp = async (user, records) => {
  const key = gcpSyncKey(user.uid);
  const total = records.length;
  startSync(key, total);

  console.log(`[Sync] boshlandi: jami ${total} ta yozuv`);

  try {
    for (const [index, record] of records.entries()) {
      const position = index + 1;
      const startedAt = Date.now();

      try {
        const isoBirthDate = toIsoDate(record.birthDate);

        if (!isoBirthDate) {
          throw new Error("Tug'ilgan sana noto'g'ri/yo'q");
        }

        // Yozuvni aniqlashning ikki yo'li bor va ular ketma-ket
        // ishlatiladi:
        //  1. JSHSHIR yo'q, lekin tug'ilganlik guvohnomasi bor —
        //     FHDYO bazasidan qidiramiz. U bolaning JSHSHIR'ini va
        //     ota-ona ma'lumotini qaytaradi.
        //  2. JSHSHIR ma'lum bo'lgach (yo avvaldan, yo 1-bosqichdan) —
        //     GCP'dan so'raymiz: bola pasport/ID karta olgan bo'lsa,
        //     hujjat ma'lumoti o'shanga yangilanadi.
        let pinfl = record.pinfl;
        let viaBirthCert = false;

        if (needsBirthCert(record)) {
          const certResponse = await fetchBirthCertData(
            record.documentSeries,
            record.documentNumber,
            isoBirthDate,
            key,
          );

          const certUpdate = mapBirthCertUpdate(certResponse);
          if (!certUpdate) {
            throw new Error(
              certResponse?.message || "Guvohnoma bo'yicha ma'lumot topilmadi",
            );
          }

          await RawRecord.updateOne({ _id: record._id }, { $set: certUpdate });
          pinfl = certUpdate.pinfl ?? null;
          viaBirthCert = true;
        }

        if (!pinfl) {
          if (viaBirthCert) {
            // Guvohnoma topildi, lekin JSHSHIR hali berilmagan —
            // bu xato emas, shunchaki GCP bosqichi o'tkazib yuboriladi.
            tickSync(key);
            console.log(
              `[Sync] ${position}/${total} — OK guvohnoma, JSHSHIR yo'q (${record.fullName}) ${Date.now() - startedAt}ms`,
            );
            continue;
          }
          throw new Error("JSHSHIR ham, tug'ilganlik guvohnomasi ham yo'q");
        }

        const gcpData = await fetchGcpData(pinfl, isoBirthDate, key);

        // code !== 0 — GCP bu JSHSHIR bo'yicha ma'lumot topa olmadi
        // (masalan bola hali pasport olmagan). Guvohnoma orqali
        // yangilangan bo'lsa, bu yetarli — xato deb hisoblamaymiz.
        if (!gcpData || gcpData.code !== 0) {
          if (viaBirthCert) {
            tickSync(key);
            console.log(
              `[Sync] ${position}/${total} — OK guvohnoma (pasport hali yo'q) (${record.fullName}) ${Date.now() - startedAt}ms`,
            );
            continue;
          }

          // Shaxs bazada bor, lekin amaldagi hujjati yaroqsiz
          // (muddati o'tgan, ID kartaga almashtirilmagan). Javob
          // odam hujjatini yangilamaguncha o'zgarmaydi — shuning
          // uchun belgilab qo'yamiz va boshqa so'ramaymiz.
          if (isExpiredDocument(gcpData)) {
            await RawRecord.updateOne(
              { _id: record._id },
              {
                $set: {
                  documentExpired: true,
                  documentExpiredAt: new Date(),
                  gcpData,
                },
              },
            );

            tickSync(key);
            console.log(
              `[Sync] ${position}/${total} — HUJJATI ESKIRGAN (${record.fullName}) ${Date.now() - startedAt}ms`,
            );
            continue;
          }

          throw new Error(gcpData?.message || "GCP'da ma'lumot topilmadi");
        }

        await RawRecord.updateOne(
          { _id: record._id },
          { $set: mapGcpUpdate(gcpData) },
        );

        tickSync(key);
        console.log(
          `[Sync] ${position}/${total} — OK${viaBirthCert ? " guvohnoma→pasport" : ""} (${record.fullName ?? pinfl}) ${Date.now() - startedAt}ms`,
        );
      } catch (err) {
        const reason =
          err.response?.data?.message || err.message || "Noma'lum xatolik";

        console.log(`[Sync] ${position}/${total} — XATO (${record.fullName ?? record.pinfl}): ${reason} ${Date.now() - startedAt}ms`);

        // Diagnostika: tashqi API 500 qaytarsa, javobning to'liq
        // tarkibini bir marta chiqaramiz — sababni aniqlash uchun.
        if (err.response?.status >= 500 && !globalThis.__loggedServerError) {
          globalThis.__loggedServerError = true;
          console.log("--- 500 javobi (diagnostika) ---");
          console.log("URL   :", err.config?.url);
          console.log("params:", JSON.stringify(err.config?.params));
          console.log("status:", err.response.status);
          console.log("data  :", JSON.stringify(err.response.data)?.slice(0, 600));
          console.log("--------------------------------");
        }

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

    console.log(`[Sync] tugadi: ${total} tadan ${total - (getSyncProgress(key)?.failed ?? 0)} tasi muvaffaqiyatli`);
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

  // Hujjati eskirgan deb belgilanganlarga so'rov yubormaymiz — odam
  // hujjatini yangilamaguncha javob o'zgarmaydi, bekorga vaqt va
  // rate-limit ketadi. Qayta urinish kerak bo'lsa, documentExpired
  // maydonini tozalash yetarli.
  const filter = { userUid: user.uid, documentExpired: { $ne: true } };

  // Hech bir manbadan (GCP yoki guvohnoma) yangilanmaganlar.
  if (onlyMissing) {
    filter.gcpSyncedAt = null;
    filter.birthCertSyncedAt = null;
  }

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
