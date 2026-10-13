import RegistrationRun from "../models/RegistrationRun.js";
import RegistrationHome from "../models/RegistrationHome.js";
import RegistrationMember from "../models/RegistrationMember.js";
import { getRequestUser } from "../utils/request-context.js";
import { REASON_LABELS } from "../utils/registration-codes.js";

/**
 * Statistika sahifasi.
 *
 * Savol oddiy: nechta odam kiritildi, nechtasi kirmadi va NEGA.
 * Hisobot shu token egasining BARCHA yurishlari bo'yicha
 * hisoblanadi — mahalla bitta, yurishlar esa to'xtab-davom etgani
 * uchun bir nechta bo'lishi mumkin.
 */

const STUDY_LABELS = {
  1: "Oliy",
  2: "Tugallanmagan oliy",
  3: "O'rta maxsus",
  4: "O'rta",
  5: "Ma'lumoti yo'q",
};

export const getStatistics = async (req, res) => {
  const user = getRequestUser();
  if (!user) return res.status(401).json({ message: "Access key noto'g'ri" });

  try {
    const filter = { userUid: user.uid };

    const [
      run,
      membersByStatus,
      reasons,
      homesByStatus,
      byStudyLevel,
      timing,
      uniquePeople,
      elsewhere,
      daily,
    ] = await Promise.all([
      RegistrationRun.findOne(filter).sort({ createdAt: -1 }).lean(),

      // Odamlar holati bo'yicha.
      RegistrationMember.aggregate([
        { $match: filter },
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),

      // Sabablar — nega kirmadi. Guruhlash `reasonCode` bo'yicha
      // ketadi: erkin matnni guruhlab bo'lmaydi, platforma bir xil
      // sababni turli so'z bilan qaytaradi.
      RegistrationMember.aggregate([
        { $match: { ...filter, status: { $in: ["failed", "skipped"] } } },
        {
          $group: {
            _id: "$reasonCode",
            count: { $sum: 1 },
            // Namuna matn — kodning ortida nima turganini ko'rsatadi.
            sample: { $first: "$reason" },
          },
        },
        { $sort: { count: -1 } },
      ]),

      RegistrationHome.aggregate([
        { $match: filter },
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),

      // Ta'lim darajasi taqsimoti — statistik baholash qanday
      // taqsimlanganini ko'rish uchun.
      RegistrationMember.aggregate([
        { $match: { ...filter, status: "added" } },
        { $group: { _id: "$studyLevelCode", count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]),

      // O'rtacha tezlik — qolgan vaqtni taxmin qilish uchun.
      RegistrationMember.aggregate([
        { $match: { ...filter, durationMs: { $gt: 0 } } },
        { $group: { _id: null, avgMs: { $avg: "$durationMs" } } },
      ]),

      // Nechta UNIKAL odam bilan urinilgan. `total` urinishlar
      // sonini beradi: bir odam qayta urinilgan bo'lishi mumkin.
      RegistrationMember.aggregate([
        { $match: filter },
        { $group: { _id: { $ifNull: ["$pinfl", "$fullName"] } } },
        { $count: "n" },
      ]),

      // Boshqa joyda ro'yxatda turganlar — ya'ni ko'chib ketganlar.
      // Mahalla uchun bu shunchaki "xato" emas, amaliy ma'lumot.
      RegistrationMember.aggregate([
        { $match: { ...filter, registeredMahalla: { $ne: null } } },
        {
          $group: {
            _id: {
              region: "$registeredRegion",
              mahalla: "$registeredMahalla",
              movedAway: "$movedAway",
            },
            count: { $sum: 1 },
          },
        },
        { $sort: { count: -1 } },
        { $limit: 30 },
      ]),

      // Kunlar kesimida kiritilganlar — jarayon qanday ketayotgani
      // ko'rinib tursin.
      RegistrationMember.aggregate([
        { $match: { ...filter, status: { $in: ["added", "exists"] } } },
        {
          $group: {
            _id: {
              $dateToString: { format: "%Y-%m-%d", date: "$createdAt" },
            },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
        { $limit: 60 },
      ]),
    ]);

    const toMap = (rows) =>
      rows.reduce((acc, row) => {
        acc[row._id ?? "nomalum"] = row.count;
        return acc;
      }, {});

    const members = toMap(membersByStatus);
    const homes = toMap(homesByStatus);

    return res.status(200).json({
      mahallaName: run?.mahallaName ?? null,

      members: {
        // Urinishlar soni.
        total: Object.values(members).reduce((sum, n) => sum + n, 0),
        // Nechta unikal odam ko'rib chiqildi.
        people: uniquePeople[0]?.n ?? 0,
        added: members.added ?? 0,
        exists: members.exists ?? 0,
        failed: members.failed ?? 0,
        skipped: members.skipped ?? 0,
        pending: members.pending ?? 0,
      },

      homes: {
        total: Object.values(homes).reduce((sum, n) => sum + n, 0),
        done: homes.done ?? 0,
        partial: homes.partial ?? 0,
        skipped: homes.skipped ?? 0,
        failed: homes.failed ?? 0,
        pending: homes.pending ?? 0,
        processing: homes.processing ?? 0,
      },

      // Sabablar odam tiliga o'girilgan holda.
      reasons: reasons.map((row) => ({
        code: row._id ?? "nomalum",
        label: REASON_LABELS[row._id] ?? row._id ?? "Noma'lum",
        count: row.count,
        sample: row.sample ?? null,
      })),

      byStudyLevel: byStudyLevel.map((row) => ({
        code: row._id,
        label: STUDY_LABELS[row._id] ?? row._id ?? "—",
        count: row.count,
      })),

      byDay: daily.map((row) => ({ date: row._id, count: row.count })),

      // Boshqa joyda ro'yxatda turganlar: qayerda va nechtasi.
      elsewhere: elsewhere.map((row) => ({
        region: row._id.region ?? "—",
        mahalla: row._id.mahalla ?? "—",
        // true — butunlay boshqa mahallada (ko'chib ketgan),
        // false — shu mahallaning boshqa xonadonida.
        movedAway: Boolean(row._id.movedAway),
        count: row.count,
      })),

      avgMs: timing[0]?.avgMs ? Math.round(timing[0].avgMs) : null,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message || "Server xatoligi" });
  }
};
