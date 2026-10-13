import api from "../config/api.js";
import Citizen from "../models/Citizen.js";
import Home from "../models/Home.js";
import Street from "../models/Street.js";
import { getRequestUser } from "../utils/request-context.js";
import { cadasterKey } from "../utils/cadaster.js";
import { extractMahallaName, mahallaKey } from "../utils/mahalla.js";
import { withRateLimit, getRateLimitState } from "../utils/rate-limit.js";

/**
 * "Hisoblash" — MFY ni BIR MARTA aniqlab oladigan amal.
 *
 * Muammo nimada edi: mahalla faqat NOM bo'yicha aniqlanardi
 * (fuqarolar bazasidagi manzil matnidan ajratib olinib, platforma
 * ma'lumoti bilan solishtirilardi). Yangi token uchun esa na
 * oldingi yurish, na yuklangan xonadon bo'ladi — natijada panel
 * "Bu token uchun mahalla aniqlanmadi" deb to'xtab qolardi, holbuki
 * fuqarolar bazasida o'sha mahallaning minglab odami turgan bo'ladi.
 *
 * Yechim: nomni umuman so'ramaymiz. Token qaysi MFY ga tegishli
 * bo'lsa, platforma FAQAT o'sha MFY ning ko'cha va xonadonlarini
 * qaytaradi — demak, o'sha xonadonlarning kadastri mahallani
 * o'zi aniqlab beradi. Kadastrlar fuqarolar bazasi bilan
 * solishtiriladi (faqat raqamlar bo'yicha, `cadasterKey`), topilgan
 * xonadonlar `homes` ga yoziladi.
 *
 * Shundan keyin mahalla nomi mos kelishi SHART EMAS: `resolveMahalla`
 * ham, `prepareQueue` ham `homes` dagi tayyor kadastrlardan
 * foydalanadi.
 *
 * Amal bir martalik: natija DB da qoladi, qayta bosish shart emas
 * (lekin xavfsiz — xonadonlar `upsert` bilan yangilanadi).
 */

// Bitta ko'chadagi xonadonlar sahifalab olinadi.
const PAGE_SIZE = 100;

// Jarayon holati — xotirada. SSE emas, oddiy so'rov bilan
// o'qiladi: amal bir martalik va bir necha daqiqa davom etadi.
const scans = new Map();

const scanState = (uid) =>
  scans.get(uid) ?? { status: "idle", stage: null, result: null, error: null };

const setScan = (uid, patch) =>
  scans.set(uid, { ...scanState(uid), ...patch });

const limited = (uid, fn) =>
  withRateLimit(fn, { delayMs: 150, adaptiveKey: `scan:${uid}` });

const fetchStreets = (user) =>
  limited(user.uid, () =>
    api.get("/api/v1/survey_homes/cache/street", {
      params: {
        obl_id: user.oblId,
        area_id: user.areaId,
        district_id: user.districtId,
      },
    }),
  ).then((response) => response.data?.results ?? []);

const fetchStreetHomes = async (user, streetId) => {
  const all = [];
  let page = 1;
  let total = Infinity;

  while ((page - 1) * PAGE_SIZE < total) {
    const response = await limited(user.uid, () =>
      api.get("/api/v1/survey_homes_street/cache/data", {
        params: {
          obl_id: user.oblId,
          area_id: user.areaId,
          district_id: user.districtId,
          street_id: streetId,
          // `surveyed` MAJBURIY: yuborilmasa platforma bo'sh
          // ro'yxat qaytaradi.
          surveyed: 0,
          page,
          size: PAGE_SIZE,
        },
      }),
    );

    const results = response.data?.results ?? [];
    all.push(...results);
    total = response.data?.total ?? 0;
    page += 1;

    // Himoya: `total` noto'g'ri kelsa sikl cheksiz aylanmasin.
    if (!results.length) break;
  }

  return all;
};

/**
 * Asosiy ish. So'rovni kutdirmaydi — fonda ketadi, client holatni
 * `/api/mahalla-scan/status` dan o'qiydi.
 */
const runScan = async (user) => {
  setScan(user.uid, {
    status: "running",
    stage: "Fuqarolar bazasi o'qilmoqda",
    error: null,
  });

  // 1. Fuqarolar bazasidagi kadastrlar — raqam bo'yicha indeks.
  //
  // Diqqat: butun baza (150 ming yozuv) emas, faqat UNIKAL
  // kadastrlar olinadi — ular ancha kam, xotiraga bemalol sig'adi.
  const citizenCadasters = await Citizen.distinct("cadasterNumber");

  // Kalit -> shu kalitga mos keluvchi ASL yozilishlar. Mahalla
  // nomini aniqlashda manzilni shu asl qiymatlar orqali topamiz.
  const citizenKeys = new Map();

  for (const value of citizenCadasters) {
    const key = cadasterKey(value);
    if (!key) continue;

    const bucket = citizenKeys.get(key);
    if (bucket) bucket.push(value);
    else citizenKeys.set(key, [value]);
  }

  // 2. Platformaning ko'chalari.
  setScan(user.uid, { stage: "Ko'chalar yuklanmoqda" });

  const streets = await fetchStreets(user);

  if (!streets.length) {
    throw new Error(
      "Platforma bu token uchun ko'cha qaytarmadi — token yaroqli ekanini tekshiring",
    );
  }

  await Street.bulkWrite(
    streets.map((street) => ({
      updateOne: {
        filter: { userUid: user.uid, streetId: String(street.id) },
        update: { $set: { name: street.name } },
        upsert: true,
      },
    })),
  );

  // 3. Har bir ko'chaning xonadonlari.
  const operations = [];
  let homesSeen = 0;

  // Mos kelgan kadastrlarning fuqarolar bazasidagi ASL yozilishi —
  // mahalla nomini shular orqali topamiz.
  const matchedOriginals = new Set();

  for (const [index, street] of streets.entries()) {
    setScan(user.uid, {
      stage: `Ko'chalar: ${index + 1}/${streets.length} — ${street.name}`,
    });

    let homes = [];

    try {
      homes = await fetchStreetHomes(user, String(street.id));
    } catch {
      // Bitta ko'cha yuklanmasa, qolganlari davom etadi.
      continue;
    }

    homesSeen += homes.length;

    for (const home of homes) {
      const key = cadasterKey(home.cadaster_number);
      if (!key) continue;

      const originals = citizenKeys.get(key);

      // Fuqarolar bazasida yo'q xonadon — bu MFY niki bo'lsa ham,
      // unga qo'shadigan odamimiz yo'q. Saqlamaymiz.
      if (!originals) continue;

      for (const original of originals) matchedOriginals.add(original);

      operations.push({
        updateOne: {
          filter: { userUid: user.uid, homeId: String(home.id) },
          update: {
            $set: {
              streetId: String(street.id),
              homeNum: home.home_num,
              cadasterNumber: home.cadaster_number,
              fullName: home.full_name,
              pinfl: home.pinfl != null ? String(home.pinfl) : null,
              mobilePhone: home.mobile_phone ?? null,
              ownershipType: home.ownership_type ?? null,
              surveyDate: home.survey_date ?? null,
            },
          },
          upsert: true,
        },
      });
    }
  }

  if (!operations.length) {
    throw new Error(
      `Mos xonadon topilmadi: platforma ${homesSeen} ta xonadon qaytardi, lekin ularning kadastri fuqarolar bazasida yo'q. Avval shu MFY ning Excel ro'yxatini yuklang.`,
    );
  }

  setScan(user.uid, { stage: "Xonadonlar saqlanmoqda" });

  // Katta ro'yxatni bo'lib yozamiz — bitta `bulkWrite` da o'n
  // minglab amal bo'lsa, so'rov hajmi cheklovga urilishi mumkin.
  for (let i = 0; i < operations.length; i += 500) {
    await Home.bulkWrite(operations.slice(i, i + 500));
  }

  // 4. Yorliq uchun mahalla nomi: topilgan kadastrlarga tegishli
  //    manzillardan eng ko'p uchragani.
  //
  // DIQQAT: bu faqat KO'RSATISH uchun. Nom topilmasa ham hisoblash
  // muvaffaqiyatli hisoblanadi — ish kadastr bo'yicha ketadi.
  setScan(user.uid, { stage: "Mahalla aniqlanmoqda" });

  const addresses = await Citizen.aggregate([
    { $match: { cadasterNumber: { $in: [...matchedOriginals] } } },
    { $group: { _id: "$address", count: { $sum: 1 } } },
  ]);

  const byKey = new Map();

  for (const row of addresses) {
    const name = extractMahallaName(row._id);
    if (!name) continue;

    const key = mahallaKey(name);
    if (!key) continue;

    const entry = byKey.get(key) ?? { key, name, count: 0 };
    entry.count += row.count;
    byKey.set(key, entry);
  }

  const best = [...byKey.values()].sort((a, b) => b.count - a.count)[0] ?? null;

  // Shu xonadonlarga tegishli fuqarolar soni — "nechta odam bilan
  // ishlaymiz" degan savolga javob.
  const peopleTotal = addresses.reduce((sum, row) => sum + row.count, 0);

  const result = {
    streets: streets.length,
    homesSeen,
    homesMatched: operations.length,
    cadasters: matchedOriginals.size,
    peopleTotal,
    mahalla: best ? { key: best.key, name: best.name } : null,
  };

  setScan(user.uid, { status: "done", stage: null, result });

  return result;
};

/**
 * POST /api/mahalla-scan
 *
 * Hisoblashni boshlaydi. So'rov darhol qaytadi — jarayon fonda
 * ketadi (ko'chalar ko'p bo'lsa bir necha daqiqa oladi).
 */
export const startMahallaScan = async (req, res) => {
  const user = getRequestUser();
  if (!user) return res.status(401).json({ message: "Access key noto'g'ri" });

  if (scanState(user.uid).status === "running") {
    return res.status(200).json({ message: "Hisoblash allaqachon ketmoqda" });
  }

  // Fonda ishga tushiramiz. `await` qilinmaydi: client javobni
  // kutib turmasligi kerak.
  runScan(user).catch((err) => {
    setScan(user.uid, {
      status: "error",
      stage: null,
      error: err?.message || "Hisoblashda xatolik",
    });
  });

  return res.status(202).json({ message: "Hisoblash boshlandi" });
};

/**
 * GET /api/mahalla-scan/status
 */
export const getMahallaScanStatus = async (req, res) => {
  const user = getRequestUser();
  if (!user) return res.status(401).json({ message: "Access key noto'g'ri" });

  const state = scanState(user.uid);

  // Oldingi hisoblash natijasi xotirada bo'lmasa ham (server qayta
  // ishga tushgan), DB dagi xonadonlar o'z o'rnida turadi — shuning
  // uchun "hisoblangan yoki yo'q" degan savolga shu son javob
  // beradi.
  const homesStored = await Home.countDocuments({ userUid: user.uid });

  return res.status(200).json({
    ...state,
    homesStored,
    rateLimit: getRateLimitState(`scan:${user.uid}`),
  });
};
