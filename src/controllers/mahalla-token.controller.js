import api from "../config/api.js";
import MahallaToken from "../models/MahallaToken.js";
import Home from "../models/Home.js";
import Citizen from "../models/Citizen.js";
import RegistrationRun from "../models/RegistrationRun.js";
import { getRequestUser, requestContext } from "../utils/request-context.js";
import { extractMahallaName, mahallaKey } from "../utils/mahalla.js";
import { isRunActive } from "../services/registration-worker.js";
import Street from "../models/Street.js";
import { withRateLimit } from "../utils/rate-limit.js";

const requireUser = (res) => {
  const user = getRequestUser();
  if (!user) {
    res.status(401).json({ message: "Access key noto'g'ri" });
    return null;
  }
  return user;
};

/**
 * Berilgan token kimga tegishli ekanini tashqi API'dan so'raydi.
 *
 * Token joriy so'rovnikidan boshqa bo'lgani uchun alohida kontekstda
 * chaqiriladi — aks holda interceptor joriy foydalanuvchi tokenini
 * qo'yib yuborardi.
 */
const whoIs = (token) =>
  requestContext.run({ token }, () => api.get("/auth/user_info"));

/**
 * Saqlangan tokenlar ro'yxati.
 *
 * Tokenning O'ZI hech qachon qaytarilmaydi — faqat kimga tegishli
 * ekani va holati.
 */
export const getMahallaTokens = async (req, res) => {
  const user = requireUser(res);
  if (!user) return;

  try {
    const tokens = await MahallaToken.find().sort({ createdAt: 1 }).lean();

    // Har token uchun: shu hududda nechta xonadon bor va yurish
    // qanday ketyapti.
    const runs = await RegistrationRun.find().sort({ createdAt: -1 }).lean();

    const items = await Promise.all(
      tokens.map(async (entry) => {
        const homes = await Home.countDocuments({ userUid: entry.uid });

        const run =
          runs.find((r) => r.userUid === entry.uid) ?? null;

        return {
          id: String(entry._id),
          uid: entry.uid,
          username: entry.username,
          label: entry.label || entry.username || entry.uid,
          oblId: entry.oblId,
          areaId: entry.areaId,
          districtId: entry.districtId,
          isValid: entry.isValid,
          lastCheckedAt: entry.lastCheckedAt,
          // Shu token bo'yicha platformadan yuklangan xonadonlar.
          homes,
          // Joriy foydalanuvchining o'z tokenimi?
          isCurrent: entry.uid === user.uid,
          run: run
            ? {
                id: String(run._id),
                mahallaName: run.mahallaName,
                mahallaKey: run.mahallaKey,
                status: run.status,
                homesDone: run.homesDone,
                homesTotal: run.homesTotal,
                membersAdded: run.membersAdded,
                membersFailed: run.membersFailed,
                isActive: isRunActive(run._id),
              }
            : null,
        };
      }),
    );

    return res.status(200).json({ items, total: items.length });
  } catch {
    return res.status(500).json({ message: "Server xatoligi" });
  }
};

/**
 * Yangi MFY tokenini qo'shadi.
 *
 * Token avval tashqi API'da tekshiriladi: kimga tegishli ekani va
 * hududi aniqlanadi. Yaroqsiz token saqlanmaydi.
 */
export const addMahallaToken = async (req, res) => {
  const user = requireUser(res);
  if (!user) return;

  const token = String(req.body?.token ?? "").trim();
  const label = String(req.body?.label ?? "").trim();

  if (!token) {
    return res.status(400).json({ message: "Token kiritilmagan" });
  }

  try {
    // Token haqiqiymi va kimga tegishli?
    let info;
    try {
      info = await whoIs(token);
    } catch {
      return res
        .status(400)
        .json({ message: "Token yaroqsiz — tashqi API qabul qilmadi" });
    }

    const uid = info?.uid;
    if (!uid) {
      return res
        .status(400)
        .json({ message: "Token egasi aniqlanmadi" });
    }

    const saved = await MahallaToken.findOneAndUpdate(
      { uid },
      {
        uid,
        username: info.username,
        fullName: info.fullName,
        oblId: info.oblId,
        areaId: info.areaId,
        districtId: info.districtId,
        token,
        label: label || info.username || uid,
        isValid: true,
        lastCheckedAt: new Date(),
        addedByUid: user.uid,
      },
      { upsert: true, returnDocument: "after" },
    );

    return res.status(201).json({
      id: String(saved._id),
      uid: saved.uid,
      username: saved.username,
      label: saved.label,
      districtId: saved.districtId,
      message: `"${saved.label}" qo'shildi`,
    });
  } catch (err) {
    return res
      .status(500)
      .json({ message: err.message || "Server xatoligi" });
  }
};

/**
 * Tokenni o'chiradi. Yurish ketayotgan bo'lsa ruxsat berilmaydi —
 * aks holda ishchi tokensiz qolardi.
 */
export const deleteMahallaToken = async (req, res) => {
  const user = requireUser(res);
  if (!user) return;

  try {
    const entry = await MahallaToken.findById(req.params.tokenId);
    if (!entry) return res.status(404).json({ message: "Token topilmadi" });

    const running = await RegistrationRun.findOne({
      userUid: entry.uid,
      status: { $in: ["preparing", "running"] },
    }).lean();

    if (running && isRunActive(running._id)) {
      return res.status(409).json({
        message: "Bu token bo'yicha jarayon ketmoqda — avval to'xtating",
      });
    }

    await MahallaToken.deleteOne({ _id: entry._id });

    return res.status(200).json({ message: "O'chirildi" });
  } catch {
    return res.status(500).json({ message: "Server xatoligi" });
  }
};

/**
 * Token hududidagi ko'chalar va xonadonlarni tashqi API'dan
 * yuklaydi.
 *
 * Nega alohida: yangi token qo'shilganda uning xonadonlari DB'da
 * bo'lmaydi, mahallalar ro'yxati esa shularga tayanadi ("qaysi
 * mahalla ishlashga tayyor?"). Yurishning o'zi ham xonadonlarni
 * yuklaydi, lekin u faqat BOSHLANGANDAN keyin — ya'ni mahallani
 * tanlash uchun bu ma'lumot oldinroq kerak.
 *
 * Fonda ishlaydi: 13 ko'cha uchun ~15 so'rov, rate-limit bilan
 * bir necha daqiqa ketadi.
 */
export const syncTokenHomes = async (req, res) => {
  const user = requireUser(res);
  if (!user) return;

  try {
    const entry = await MahallaToken.findById(req.params.tokenId).select(
      "+token",
    );
    if (!entry) return res.status(404).json({ message: "Token topilmadi" });

    // Fonda ishga tushiramiz — javobni kutmaymiz.
    loadTokenHomes(entry).catch((err) =>
      console.error(`[Token sync] ${entry.label}:`, err.message),
    );

    return res.status(202).json({
      message: `"${entry.label}" xonadonlari yuklanmoqda`,
    });
  } catch {
    return res.status(500).json({ message: "Server xatoligi" });
  }
};

// Token hududidagi barcha ko'cha va xonadonlarni DB'ga yozadi.
const loadTokenHomes = async (entry) => {
  const owner = {
    uid: entry.uid,
    oblId: entry.oblId,
    areaId: entry.areaId,
    districtId: entry.districtId,
  };

  await requestContext.run({ token: entry.token, user: owner }, async () => {
    const streetsResponse = await withRateLimit(
      () =>
        api.get("/api/v1/survey_homes/cache/street", {
          params: {
            obl_id: owner.oblId,
            area_id: owner.areaId,
            district_id: owner.districtId,
          },
        }),
      { delayMs: 150, adaptiveKey: `tokenSync:${owner.uid}` },
    );

    const streets = streetsResponse.data?.results ?? [];

    if (streets.length) {
      await Street.bulkWrite(
        streets.map((street) => ({
          updateOne: {
            filter: { userUid: owner.uid, streetId: String(street.id) },
            update: { $set: { name: street.name, userUid: owner.uid } },
            upsert: true,
          },
        })),
      );
    }

    console.log(`[Token sync] ${entry.label}: ${streets.length} ko'cha`);

    let total = 0;

    for (const street of streets) {
      let page = 1;
      let expected = Infinity;

      while ((page - 1) * 100 < expected) {
        const response = await withRateLimit(
          () =>
            api.get("/api/v1/survey_homes_street/cache/data", {
              params: {
                obl_id: owner.oblId,
                area_id: owner.areaId,
                district_id: owner.districtId,
                street_id: street.id,
                surveyed: 0,
                page,
                size: 100,
              },
            }),
          { delayMs: 150, adaptiveKey: `tokenSync:${owner.uid}` },
        );

        const results = response.data?.results ?? [];
        expected = response.data?.total ?? 0;
        page += 1;

        if (!results.length) break;

        await Home.bulkWrite(
          results.map((home) => ({
            updateOne: {
              filter: {
                userUid: owner.uid,
                streetId: String(street.id),
                homeId: String(home.id),
              },
              update: {
                $set: {
                  homeNum: home.home_num,
                  cadasterNumber: home.cadaster_number,
                  fullName: home.full_name,
                  mobilePhone: home.mobile_phone,
                  pinfl: home.pinfl != null ? String(home.pinfl) : null,
                  surveyDate: home.survey_date,
                },
              },
              upsert: true,
            },
          })),
        );

        total += results.length;
      }
    }

    console.log(`[Token sync] ${entry.label}: ${total} xonadon yuklandi`);
  });
};

/**
 * Token bo'yicha mahallalarni aniqlaydi.
 *
 * Tashqi API faqat token egasining hududini ko'rsatadi, mahalla nomi
 * esa fuqarolar bazasidagi manzilda bo'ladi. Shuning uchun: shu
 * foydalanuvchining xonadonlari kadastrlari -> fuqarolar bazasi ->
 * mahalla nomi.
 */
export const getTokenMahallas = async (req, res) => {
  const user = requireUser(res);
  if (!user) return;

  try {
    const entry = await MahallaToken.findById(req.params.tokenId).lean();
    if (!entry) return res.status(404).json({ message: "Token topilmadi" });

    const cadasters = (
      await Home.distinct("cadasterNumber", { userUid: entry.uid })
    ).filter(Boolean);

    if (!cadasters.length) {
      return res.status(200).json({
        items: [],
        message:
          "Bu token bo'yicha xonadonlar hali yuklanmagan — avval ko'chalar va xonadonlarni yuklang",
      });
    }

    // Kadastrlar -> manzillar -> mahallalar.
    const rows = await Citizen.aggregate([
      { $match: { cadasterNumber: { $in: cadasters } } },
      { $group: { _id: "$address", count: { $sum: 1 } } },
    ]);

    const byKey = new Map();

    for (const row of rows) {
      const name = extractMahallaName(row._id);
      if (!name) continue;

      const key = mahallaKey(name);
      if (!key) continue;

      if (!byKey.has(key)) {
        byKey.set(key, { key, nameCounts: new Map(), citizens: 0 });
      }

      const item = byKey.get(key);
      item.citizens += row.count;
      item.nameCounts.set(name, (item.nameCounts.get(name) ?? 0) + row.count);
    }

    const items = [...byKey.values()]
      .map((item) => {
        const names = [...item.nameCounts.entries()].sort((a, b) => b[1] - a[1]);
        return {
          key: item.key,
          name: names[0]?.[0] ?? item.key,
          citizens: item.citizens,
        };
      })
      .sort((a, b) => b.citizens - a.citizens);

    return res.status(200).json({ items, cadasters: cadasters.length });
  } catch {
    return res.status(500).json({ message: "Server xatoligi" });
  }
};
