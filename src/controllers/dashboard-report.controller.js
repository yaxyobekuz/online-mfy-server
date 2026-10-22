import RegistrationHome from "../models/RegistrationHome.js";
import RegistrationMember from "../models/RegistrationMember.js";
import { getRequestUser } from "../utils/request-context.js";
import {
  collectStats,
  memberScopeMatch,
  pickVisibleRun,
  resolveMahalla,
  resolveScope,
} from "./dashboard.controller.js";

/**
 * Ko'chalar kesimida ro'yxatga olingan aholi.
 *
 * Har bir xonadon yozuvida (`RegistrationHome`) o'sha xonadonda shu
 * yurishda haqiqatan qo'shilgan odamlar soni (`addedCount`) va ko'cha
 * nomi (`streetName`) turadi. Shuning uchun ko'cha bo'yicha "nechtadan
 * kiritildi" ni to'g'ridan-to'g'ri shu yerdan yig'ib olamiz — hisob
 * doirasi (qaysi yurishlar) kartochkalar bilan bir xil `scope.runIds`
 * dan keladi.
 *
 * Xonadonlar soni ham sanaladi: ishlab bo'lingan / jami — xodim qaysi
 * ko'cha to'liq yopilganini ko'rishi uchun.
 */
const collectStreetBreakdown = async (runIds) => {
  if (!runIds.length) return [];

  const rows = await RegistrationHome.aggregate([
    { $match: { runId: { $in: runIds } } },
    {
      // Bir kadastr bir necha yurishda uchrashi mumkin — har
      // xonadondan BITTA yozuv (eng ko'p qo'shgani) olinadi, aks holda
      // qayta ishlangan xonadon ikki marta sanalardi.
      $group: {
        _id: { $ifNull: ["$cadasterNumber", "$_id"] },
        streetName: { $first: "$streetName" },
        added: { $max: { $ifNull: ["$addedCount", 0] } },
      },
    },
    {
      $group: {
        _id: { $ifNull: ["$streetName", "Noma'lum ko'cha"] },
        added: { $sum: "$added" },
        homes: { $sum: 1 },
      },
    },
    { $sort: { added: -1, _id: 1 } },
  ]);

  return rows.map((row) => ({
    streetName: row._id,
    added: row.added,
    homes: row.homes,
  }));
};

/**
 * GET /api/dashboard/report
 *
 * PDF hisobot uchun jamlama. Sonlar asosiy sahifadagi kartochkalar
 * bilan BIR XIL manbadan (`collectStats`) olinadi, shuning uchun
 * hisobotdagi raqamlar sahifada ko'ringanlar bilan mos keladi.
 *
 * Sarflangan vaqt — shu hisob doirasidagi har bir urinishning
 * `durationMs` yig'indisi. Bu "O'rtacha 1ta so'rov" ko'rsatkichi
 * bilan bir xil ta'rif.
 */
export const getDashboardReport = async (req, res) => {
  const user = getRequestUser();
  if (!user) return res.status(401).json({ message: "Access key noto'g'ri" });

  try {
    const [mahalla, run] = await Promise.all([
      resolveMahalla(user),
      pickVisibleRun(user.uid),
    ]);

    const stats = await collectStats(run, user.uid);

    let timeSpentMs = 0;
    let byStreet = [];
    if (run) {
      const scope = await resolveScope(run, user.uid);
      const [totals] = await RegistrationMember.aggregate([
        { $match: memberScopeMatch(scope) },
        { $group: { _id: null, totalMs: { $sum: "$durationMs" } } },
      ]);
      timeSpentMs = totals?.totalMs ?? 0;

      byStreet = await collectStreetBreakdown(scope.runIds);
    }

    return res.status(200).json({
      mahallaName: mahalla?.name ?? null,
      generatedAt: new Date().toISOString(),
      run: run
        ? {
            status: run.status,
            startedAt: run.startedAt ?? null,
            finishedAt: run.finishedAt ?? null,
            randomMode: run.randomMode ?? false,
          }
        : null,
      homes: {
        total: stats.homesTotal,
        done: stats.homesDone,
        percent: stats.percent,
      },
      people: {
        total: stats.peopleTotal,
        added: stats.added,
        exists: stats.exists,
        movedAway: stats.movedAway,
        failed: stats.failed,
        pending: stats.pending,
      },
      byStreet,
      timeSpentMs,
    });
  } catch {
    return res.status(500).json({ message: "Server xatoligi" });
  }
};
