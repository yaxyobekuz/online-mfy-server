import RegistrationRun from "../models/RegistrationRun.js";
import RegistrationMember from "../models/RegistrationMember.js";
import RegistrationHome from "../models/RegistrationHome.js";
import Citizen from "../models/Citizen.js";
import MfyToken from "../models/MfyToken.js";
import { REASON_LABELS } from "../utils/registration-codes.js";
import { isRunActiveAnywhere } from "../services/registration-worker.js";

/**
 * BUTUN PLATFORMA bo'yicha statistika — barcha MFY lar birgalikda.
 *
 * Avvalgi statistika faqat bitta MFY ni ko'rsatardi. Bu endpoint
 * esa platformaning umumiy manzarasini beradi: jami qancha odam
 * kiritilgan, qaysi MFY lar faol, jarayon kunlar bo'yicha qanday
 * ketgan, nega kirmagan va h.k. — chiroyli dashboard uchun.
 */

const STUDY_LABELS = {
  1: "Oliy",
  2: "Tugallanmagan oliy",
  3: "O'rta maxsus",
  4: "O'rta",
  5: "Ma'lumoti yo'q",
};

const toMap = (rows) =>
  rows.reduce((acc, r) => {
    acc[r._id ?? "nomalum"] = r.count;
    return acc;
  }, {});

export const getPlatformStats = async (req, res) => {
  try {
    const [
      membersByStatus,
      homesByStatus,
      reasons,
      byStudyLevel,
      daily,
      elsewhere,
      timing,
      uniquePeople,
      runs,
      tokens,
      citizensTotal,
      homesTotal,
    ] = await Promise.all([
      // Odamlar holati (butun platforma).
      RegistrationMember.aggregate([
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),

      // Xonadonlar holati.
      RegistrationHome.aggregate([
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),

      // Kirmaganlik sabablari.
      RegistrationMember.aggregate([
        { $match: { status: { $in: ["failed", "skipped"] } } },
        {
          $group: {
            _id: "$reasonCode",
            count: { $sum: 1 },
            sample: { $first: "$reason" },
          },
        },
        { $sort: { count: -1 } },
      ]),

      // Ta'lim darajasi taqsimoti (kiritilganlar).
      RegistrationMember.aggregate([
        { $match: { status: "added", studyLevelCode: { $ne: null } } },
        { $group: { _id: "$studyLevelCode", count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]),

      // Kunlar kesimida kiritilganlar (added + exists).
      RegistrationMember.aggregate([
        { $match: { status: { $in: ["added", "exists"] } } },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
            added: {
              $sum: { $cond: [{ $eq: ["$status", "added"] }, 1, 0] },
            },
            exists: {
              $sum: { $cond: [{ $eq: ["$status", "exists"] }, 1, 0] },
            },
          },
        },
        { $sort: { _id: 1 } },
        { $limit: 90 },
      ]),

      // Ko'chib ketganlar geografiyasi (boshqa MFY da ro'yxatda).
      RegistrationMember.aggregate([
        { $match: { movedAway: true, registeredMahalla: { $ne: null } } },
        {
          $group: {
            _id: { region: "$registeredRegion", mahalla: "$registeredMahalla" },
            count: { $sum: 1 },
          },
        },
        { $sort: { count: -1 } },
        { $limit: 15 },
      ]),

      // Vaqt ko'rsatkichlari.
      RegistrationMember.aggregate([
        { $match: { durationMs: { $gt: 0 } } },
        {
          $group: {
            _id: null,
            avgMs: { $avg: "$durationMs" },
            sumMs: { $sum: "$durationMs" },
            n: { $sum: 1 },
          },
        },
      ]),

      // Unikal odamlar (butun platforma).
      RegistrationMember.aggregate([
        { $group: { _id: { $ifNull: ["$verifiedPinfl", { $ifNull: ["$pinfl", "$fullName"] }] } } },
        { $count: "n" },
      ]),

      // Har MFY bo'yicha yurishlar yig'indisi + progress.
      //
      // Progress (homesTotal/Done) KADASTR yurishidan olinadi: random
      // yurishda xonadon 0 bo'ladi va eng so'nggisini ko'r-ko'rona
      // olsak, progress 0 bo'lib qolardi. Shuning uchun avval random
      // bo'lmagan, keyin boshlangan yurishlar tartibida saralaymiz.
      RegistrationRun.aggregate([
        {
          $sort: {
            randomMode: 1, // false (0) oldinda
            createdAt: -1,
          },
        },
        {
          $group: {
            _id: "$userUid",
            // Mahalla nomi — nomi bor birinchi yurishdan.
            mahallaName: {
              $first: { $cond: [{ $ifNull: ["$mahallaName", false] }, "$mahallaName", "$$REMOVE"] },
            },
            status: { $first: "$status" },
            ownerId: { $first: "$ownerId" },
            heartbeatAt: { $first: "$heartbeatAt" },
            stage: { $first: "$stage" },
            homesTotal: { $first: "$homesTotal" },
            homesDone: { $first: "$homesDone" },
            lastRunAt: { $max: "$createdAt" },
            // Shu MFY ning BARCHA yurishlaridagi jami.
            membersAdded: { $sum: "$membersAdded" },
            runsCount: { $sum: 1 },
          },
        },
      ]),

      MfyToken.find({}).lean(),
      Citizen.estimatedDocumentCount(),
      RegistrationHome.estimatedDocumentCount(),
    ]);

    const members = toMap(membersByStatus);
    const homes = toMap(homesByStatus);

    // MFY ro'yxati: faollik, holat, progress. Token statusi bilan ham
    // boyitamiz (expired tokenlar ko'rinsin).
    const tokenByUid = new Map(tokens.map((t) => [t.uid, t]));

    const mahallas = runs
      .map((r) => {
        const active = isRunActiveAnywhere({
          _id: r._id,
          ownerId: r.ownerId,
          heartbeatAt: r.heartbeatAt,
        });
        const token = tokenByUid.get(r._id);

        return {
          uid: r._id,
          name: r.mahallaName ?? token?.username ?? r._id,
          status: r.status,
          active,
          tokenStatus: token?.status ?? null,
          hasToken: Boolean(token),
          stage: active ? (r.stage ?? null) : null,
          added: r.membersAdded ?? 0,
          homesTotal: r.homesTotal ?? 0,
          homesDone: r.homesDone ?? 0,
          percent:
            r.homesTotal > 0
              ? Math.round((r.homesDone / r.homesTotal) * 100)
              : 0,
          runsCount: r.runsCount,
          lastRunAt: r.lastRunAt,
        };
      })
      .sort((a, b) => b.added - a.added);

    // Faol MFY lar soni.
    const activeCount = mahallas.filter((m) => m.active).length;

    const totalMembers = Object.values(members).reduce((s, n) => s + n, 0);

    return res.status(200).json({
      // Yuqoridagi asosiy KPI lar.
      totals: {
        mahallas: mahallas.length,
        activeMahallas: activeCount,
        citizens: citizensTotal,
        homes: homesTotal,
        people: uniquePeople[0]?.n ?? 0,
        attempts: totalMembers,
        added: members.added ?? 0,
        exists: members.exists ?? 0,
        failed: members.failed ?? 0,
        skipped: members.skipped ?? 0,
        pending: members.pending ?? 0,
      },

      homes: {
        total: Object.values(homes).reduce((s, n) => s + n, 0),
        done: homes.done ?? 0,
        partial: homes.partial ?? 0,
        skipped: homes.skipped ?? 0,
        failed: homes.failed ?? 0,
        pending: homes.pending ?? 0,
        processing: homes.processing ?? 0,
      },

      mahallas,

      reasons: reasons.map((r) => ({
        code: r._id ?? "nomalum",
        label: REASON_LABELS[r._id] ?? r._id ?? "Noma'lum",
        count: r.count,
        sample: r.sample ?? null,
      })),

      byStudyLevel: byStudyLevel.map((r) => ({
        code: r._id,
        label: STUDY_LABELS[r._id] ?? r._id ?? "—",
        count: r.count,
      })),

      byDay: daily.map((r) => ({
        date: r._id,
        added: r.added,
        exists: r.exists,
      })),

      elsewhere: elsewhere.map((r) => ({
        region: r._id.region ?? "—",
        mahalla: r._id.mahalla ?? "—",
        count: r.count,
      })),

      timing: {
        avgMs: timing[0]?.avgMs ? Math.round(timing[0].avgMs) : null,
        totalHours: timing[0]?.sumMs
          ? Math.round((timing[0].sumMs / 3600000) * 10) / 10
          : 0,
        requests: timing[0]?.n ?? 0,
      },
    });
  } catch (err) {
    return res.status(500).json({ message: err.message || "Server xatoligi" });
  }
};
