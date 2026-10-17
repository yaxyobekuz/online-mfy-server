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
    if (run) {
      const scope = await resolveScope(run, user.uid);
      const [totals] = await RegistrationMember.aggregate([
        { $match: memberScopeMatch(scope) },
        { $group: { _id: null, totalMs: { $sum: "$durationMs" } } },
      ]);
      timeSpentMs = totals?.totalMs ?? 0;
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
      timeSpentMs,
    });
  } catch {
    return res.status(500).json({ message: "Server xatoligi" });
  }
};
