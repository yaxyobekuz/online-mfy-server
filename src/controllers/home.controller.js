import api from "../config/api.js";
import Home from "../models/Home.js";
import Street from "../models/Street.js";
import { getRequestUser } from "../utils/request-context.js";
import { withRateLimit } from "../utils/rate-limit.js";
import {
  startSync,
  tickSync,
  finishSync,
  failSync,
  getSyncProgress,
  isSyncRunning,
} from "../utils/home-sync-progress.js";

// "defects_info.value" tashqi API'dan JSON-string sifatida keladi;
// xavfsiz tarzda obyektga aylantiramiz.
const parseDefects = (defectsInfo) => {
  try {
    return JSON.parse(defectsInfo?.value ?? "{}");
  } catch {
    return {};
  }
};

// formData -> Home schema maydonlariga moslashtirish.
const mapHomeDetails = (formData) => ({
  passport: formData.passport,
  birthDate: formData.birth_date,
  address: formData.address,
  homeType: formData.home_type,
  homeRegistered: formData.home_registered,
  ownership: formData.ownership,
  propertyType: formData.property_type,
  electricity: formData.electricity,
  gas: formData.gas,
  drinkingWater: formData.drinking_water,
  irrigationWater: formData.irrigation_water,
  sewerage: formData.sewerage,
  incomeId: formData.income_id,
  monthIncomeId: formData.month_income_id,
  hasDebt: formData.has_debt,
  debtType: formData.debt_type,
  debtTypeOther: formData.debt_type_other,
  debtPurpose: formData.debt_purpose,
  debtPurposeOther: formData.debt_purpose_other,
  debtCausesShortage: formData.debt_causes_shortage,
  monthlyPayment: formData.monthly_payment,
  overduePayment: formData.overdue_payment,
  studyLevelId: formData.study_level_id,
  socialRegister: formData.social_register,
  womenNotebook: formData.women_notebook,
  youngNotebook: formData.young_notebook,
  subsidyApplications: formData.subsidy_applications,
  creditApplications: formData.credit_applications,
  surveyUuid: formData.survey_uuid,
  detailsSyncedAt: new Date(),
});

// Bitta xonadonning batafsil ma'lumotini tashqi API'dan olib qaytaradi
// (DB'ga yozmasdan, xom formData'ni).
const fetchHomeDetails = (user, homeId) =>
  withRateLimit(() =>
    api.get(`/web/v1/forms/survey_homes/${homeId}`, {
      params: {
        obl_id: user.oblId,
        area_id: user.areaId,
        district_id: user.districtId,
      },
    }),
  ).then((response) => response.formData);

const HOMES_PAGE_SIZE = 100;

// req.query.page'ni 1 dan boshlanadigan butun songa aylantiradi.
const parsePage = (value) => {
  const page = Number.parseInt(value, 10);
  return Number.isFinite(page) && page > 0 ? page : 1;
};

// Xonadonlarni sahifalab qaytaradi: bitta sahifada juda ko'p (minglab)
// qator DOM'ga chiqarilsa brauzer osilib qolishi mumkin, shuning uchun
// hamma joyda bir xil { items, page, pageSize, total, totalPages } shakli
// ishlatiladi.
const paginate = async (filter, page) => {
  const total = await Home.countDocuments(filter);
  const totalPages = Math.max(1, Math.ceil(total / HOMES_PAGE_SIZE));
  const safePage = Math.min(page, totalPages);

  const items = await Home.find(filter)
    .sort({ streetId: 1, homeNum: 1 })
    .skip((safePage - 1) * HOMES_PAGE_SIZE)
    .limit(HOMES_PAGE_SIZE);

  return { items, page: safePage, pageSize: HOMES_PAGE_SIZE, total, totalPages };
};

// Xonadon "faol" hisoblanadi, agar tafsiloti yuklangan bo'lib, JSHSHIR
// va tug'ilgan sana ikkalasi ham mavjud bo'lsa (HomesTable'dagi
// getHomeStatus bilan bir xil mezon). Faqat DB darajasida (aggregation
// orqali) hisoblanadi — jadval sahifalangani uchun client faqat bitta
// sahifani ko'radi, jami hisob esa butun to'plam bo'yicha kerak.
const buildStatsPipeline = (filter) => [
  { $match: filter },
  {
    $group: {
      _id: null,
      total: { $sum: 1 },
      active: {
        $sum: {
          $cond: [
            {
              $and: [
                { $ne: ["$pinfl", null] },
                { $ne: ["$pinfl", ""] },
                { $ne: ["$birthDate", null] },
                { $ne: ["$birthDate", ""] },
              ],
            },
            1,
            0,
          ],
        },
      },
    },
  },
];

const runStats = async (filter) => {
  const [result] = await Home.aggregate(buildStatsPipeline(filter));
  const total = result?.total ?? 0;
  const active = result?.active ?? 0;

  return { total, active, inactive: total - active };
};

// Foydalanuvchining berilgan ko'chasidagi xonadonlar bo'yicha
// jami/faol/nofaol sonini qaytaradi.
export const getStreetHomesStats = async (req, res) => {
  const user = getRequestUser();
  if (!user) return res.status(401).json({ message: "Access key noto'g'ri" });

  const { streetId } = req.params;

  try {
    const stats = await runStats({ userUid: user.uid, streetId });

    return res.status(200).json(stats);
  } catch {
    return res.status(500).json({ message: "Server xatoligi" });
  }
};

// Foydalanuvchining BARCHA ko'chalaridagi xonadonlar bo'yicha
// jami/faol/nofaol sonini qaytaradi.
export const getAllHomesStats = async (req, res) => {
  const user = getRequestUser();
  if (!user) return res.status(401).json({ message: "Access key noto'g'ri" });

  try {
    const stats = await runStats({ userUid: user.uid });

    return res.status(200).json(stats);
  } catch {
    return res.status(500).json({ message: "Server xatoligi" });
  }
};

// Foydalanuvchining DB'da saqlangan, berilgan ko'chaga tegishli
// xonadonlarini sahifalab qaytaradi (tashqi API'ga so'rov yubormasdan).
export const getStreetHomes = async (req, res) => {
  const user = getRequestUser();
  if (!user) return res.status(401).json({ message: "Access key noto'g'ri" });

  const { streetId } = req.params;
  const page = parsePage(req.query.page);

  try {
    const result = await paginate({ userUid: user.uid, streetId }, page);

    return res.status(200).json(result);
  } catch {
    return res.status(500).json({ message: "Server xatoligi" });
  }
};

// Foydalanuvchining DB'da saqlangan BARCHA ko'chalardagi xonadonlarini
// sahifalab qaytaradi (tashqi API'ga so'rov yubormasdan).
export const getAllHomes = async (req, res) => {
  const user = getRequestUser();
  if (!user) return res.status(401).json({ message: "Access key noto'g'ri" });

  const page = parsePage(req.query.page);

  try {
    const result = await paginate({ userUid: user.uid }, page);

    return res.status(200).json(result);
  } catch {
    return res.status(500).json({ message: "Server xatoligi" });
  }
};

// Bitta xonadonni qaytaradi. Agar batafsil ma'lumot hali yuklanmagan
// bo'lsa (lazy-load), tashqi API'dan bitta so'rov bilan olib, DB'ga
// keshlab qo'yadi — shundan keyingi so'rovlar tashqi API'ga bormaydi.
export const getHomeDetails = async (req, res) => {
  const user = getRequestUser();
  if (!user) return res.status(401).json({ message: "Access key noto'g'ri" });

  const { homeId } = req.params;

  try {
    const home = await Home.findOne({ userUid: user.uid, homeId });
    if (!home) return res.status(404).json({ message: "Xonadon topilmadi" });

    if (home.detailsSyncedAt) {
      return res.status(200).json(home);
    }

    const formData = await fetchHomeDetails(user, homeId);
    Object.assign(home, mapHomeDetails(formData));
    await home.save();

    return res.status(200).json(home);
  } catch (err) {
    const status = err.response?.status || 500;
    const message = err.response?.data?.message || "Server xatoligi";

    return res.status(status).json({ message });
  }
};

// Berilgan ko'cha uchun tashqi API'dan kadastr/xonadon ro'yxat
// ma'lumotlarini olib, DB'ga sinxronlaydi. Faqat ro'yxat maydonlarini
// upsert qiladi (deleteMany + insertMany EMAS!) — aks holda avval
// "Tafsilotlarni yuklash" orqali yig'ilgan batafsil ma'lumot (passport,
// tug'ilgan sana, kommunal xizmatlar va h.k.) har safar o'chib ketardi.
// Tashqi API'da endi mavjud bo'lmagan xonadonlar alohida o'chiriladi.
// Ichki funksiya sifatida ham (hammasini yangilashda), controller
// sifatida ham ishlatiladi.
const syncStreetHomes = async (user, streetId) => {
  const allResults = [];
  const size = 100;
  let page = 1;
  let total = Infinity;

  // Tashqi API paginatsiyalangan (size=100), shuning uchun barcha
  // sahifalarni ketma-ket olib, to'liq ro'yxatni yig'amiz.
  while ((page - 1) * size < total) {
    const response = await api.get("/api/v1/survey_homes_street/cache/data", {
      params: {
        obl_id: user.oblId,
        area_id: user.areaId,
        district_id: user.districtId,
        street_id: streetId,
        surveyed: 0,
        page,
        size,
      },
    });

    const { results, total: responseTotal } = response.data;
    allResults.push(...results);
    total = responseTotal;
    page += 1;
  }

  if (!allResults.length) {
    // Tashqi API'da bu ko'chada endi bironta xonadon qolmagan bo'lsa,
    // DB'dagi barcha eski yozuvlarni tozalaymiz.
    await Home.deleteMany({ userUid: user.uid, streetId });
    return [];
  }

  const currentHomeIds = allResults.map((home) => String(home.id));

  // Tashqi ro'yxatda endi bo'lmagan (o'chirilgan) xonadonlarni o'chiramiz.
  await Home.deleteMany({
    userUid: user.uid,
    streetId,
    homeId: { $nin: currentHomeIds },
  });

  // Faqat ro'yxat maydonlarini upsert qilamiz — mavjud hujjatning
  // tafsilot maydonlari (passport, birthDate, detailsSyncedAt, ...)
  // tegilmasdan qoladi.
  await Home.bulkWrite(
    allResults.map((home) => ({
      updateOne: {
        filter: { userUid: user.uid, streetId, homeId: String(home.id) },
        update: {
          $set: {
            homeNum: home.home_num,
            cadasterNumber: home.cadaster_number,
            fullName: home.full_name,
            mobilePhone: home.mobile_phone,
            pinfl: home.pinfl,
            ownershipType: home.ownership_type,
            surveyDate: home.survey_date,
            nextLink: home.next_link,
            defects: parseDefects(home.defects_info),
          },
        },
        upsert: true,
      },
    })),
  );

  return allResults.length;
};

// Xonadonlar minglab bo'lishi mumkin, shuning uchun javobda to'liq
// ro'yxatni emas, faqat sonini qaytaramiz — client keyin paginatsiyalangan
// GET /api/streets/:streetId/homes orqali kerakli sahifani o'zi so'raydi.
export const updateStreetHomes = async (req, res) => {
  const user = getRequestUser();
  if (!user) return res.status(401).json({ message: "Access key noto'g'ri" });

  const { streetId } = req.params;

  try {
    const count = await syncStreetHomes(user, streetId);

    return res.status(200).json({ total: count });
  } catch (err) {
    const status = err.response?.status || 500;
    const message = err.response?.data?.message || "Server xatoligi";

    return res.status(status).json({ message });
  }
};

// Foydalanuvchining DB'da saqlangan BARCHA ko'chalari bo'yicha, har
// birining xonadonlarini tashqi API'dan ketma-ket olib, sinxronlaydi.
// Bu ham to'liq ro'yxatni emas, faqat jami sonini qaytaradi.
export const updateAllHomes = async (req, res) => {
  const user = getRequestUser();
  if (!user) return res.status(401).json({ message: "Access key noto'g'ri" });

  try {
    const streets = await Street.find({ userUid: user.uid });

    let total = 0;
    for (const street of streets) {
      total += await syncStreetHomes(user, street.streetId);
    }

    return res.status(200).json({ total });
  } catch (err) {
    const status = err.response?.status || 500;
    const message = err.response?.data?.message || "Server xatoligi";

    return res.status(status).json({ message });
  }
};

// Berilgan xonadonlar ro'yxatining batafsil ma'lumotini, rate-limit
// himoyasi bilan (har so'rov orasida kechikish, 429'da backoff),
// ketma-ket yuklab, DB'ga saqlaydi. Progress'ni progressByUser orqali
// yuritadi, shu bilan client polling qila oladi. Har bir xato uchun
// homeId + sabab progress.errors'ga yoziladi (client'da modal orqali
// ko'rsatish uchun).
// Xonadon tafsiloti sync'ining progress kaliti — oila a'zolari sync'i
// bilan bir-birini bosib qo'ymasligi uchun alohida namespace bilan.
const homeDetailsSyncKey = (userUid) => `homeDetails:${userUid}`;

const syncHomesDetails = async (user, homes) => {
  const key = homeDetailsSyncKey(user.uid);
  startSync(key, homes.length);

  try {
    for (const home of homes) {
      try {
        const formData = await fetchHomeDetails(user, home.homeId);
        Object.assign(home, mapHomeDetails(formData));
        await home.save();
        tickSync(key);
      } catch (err) {
        // Bitta xonadon xato bersa ham, qolganlarini yuklashda davom
        // etamiz — butun jarayon bitta xato tufayli to'xtamasin.
        const reason =
          err.response?.data?.message || err.message || "Noma'lum xatolik";

        tickSync(key, {
          failed: true,
          error: {
            homeId: home.homeId,
            homeNum: home.homeNum,
            cadasterNumber: home.cadasterNumber,
            fullName: home.fullName,
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

// req.query.onlyMissing === "true" bo'lsa, faqat tafsiloti hali
// yuklanmagan (detailsSyncedAt bo'sh) xonadonlarni filtrlaydi.
const filterHomesToSync = (homes, onlyMissing) =>
  onlyMissing ? homes.filter((home) => !home.detailsSyncedAt) : homes;

// Berilgan ko'chadagi xonadonlarning batafsil ma'lumotini background'da
// yuklashni boshlaydi (javobni darhol qaytaradi).
export const syncStreetHomesDetails = async (req, res) => {
  const user = getRequestUser();
  if (!user) return res.status(401).json({ message: "Access key noto'g'ri" });

  if (isSyncRunning(homeDetailsSyncKey(user.uid))) {
    return res.status(409).json({ message: "Yuklash allaqachon ketmoqda" });
  }

  const { streetId } = req.params;
  const onlyMissing = req.query.onlyMissing === "true";

  const allHomes = await Home.find({ userUid: user.uid, streetId });
  const homes = filterHomesToSync(allHomes, onlyMissing);

  if (!homes.length) {
    return res.status(200).json({ message: "Yuklanadigan xonadon yo'q" });
  }

  // Background'da ishga tushiramiz, javobni kutmasdan darhol qaytaramiz.
  syncHomesDetails(user, homes);

  return res.status(202).json({ total: homes.length });
};

// Foydalanuvchining BARCHA ko'chalaridagi xonadonlarning batafsil
// ma'lumotini background'da yuklashni boshlaydi.
export const syncAllHomesDetails = async (req, res) => {
  const user = getRequestUser();
  if (!user) return res.status(401).json({ message: "Access key noto'g'ri" });

  if (isSyncRunning(homeDetailsSyncKey(user.uid))) {
    return res.status(409).json({ message: "Yuklash allaqachon ketmoqda" });
  }

  const onlyMissing = req.query.onlyMissing === "true";

  const allHomes = await Home.find({ userUid: user.uid });
  const homes = filterHomesToSync(allHomes, onlyMissing);

  if (!homes.length) {
    return res.status(200).json({ message: "Yuklanadigan xonadon yo'q" });
  }

  syncHomesDetails(user, homes);

  return res.status(202).json({ total: homes.length });
};

// Xonadonlar tafsilotini ommaviy yuklashning joriy progressini qaytaradi
// (client polling orqali so'rab turadi: done/total, foizi, xato soni).
export const getHomesDetailsSyncStatus = async (req, res) => {
  const user = getRequestUser();
  if (!user) return res.status(401).json({ message: "Access key noto'g'ri" });

  const progress = getSyncProgress(homeDetailsSyncKey(user.uid));
  if (!progress) {
    return res.status(200).json({ status: "idle" });
  }

  return res.status(200).json(progress);
};
