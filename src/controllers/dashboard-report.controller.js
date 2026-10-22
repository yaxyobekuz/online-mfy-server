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
 * Son AYNAN "Ro'yxatga olingan aholi" kartochkasi bilan bir manbadan —
 * `RegistrationMember` yozuvlaridan — olinadi: holati `added` bo'lgan har
 * bir ODAM o'zi tegishli xonadon orqali (`homeRowId` -> `RegistrationHome`)
 * ko'chaga bog'lanadi va ko'cha bo'yicha sanaladi. Shuning uchun ko'chalar
 * yig'indisi kartochkadagi songa (masalan 1533) to'liq mos keladi.
 *
 * Nega xonadon sanog'i (`addedCount`) emas: u random/kadastrsiz rejimda
 * qo'shilganlarni to'liq qamramaydi va qayta ishlangan xonadonda qayta
 * yoziladi — natijada ko'chalar yig'indisi kartochkadan kam chiqardi.
 *
 * Hisob doirasi (`scope`) kartochkalar bilan bir xil `memberScopeMatch`
 * orqali beriladi.
 */
const collectStreetBreakdown = async (scope) => {
  if (!scope.runIds.length && !scope.randomRunIds.length) return [];

  const rows = await RegistrationMember.aggregate([
    { $match: { ...memberScopeMatch(scope), status: "added" } },
    {
      // Odamni ko'chaga bog'lash: urinish o'z xonadon yozuviga
      // (`homeRowId`) ishora qiladi, ko'cha nomi o'sha yerda turadi.
      $lookup: {
        from: "registrationhomes",
        localField: "homeRowId",
        foreignField: "_id",
        as: "home",
      },
    },
    {
      $group: {
        _id: {
          $ifNull: [
            { $arrayElemAt: ["$home.streetName", 0] },
            "Noma'lum ko'cha",
          ],
        },
        added: { $sum: 1 },
      },
    },
    { $sort: { added: -1, _id: 1 } },
  ]);

  return rows.map((row) => ({
    streetName: row._id,
    added: row.added,
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

      byStreet = await collectStreetBreakdown(scope);
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
