import RawRecord from "../models/RawRecord.js";
import { getRequestUser } from "../utils/request-context.js";

const PAGE_SIZE = 100;

const parsePage = (value) => {
  const page = Number.parseInt(value, 10);
  return Number.isFinite(page) && page > 0 ? page : 1;
};

// Xonadon "to'liq" hisoblanadi, agar unda kamida bitta oila boshlig'i
// bo'lsa va hamma a'zoning JSHSHIR yoki hujjati mavjud bo'lsa.
const isHead = { $regexMatch: { input: { $ifNull: ["$relationship", ""] }, regex: /oila boshlig/i } };

// Xom yozuvlarni kadastr raqami bo'yicha guruhlab, xonadonlar
// ro'yxatini tuzadi. Xonadon — bu bitta kadastr raqami ostidagi
// barcha shaxslar (bir hovlida bir nechta oila bo'lishi mumkin,
// shuning uchun oila boshliqlari soni ham qaytariladi).
const buildHouseholdPipeline = (userUid, extraMatch = {}) => [
  { $match: { userUid, cadasterNumber: { $nin: [null, ""] }, ...extraMatch } },
  {
    $group: {
      _id: "$cadasterNumber",
      membersCount: { $sum: 1 },
      headsCount: { $sum: { $cond: [isHead, 1, 0] } },
      // Ro'yxatda ko'rsatish uchun oila boshliqlari ismlari. $first
      // bilan olsak, guruhning birinchi hujjati boshliq bo'lmasa null
      // qaytadi — shuning uchun hammasini yig'ib, keyin birinchisini
      // olamiz.
      headNames: { $push: { $cond: [isHead, "$fullName", "$$REMOVE"] } },
      anyName: { $first: "$fullName" },
      phones: { $addToSet: "$phone" },
      withPinfl: {
        $sum: { $cond: [{ $in: ["$pinfl", [null, ""]] }, 0, 1] },
      },
      birthCerts: {
        $sum: {
          $cond: [{ $eq: ["$documentType", "Tug'ilganlik guvohnomasi"] }, 1, 0],
        },
      },
      // Kadastri aniq bo'lmagan a'zo bormi (alternateCadasters to'ldirilgan)
      uncertain: {
        $sum: {
          $cond: [
            { $gt: [{ $size: { $ifNull: ["$alternateCadasters", []] } }, 0] },
            1,
            0,
          ],
        },
      },
    },
  },
  {
    $project: {
      _id: 0,
      cadasterNumber: "$_id",
      membersCount: 1,
      headsCount: 1,
      // Oila boshlig'i topilmasa, birinchi a'zo nomi ko'rsatiladi
      headName: { $ifNull: [{ $first: "$headNames" }, "$anyName"] },
      withPinfl: 1,
      birthCerts: 1,
      uncertain: 1,
      phone: {
        $first: {
          $filter: {
            input: "$phones",
            as: "p",
            cond: { $not: { $in: ["$$p", [null, ""]] } },
          },
        },
      },
    },
  },
  { $sort: { cadasterNumber: 1 } },
];

// Xonadonlar ro'yxatini sahifalab qaytaradi.
export const getRawHomes = async (req, res) => {
  const user = getRequestUser();
  if (!user) return res.status(401).json({ message: "Access key noto'g'ri" });

  const page = parsePage(req.query.page);
  const search = String(req.query.search ?? "").trim();

  try {
    const pipeline = buildHouseholdPipeline(user.uid);

    if (search) {
      // Kadastr raqami yoki oila boshlig'i ismi bo'yicha qidirish —
      // guruhlashdan keyin, chunki headName guruhlash natijasi.
      pipeline.push({
        $match: {
          $or: [
            { cadasterNumber: { $regex: search, $options: "i" } },
            { headName: { $regex: search, $options: "i" } },
          ],
        },
      });
    }

    const [result] = await RawRecord.aggregate([
      ...pipeline,
      {
        $facet: {
          items: [{ $skip: (page - 1) * PAGE_SIZE }, { $limit: PAGE_SIZE }],
          total: [{ $count: "n" }],
        },
      },
    ]);

    const total = result.total[0]?.n ?? 0;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

    return res.status(200).json({
      items: result.items,
      page: Math.min(page, totalPages),
      pageSize: PAGE_SIZE,
      total,
      totalPages,
    });
  } catch {
    return res.status(500).json({ message: "Server xatoligi" });
  }
};

// Xonadonlar bo'yicha umumiy statistika (KPI cardlar uchun).
export const getRawHomesStats = async (req, res) => {
  const user = getRequestUser();
  if (!user) return res.status(401).json({ message: "Access key noto'g'ri" });

  try {
    const households = await RawRecord.aggregate(
      buildHouseholdPipeline(user.uid),
    );

    const total = households.length;
    const complete = households.filter((h) => h.uncertain === 0).length;

    return res.status(200).json({
      total,
      complete,
      incomplete: total - complete,
      members: households.reduce((sum, h) => sum + h.membersCount, 0),
    });
  } catch {
    return res.status(500).json({ message: "Server xatoligi" });
  }
};

// Bitta xonadonning barcha a'zolarini qaytaradi. Kadastr raqami
// URL'da ":" belgilari bilan keladi, shuning uchun client tomonda
// encodeURIComponent bilan yuboriladi.
export const getRawHomeMembers = async (req, res) => {
  const user = getRequestUser();
  if (!user) return res.status(401).json({ message: "Access key noto'g'ri" });

  const cadasterNumber = String(req.params.cadasterNumber ?? "").trim();
  if (!cadasterNumber) {
    return res.status(400).json({ message: "Kadastr raqami ko'rsatilmagan" });
  }

  try {
    const members = await RawRecord.find({
      userUid: user.uid,
      cadasterNumber,
    }).sort({ rowNumber: 1 });

    if (!members.length) {
      return res.status(404).json({ message: "Xonadon topilmadi" });
    }

    return res.status(200).json({ cadasterNumber, members });
  } catch {
    return res.status(500).json({ message: "Server xatoligi" });
  }
};
