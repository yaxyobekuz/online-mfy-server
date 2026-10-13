import mongoose from "mongoose";
import Citizen from "../models/Citizen.js";
import Home from "../models/Home.js";
import RegistrationRun from "../models/RegistrationRun.js";
import RegistrationHome from "../models/RegistrationHome.js";
import RegistrationMember from "../models/RegistrationMember.js";
import { getRequestUser, getRequestToken } from "../utils/request-context.js";
import { extractMahallaName, mahallaKey } from "../utils/mahalla.js";
import { getRateLimitState } from "../utils/rate-limit.js";
import { REASON_LABELS } from "../utils/registration-codes.js";
import {
  runRegistration,
  isRunActiveAnywhere,
  runOwner,
} from "../services/registration-worker.js";

/**
 * Asosiy sahifa (boshqaruv paneli) uchun yagona endpoint.
 *
 * Nega alohida controller: eski `registration.controller.js` bir
 * nechta MFY ni yonma-yon boshqarishga mo'ljallangan edi — mahalla
 * ro'yxati, tanlov, tokenlar paneli. Endi ish BITTA token bilan
 * ketadi: foydalanuvchi kirgan seansning tokeni qaysi MFY ga
 * tegishli bo'lsa, o'sha mahalla ustida ishlanadi. Shuning uchun
 * client'ga "qaysi mahalla, qaysi yurish" degan savol umuman
 * berilmaydi — server o'zi aniqlaydi.
 *
 * Bir nechta foydalanuvchi turli tokenlar bilan bir vaqtda
 * ishlayverishi mumkin: har bir so'rov FAQAT o'z `uid` i bo'yicha
 * filtrlanadi, shuning uchun ularning yurishlari bir-biriga
 * ko'rinmaydi va xalaqit bermaydi.
 */

// Jonli ro'yxatda nechta oxirgi urinish ko'rsatiladi. Maketda ~14
// qator sig'adi, zaxira bilan olamiz.
const FEED_LIMIT = 40;

const requireUser = (res) => {
  const user = getRequestUser();
  if (!user) {
    res.status(401).json({ message: "Access key noto'g'ri" });
    return null;
  }
  return user;
};

/**
 * Shu token egasining MFY si.
 *
 * Token faqat o'z hududiga kirish beradi, shuning uchun MFY ni
 * foydalanuvchidan so'rashning hojati yo'q: oldin shu token bilan
 * yurish bo'lgan bo'lsa o'shanisi olinadi, bo'lmasa platformadan
 * yuklangan xonadonlar kadastri bo'yicha topiladi.
 */
const resolveMahalla = async (user) => {
  // 1. Oldingi yurish bo'lsa — eng ishonchli manba.
  const previous = await RegistrationRun.findOne({ userUid: user.uid })
    .sort({ createdAt: -1 })
    .select("mahallaKey mahallaName")
    .lean();

  if (previous?.mahallaKey) {
    return { key: previous.mahallaKey, name: previous.mahallaName };
  }

  // 2. Aks holda: platformadagi xonadonlar kadastrlari qaysi
  //    mahallaga tegishli ekanini fuqarolar bazasidan qaraymiz.
  const cadasters = (
    await Home.distinct("cadasterNumber", { userUid: user.uid })
  ).filter(Boolean);

  if (!cadasters.length) return null;

  const rows = await Citizen.aggregate([
    { $match: { cadasterNumber: { $in: cadasters } } },
    { $group: { _id: "$address", count: { $sum: 1 } } },
  ]);

  // Eng ko'p uchragan mahalla nomi olinadi: manzil turlicha
  // yozilgan bo'lishi mumkin.
  const byKey = new Map();

  for (const row of rows) {
    const name = extractMahallaName(row._id);
    if (!name) continue;

    const key = mahallaKey(name);
    if (!key) continue;

    const entry = byKey.get(key) ?? { key, name, count: 0 };
    entry.count += row.count;
    byKey.set(key, entry);
  }

  const best = [...byKey.values()].sort((a, b) => b.count - a.count)[0];
  return best ? { key: best.key, name: best.name } : null;
};

/**
 * Maketdagi 5 ta KPI kartasi uchun ko'rsatkichlar.
 *
 * Diqqat: "jami aholi" butun fuqarolar bazasidan emas, shu
 * YURISHGA tegishli odamlardan hisoblanadi. Aks holda butun
 * tumandagi 150 ming odam ko'rinib, foiz ma'nosiz bo'lib qolardi.
 */
const collectStats = async (run) => {
  const empty = {
    peopleTotal: 0,
    added: 0,
    failed: 0,
    pending: 0,
    homesTotal: 0,
    homesDone: 0,
    percent: 0,
  };

  if (!run) return empty;

  const [byStatus, homesTotal] = await Promise.all([
    RegistrationMember.aggregate([
      { $match: { runId: run._id } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
    RegistrationHome.countDocuments({ runId: run._id }),
  ]);

  const count = (status) =>
    byStatus.find((row) => row._id === status)?.count ?? 0;

  const added = count("added");
  const exists = count("exists");
  const failed = count("failed") + count("skipped");

  // Urinib ko'rilganlar — shular ustida ish tugagan.
  const attempted = added + exists + failed;
  const homesDone = run.homesDone ?? 0;

  // Hali navbatda turganlar: ishlanmagan xonadonlardagi odamlar
  // oldindan noma'lum, shuning uchun o'rtacha bilan baholanadi.
  const homesLeft = Math.max(0, homesTotal - homesDone);
  const perHome = homesDone > 0 ? attempted / homesDone : 0;
  const pending = Math.round(homesLeft * perHome);

  return {
    peopleTotal: attempted + pending,
    // "Ro'yxatga olingan" ichiga allaqachon ro'yxatda turganlar ham
    // kiradi: mahalla xodimi uchun natija bir xil — odam bazada bor.
    added: added + exists,
    failed,
    pending,
    homesTotal,
    homesDone,
    percent: homesTotal > 0 ? Math.round((homesDone / homesTotal) * 100) : 0,
  };
};

/** Jonli ro'yxat uchun bitta qator. */
const describeMember = (member) => ({
  id: String(member._id),
  // Platformaga LOTIN yozuvidagi ism yuboriladi; tasdiqlangani
  // bo'lsa o'shanisi aniqroq.
  fullName: member.verifiedFullName ?? member.fullName ?? "—",
  pinfl: member.verifiedPinfl ?? member.pinfl ?? null,
  status: member.status,
  reason: member.reason ?? null,
  reasonLabel: member.reasonCode
    ? (REASON_LABELS[member.reasonCode] ?? member.reasonCode)
    : null,
  durationMs: member.durationMs ?? null,
  at: member.createdAt,
});

/**
 * GET /api/dashboard
 *
 * Asosiy sahifa butun holatni shu yerdan oladi: MFY, yurish,
 * ko'rsatkichlar va oxirgi urinishlar.
 */
export const getDashboard = async (req, res) => {
  const user = requireUser(res);
  if (!user) return;

  try {
    const mahalla = await resolveMahalla(user);

    // Shu tokenga tegishli eng so'nggi yurish.
    const run = await RegistrationRun.findOne({ userUid: user.uid })
      .sort({ createdAt: -1 })
      .lean();

    const [stats, members, currentHome] = await Promise.all([
      collectStats(run),
      run
        ? RegistrationMember.find({
            runId: run._id,
            // "pending" — hali urinilmagan, natijasi yo'q. Jonli
            // ro'yxat "nima bo'ldi" degan savolga javob beradi,
            // shuning uchun faqat tugagan urinishlar ko'rinadi.
            status: { $ne: "pending" },
          })
            .sort({ createdAt: -1 })
            .limit(FEED_LIMIT)
            .select(
              "fullName verifiedFullName pinfl verifiedPinfl status reason reasonCode durationMs createdAt",
            )
            .lean()
        : [],
      run
        ? RegistrationHome.findOne({ runId: run._id, status: "processing" })
            .sort({ queueIndex: 1 })
            .lean()
        : null,
    ]);

    const isActive = run ? isRunActiveAnywhere(run) : false;

    return res.status(200).json({
      user: { username: user.username ?? null },
      mahalla,
      run: run
        ? {
            id: String(run._id),
            status: run.status,
            stage: run.stage ?? null,
            isActive,
            // "running" deb turgan, lekin ishchisi yo'q — server
            // qayta ishga tushganda qoladigan holat.
            isStale: run.status === "running" && !isActive,
            owner: runOwner(run)?.name ?? null,
            waitingUntil: run.waitingUntil ?? null,
            error: run.error ?? null,
          }
        : null,
      stats,
      currentHome: currentHome
        ? {
            cadasterNumber: currentHome.cadasterNumber,
            streetName: currentHome.streetName,
            homeNum: currentHome.homeNum,
            ownerFullName: currentHome.ownerFullName,
            queueIndex: currentHome.queueIndex,
          }
        : null,
      members: members.map(describeMember),
      rateLimit: getRateLimitState(`registration:${user.uid}`),
    });
  } catch (err) {
    return res.status(500).json({ message: err.message || "Server xatoligi" });
  }
};

/**
 * POST /api/dashboard/control  { action: "start" | "pause" | "stop" }
 *
 * Bitta tugma mantiqi: "start" tugallanmagan yurishni davom
 * ettiradi yoki yangisini boshlaydi — foydalanuvchi uchun farqi
 * yo'q.
 */
export const controlDashboard = async (req, res) => {
  const user = requireUser(res);
  if (!user) return;

  const action = String(req.body?.action ?? "").trim();

  if (!["start", "pause", "stop"].includes(action)) {
    return res.status(400).json({ message: "Amal noto'g'ri" });
  }

  try {
    const token = getRequestToken();

    if (action === "start") {
      const mahalla = await resolveMahalla(user);

      if (!mahalla) {
        return res.status(404).json({
          message:
            "Bu token uchun mahalla aniqlanmadi — avval ma'lumotlar bazasiga Excel yuklang",
        });
      }

      // Tugallanmagan yurish bo'lsa, o'shani davom ettiramiz.
      // Yangisini yaratish bir xonadonni ikki marta ishlashga olib
      // kelardi — platformada dublikat urinish paydo bo'lardi.
      const resumable = await RegistrationRun.findOne({
        userUid: user.uid,
        mahallaKey: mahalla.key,
        status: {
          $in: ["pending", "preparing", "running", "paused", "stopped"],
        },
      })
        .select("+token")
        .sort({ createdAt: -1 });

      if (resumable) {
        if (isRunActiveAnywhere(resumable)) {
          return res
            .status(200)
            .json({ message: "Jarayon allaqachon ketmoqda" });
        }

        resumable.control = "run";
        // Token muddati o'tgan bo'lishi mumkin — har safar
        // joriysini yozamiz.
        resumable.token = token ?? resumable.token;
        resumable.oblId = user.oblId;
        resumable.areaId = user.areaId;
        resumable.districtId = user.districtId;
        await resumable.save();

        runRegistration(user, resumable, resumable.token);

        return res.status(202).json({ message: "Davom ettirildi" });
      }

      const run = await RegistrationRun.create({
        mahallaKey: mahalla.key,
        mahallaName: mahalla.name,
        status: "pending",
        control: "run",
        userUid: user.uid,
        // Ishchi fonda, so'rov tugagach ham ishlaydi — shuning
        // uchun token yurish bilan birga saqlanadi.
        token,
        oblId: user.oblId,
        areaId: user.areaId,
        districtId: user.districtId,
      });

      runRegistration(user, run, token);

      return res.status(202).json({ message: "Jarayon boshlandi" });
    }

    // pause / stop
    const run = await RegistrationRun.findOne({ userUid: user.uid })
      .sort({ createdAt: -1 })
      .select("+token");

    if (!run) return res.status(404).json({ message: "Jarayon topilmadi" });

    run.control = action;
    await run.save();

    // Ishchi ishlamayotgan bo'lsa holatni o'zimiz yopamiz — aks
    // holda "running" deb qotib qolardi.
    if (!isRunActiveAnywhere(run)) {
      run.status = action === "pause" ? "paused" : "stopped";
      run.waitingUntil = null;
      if (action === "stop") run.finishedAt = new Date();
      await run.save();
    }

    return res.status(200).json({
      message: action === "pause" ? "To'xtatib turildi" : "To'xtatildi",
    });
  } catch (err) {
    return res.status(500).json({ message: err.message || "Server xatoligi" });
  }
};

/**
 * GET /api/dashboard/members/:memberId
 * "Ba'tafsil" tugmasi — bitta urinishning to'liq tafsiloti.
 */
export const getDashboardMember = async (req, res) => {
  const user = requireUser(res);
  if (!user) return;

  const { memberId } = req.params;

  if (!mongoose.isValidObjectId(memberId)) {
    return res.status(400).json({ message: "ID noto'g'ri" });
  }

  try {
    const member = await RegistrationMember.findOne({
      _id: memberId,
      userUid: user.uid,
    }).lean();

    if (!member) return res.status(404).json({ message: "Yozuv topilmadi" });

    return res.status(200).json({
      ...member,
      id: String(member._id),
      reasonLabel: member.reasonCode
        ? (REASON_LABELS[member.reasonCode] ?? member.reasonCode)
        : null,
    });
  } catch {
    return res.status(500).json({ message: "Server xatoligi" });
  }
};
