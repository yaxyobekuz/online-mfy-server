import mongoose from "mongoose";
import Citizen from "../models/Citizen.js";
import Home from "../models/Home.js";
import RegistrationRun from "../models/RegistrationRun.js";
import RegistrationHome from "../models/RegistrationHome.js";
import RegistrationMember from "../models/RegistrationMember.js";
import { getRequestUser } from "../utils/request-context.js";
import { extractMahallaName, mahallaKey } from "../utils/mahalla.js";
import { getRunLogs } from "../utils/registration-log.js";
import { REASON_LABELS } from "../utils/registration-codes.js";
import {
  runRegistration,
  isRunActive,
} from "../services/registration-worker.js";

const PAGE_SIZE = 50;

const parsePage = (value) => {
  const page = Number.parseInt(value, 10);
  return Number.isFinite(page) && page > 0 ? page : 1;
};

const requireUser = (res) => {
  const user = getRequestUser();
  if (!user) {
    res.status(401).json({ message: "Access key noto'g'ri" });
    return null;
  }
  return user;
};

// Yurish holati jonli ko'rsatiladi, shuning uchun hisoblangan
// maydonlar (foiz, ishchi haqiqatan ishlab turganmi) bir joyda
// tayyorlanadi — client ikkinchi marta hisoblamasin.
const describeRun = (run) => {
  if (!run) return null;

  const homesPercent =
    run.homesTotal > 0
      ? Math.round((run.homesDone / run.homesTotal) * 100)
      : 0;

  // "running" deb turgan, lekin ishchisi yo'q yurish — server qayta
  // ishga tushganda qoladigan holat. Client "davom ettirish" ni
  // taklif qilishi uchun ajratib ko'rsatamiz.
  const isActive = isRunActive(run._id);
  const isStale = run.status === "running" && !isActive;

  return {
    ...run,
    id: String(run._id),
    homesPercent,
    isActive,
    isStale,
  };
};

/**
 * Ro'yxatga olish uchun tanlanishi mumkin bo'lgan mahallalar.
 *
 * Umumiy fuqarolar bazasidagi manzillardan hisoblanadi (alohida
 * jadval yo'q). Har mahalla uchun: nechta fuqaro, nechta kadastr va
 * oxirgi yurish holati.
 */
export const getRegistrationMahallas = async (req, res) => {
  const user = requireUser(res);
  if (!user) return;

  try {
    const rows = await Citizen.aggregate([
      {
        $group: {
          _id: "$address",
          count: { $sum: 1 },
          cadasters: { $addToSet: "$cadasterNumber" },
          withPinfl: {
            $sum: { $cond: [{ $in: ["$pinfl", [null, ""]] }, 0, 1] },
          },
        },
      },
    ]);

    const byKey = new Map();

    for (const row of rows) {
      const name = extractMahallaName(row._id);
      if (!name) continue;

      const key = mahallaKey(name);
      if (!key) continue;

      if (!byKey.has(key)) {
        byKey.set(key, {
          key,
          nameCounts: new Map(),
          citizens: 0,
          withPinfl: 0,
          cadasters: new Set(),
        });
      }

      const entry = byKey.get(key);
      entry.citizens += row.count;
      entry.withPinfl += row.withPinfl;
      entry.nameCounts.set(name, (entry.nameCounts.get(name) ?? 0) + row.count);

      for (const cadaster of row.cadasters) {
        if (cadaster) entry.cadasters.add(cadaster);
      }
    }

    // Foydalanuvchining tokeni faqat O'Z MFY siga kirish beradi:
    // tashqi API boshqa mahalla xonadonlarini umuman qaytarmaydi.
    // Shuning uchun qaysi mahalla haqiqatan ishlashga tayyor ekanini
    // belgilab qo'yamiz — aks holda foydalanuvchi 85 mahalladan
    // birini tanlab, "xonadon topilmadi" degan xatoga uchraydi.
    //
    // Tekshirish platformadagi mavjud xonadonlar (Home) kadastrlari
    // bo'yicha ketadi: ular allaqachon yuklangan va tashqi API'ga
    // qayta so'rov yubormaydi.
    const ownCadasters = new Set(
      (await Home.distinct("cadasterNumber", { userUid: user.uid })).filter(
        Boolean,
      ),
    );

    // Har mahalla uchun eng yangi yurish — ro'yxatda holat ko'rinib
    // turishi uchun.
    const runs = await RegistrationRun.find({ userUid: user.uid })
      .sort({ createdAt: -1 })
      .lean();

    const latestRunByKey = new Map();
    for (const run of runs) {
      if (!latestRunByKey.has(run.mahallaKey)) {
        latestRunByKey.set(run.mahallaKey, run);
      }
    }

    const items = [...byKey.values()]
      .map((entry) => {
        // Nom turlicha yoziladi; eng ko'p uchragani asosiy deb olinadi.
        const names = [...entry.nameCounts.entries()].sort(
          (a, b) => b[1] - a[1],
        );
        const run = latestRunByKey.get(entry.key) ?? null;

        // Shu mahallaning nechta kadastri platformada bor — ya'ni
        // amalda nechtasini ishlash mumkin.
        let available = 0;
        for (const cadaster of entry.cadasters) {
          if (ownCadasters.has(cadaster)) available += 1;
        }

        return {
          key: entry.key,
          name: names[0]?.[0] ?? entry.key,
          citizens: entry.citizens,
          withPinfl: entry.withPinfl,
          withoutPinfl: entry.citizens - entry.withPinfl,
          cadasters: entry.cadasters.size,
          // Platformada mavjud (tokenga ko'rinadigan) kadastrlar.
          availableCadasters: available,
          isAvailable: available > 0,
          run: run
            ? {
                id: String(run._id),
                status: run.status,
                homesDone: run.homesDone,
                homesTotal: run.homesTotal,
                membersAdded: run.membersAdded,
                membersFailed: run.membersFailed,
                isActive: isRunActive(run._id),
                finishedAt: run.finishedAt,
              }
            : null,
        };
      })
      // Ishlashga tayyor mahallalar yuqorida turadi — foydalanuvchi
      // birinchi navbatda o'z MFY sini ko'rsin.
      .sort((a, b) => {
        if (a.isAvailable !== b.isAvailable) return a.isAvailable ? -1 : 1;
        return b.citizens - a.citizens;
      });

    return res.status(200).json({
      items,
      total: items.length,
      available: items.filter((item) => item.isAvailable).length,
    });
  } catch {
    return res.status(500).json({ message: "Server xatoligi" });
  }
};

/**
 * Yurishlar ro'yxati (eng yangisi birinchi).
 */
export const getRegistrationRuns = async (req, res) => {
  const user = requireUser(res);
  if (!user) return;

  try {
    const runs = await RegistrationRun.find({ userUid: user.uid })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    return res.status(200).json({ items: runs.map(describeRun) });
  } catch {
    return res.status(500).json({ message: "Server xatoligi" });
  }
};

/**
 * Yangi yurishni boshlaydi.
 *
 * Body: { mahalla: "<key>" }
 *
 * Bir vaqtda bitta yurish ishlaydi: tashqi API limiti umumiy,
 * ikki yurish parallel ketsa ikkalasi ham sekinlashadi va 429
 * xatolari ko'payadi.
 */
export const startRegistration = async (req, res) => {
  const user = requireUser(res);
  if (!user) return;

  const key = String(req.body?.mahalla ?? req.query.mahalla ?? "").trim();
  if (!key) {
    return res.status(400).json({ message: "Mahalla tanlanmagan" });
  }

  try {
    // Allaqachon ishlab turgan yurish bormi?
    const running = await RegistrationRun.findOne({
      userUid: user.uid,
      status: { $in: ["preparing", "running"] },
    }).lean();

    if (running && isRunActive(running._id)) {
      return res.status(409).json({
        message: "Jarayon allaqachon ketmoqda",
        runId: String(running._id),
      });
    }

    // Shu mahalla uchun tugallanmagan yurish bo'lsa — yangisini
    // yaratmaymiz, o'shani davom ettiramiz. Aks holda bir xonadon
    // ikki marta ishlanib, platformada dublikat urinishlar bo'ladi.
    const resumable = await RegistrationRun.findOne({
      userUid: user.uid,
      mahallaKey: key,
      status: { $in: ["pending", "preparing", "running", "paused"] },
    }).sort({ createdAt: -1 });

    if (resumable) {
      resumable.control = "run";
      await resumable.save();

      runRegistration(user, resumable);

      return res.status(202).json({
        runId: String(resumable._id),
        resumed: true,
        message: "Tugallanmagan yurish davom ettirildi",
      });
    }

    // Mahalla nomini aniqlaymiz (ro'yxatda ko'rsatish uchun).
    const addresses = await Citizen.distinct("address");
    let mahallaName = null;

    for (const address of addresses) {
      const name = extractMahallaName(address);
      if (name && mahallaKey(name) === key) {
        mahallaName = name;
        break;
      }
    }

    if (!mahallaName) {
      return res.status(404).json({ message: "Mahalla topilmadi" });
    }

    const run = await RegistrationRun.create({
      mahallaKey: key,
      mahallaName,
      status: "pending",
      control: "run",
      userUid: user.uid,
    });

    // Fonda ishga tushiramiz — javobni kutmaymiz.
    runRegistration(user, run);

    return res.status(202).json({ runId: String(run._id), resumed: false });
  } catch (err) {
    return res
      .status(500)
      .json({ message: err.message || "Server xatoligi" });
  }
};

/**
 * Yurishni to'xtatib turish / davom ettirish / butunlay to'xtatish.
 *
 * Body: { action: "pause" | "resume" | "stop" }
 *
 * Ishchi ko'rsatmani har qadamda o'qiydi, shuning uchun joriy
 * so'rov tugagach darhol bo'ysunadi — yarim yozilgan ma'lumot
 * qolmaydi.
 */
export const controlRegistration = async (req, res) => {
  const user = requireUser(res);
  if (!user) return;

  const { runId } = req.params;
  const action = String(req.body?.action ?? "").trim();

  if (!mongoose.isValidObjectId(runId)) {
    return res.status(400).json({ message: "Yurish ID'si noto'g'ri" });
  }

  if (!["pause", "resume", "stop"].includes(action)) {
    return res.status(400).json({ message: "Amal noto'g'ri" });
  }

  try {
    const run = await RegistrationRun.findOne({ _id: runId, userUid: user.uid });
    if (!run) return res.status(404).json({ message: "Yurish topilmadi" });

    if (action === "resume") {
      if (isRunActive(run._id)) {
        return res.status(200).json({ message: "Jarayon allaqachon ketmoqda" });
      }

      // Boshqa yurish ishlab turgan bo'lsa, ikkinchisini qo'shmaymiz.
      const other = await RegistrationRun.findOne({
        userUid: user.uid,
        _id: { $ne: run._id },
        status: { $in: ["preparing", "running"] },
      }).lean();

      if (other && isRunActive(other._id)) {
        return res
          .status(409)
          .json({ message: "Boshqa mahalla jarayoni ketmoqda" });
      }

      run.control = "run";
      await run.save();

      runRegistration(user, run);

      return res.status(200).json({ message: "Davom ettirildi" });
    }

    run.control = action;
    await run.save();

    // Ishchi ishlamayotgan bo'lsa (masalan server qayta ishga
    // tushgan), holatni o'zimiz yopamiz — aks holda "running" deb
    // qotib qolardi.
    if (!isRunActive(run._id)) {
      run.status = action === "pause" ? "paused" : "stopped";
      run.waitingUntil = null;
      if (action === "stop") run.finishedAt = new Date();
      await run.save();
    }

    return res.status(200).json({
      message: action === "pause" ? "To'xtatib turildi" : "To'xtatildi",
    });
  } catch {
    return res.status(500).json({ message: "Server xatoligi" });
  }
};

/**
 * Jonli holat: yurish, joriy xonadon, oxirgi odamlar va jurnal.
 * Client shu bitta endpointni polling qiladi.
 */
export const getRegistrationStatus = async (req, res) => {
  const user = requireUser(res);
  if (!user) return;

  const { runId } = req.params;
  if (!mongoose.isValidObjectId(runId)) {
    return res.status(400).json({ message: "Yurish ID'si noto'g'ri" });
  }

  try {
    const run = await RegistrationRun.findOne({
      _id: runId,
      userUid: user.uid,
    }).lean();

    if (!run) return res.status(404).json({ message: "Yurish topilmadi" });

    const since = Number(req.query.since) || 0;

    const [currentHome, recentMembers] = await Promise.all([
      // Hozir ishlanayotgan xonadon.
      RegistrationHome.findOne({ runId: run._id, status: "processing" })
        .sort({ queueIndex: 1 })
        .lean(),
      // Oxirgi urinishlar — "hozir kim kiritilyapti" ko'rinishi uchun.
      RegistrationMember.find({ runId: run._id })
        .sort({ createdAt: -1 })
        .limit(12)
        .select(
          "fullName verifiedFullName pinfl verifiedPinfl status reason reasonCode cadasterNumber durationMs createdAt studyLevelCode verifiedVia",
        )
        .lean(),
    ]);

    return res.status(200).json({
      run: describeRun(run),
      currentHome: currentHome ?? null,
      recentMembers,
      logs: getRunLogs(run._id, since),
    });
  } catch {
    return res.status(500).json({ message: "Server xatoligi" });
  }
};

/**
 * Yurishdagi xonadonlar (sahifalangan). Status bo'yicha filtr bor —
 * "qaysilarida xatolik bo'ldi" degan savol shu orqali ko'riladi.
 */
export const getRegistrationHomes = async (req, res) => {
  const user = requireUser(res);
  if (!user) return;

  const { runId } = req.params;
  if (!mongoose.isValidObjectId(runId)) {
    return res.status(400).json({ message: "Yurish ID'si noto'g'ri" });
  }

  try {
    const page = parsePage(req.query.page);
    const filter = { runId, userUid: user.uid };

    if (req.query.status) filter.status = String(req.query.status);

    if (req.query.search) {
      const search = String(req.query.search).trim();
      if (search) {
        const safe = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        filter.$or = [
          { cadasterNumber: { $regex: safe, $options: "i" } },
          { ownerFullName: { $regex: safe, $options: "i" } },
          { homeNum: { $regex: safe, $options: "i" } },
        ];
      }
    }

    const [items, total] = await Promise.all([
      RegistrationHome.find(filter)
        .sort({ queueIndex: 1 })
        .skip((page - 1) * PAGE_SIZE)
        .limit(PAGE_SIZE)
        .lean(),
      RegistrationHome.countDocuments(filter),
    ]);

    return res.status(200).json({
      items,
      page,
      pageSize: PAGE_SIZE,
      total,
      totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    });
  } catch {
    return res.status(500).json({ message: "Server xatoligi" });
  }
};

/**
 * Bitta xonadonning oila kesimi: xonadon ma'lumoti + shu xonadonda
 * urinilgan barcha odamlar (har biri uchun sabab bilan).
 */
export const getRegistrationHomeDetails = async (req, res) => {
  const user = requireUser(res);
  if (!user) return;

  const { homeRowId } = req.params;
  if (!mongoose.isValidObjectId(homeRowId)) {
    return res.status(400).json({ message: "Xonadon ID'si noto'g'ri" });
  }

  try {
    const home = await RegistrationHome.findOne({
      _id: homeRowId,
      userUid: user.uid,
    }).lean();

    if (!home) return res.status(404).json({ message: "Xonadon topilmadi" });

    const members = await RegistrationMember.find({ homeRowId: home._id })
      .sort({ createdAt: 1 })
      .lean();

    return res.status(200).json({ home, members });
  } catch {
    return res.status(500).json({ message: "Server xatoligi" });
  }
};

/**
 * Yurishdagi odamlar (sahifalangan), status va sabab bo'yicha filtr
 * bilan. Hisobotdan "nega kirmadi" degan savolga shu orqali
 * qaraladi.
 */
export const getRegistrationMembers = async (req, res) => {
  const user = requireUser(res);
  if (!user) return;

  const { runId } = req.params;
  if (!mongoose.isValidObjectId(runId)) {
    return res.status(400).json({ message: "Yurish ID'si noto'g'ri" });
  }

  try {
    const page = parsePage(req.query.page);
    const filter = { runId, userUid: user.uid };

    if (req.query.status) filter.status = String(req.query.status);
    if (req.query.reasonCode) filter.reasonCode = String(req.query.reasonCode);

    if (req.query.search) {
      const search = String(req.query.search).trim();
      if (search) {
        const safe = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        filter.$or = [
          { fullName: { $regex: safe, $options: "i" } },
          { verifiedFullName: { $regex: safe, $options: "i" } },
          { pinfl: { $regex: safe, $options: "i" } },
          { cadasterNumber: { $regex: safe, $options: "i" } },
        ];
      }
    }

    const [items, total] = await Promise.all([
      RegistrationMember.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * PAGE_SIZE)
        .limit(PAGE_SIZE)
        .lean(),
      RegistrationMember.countDocuments(filter),
    ]);

    return res.status(200).json({
      items,
      page,
      pageSize: PAGE_SIZE,
      total,
      totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    });
  } catch {
    return res.status(500).json({ message: "Server xatoligi" });
  }
};

/**
 * Bitta odamning to'liq yo'li: bazadan nima kelgani, platformaga
 * nima yuborilgani, platforma nima javob bergani. Xatolikni
 * taxmin bilan emas, aniq ma'lumot bilan tekshirish uchun.
 */
export const getRegistrationMemberDetails = async (req, res) => {
  const user = requireUser(res);
  if (!user) return;

  const { memberId } = req.params;
  if (!mongoose.isValidObjectId(memberId)) {
    return res.status(400).json({ message: "Yozuv ID'si noto'g'ri" });
  }

  try {
    const member = await RegistrationMember.findOne({
      _id: memberId,
      userUid: user.uid,
    }).lean();

    if (!member) return res.status(404).json({ message: "Yozuv topilmadi" });

    return res.status(200).json(member);
  } catch {
    return res.status(500).json({ message: "Server xatoligi" });
  }
};

/**
 * Hisobot: yurish bo'yicha statistika — qancha kiritildi, qancha
 * kirmadi, sabablar kesimida va ko'cha kesimida.
 *
 * `runId` berilmasa, barcha yurishlar bo'yicha umumiy hisobot.
 */
export const getRegistrationReport = async (req, res) => {
  const user = requireUser(res);
  if (!user) return;

  try {
    const runId = req.query.runId;
    const memberFilter = { userUid: user.uid };
    const homeFilter = { userUid: user.uid };

    if (runId) {
      if (!mongoose.isValidObjectId(runId)) {
        return res.status(400).json({ message: "Yurish ID'si noto'g'ri" });
      }

      const objectId = new mongoose.Types.ObjectId(String(runId));
      memberFilter.runId = objectId;
      homeFilter.runId = objectId;
    }

    const [
      run,
      membersByStatus,
      reasons,
      homesByStatus,
      byStreet,
      byStudyLevel,
      timing,
    ] = await Promise.all([
      runId
        ? RegistrationRun.findOne({ _id: runId, userUid: user.uid }).lean()
        : null,

      // Odamlar holati bo'yicha.
      RegistrationMember.aggregate([
        { $match: memberFilter },
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),

      // Sabablar — nega kirmadi. Guruhlash `reasonCode` bo'yicha
      // ketadi: erkin matnni guruhlab bo'lmaydi, platforma bir xil
      // sababni turli so'z bilan qaytaradi.
      RegistrationMember.aggregate([
        { $match: { ...memberFilter, status: { $in: ["failed", "skipped"] } } },
        {
          $group: {
            _id: "$reasonCode",
            count: { $sum: 1 },
            // Namuna sabab matni — kodning ortida nima turganini
            // ko'rsatish uchun.
            sample: { $first: "$reason" },
          },
        },
        { $sort: { count: -1 } },
      ]),

      // Xonadonlar holati bo'yicha.
      RegistrationHome.aggregate([
        { $match: homeFilter },
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),

      // Ko'cha kesimida — qaysi ko'chada ish qanday ketgani.
      RegistrationHome.aggregate([
        { $match: homeFilter },
        {
          $group: {
            _id: "$streetName",
            homes: { $sum: 1 },
            added: { $sum: "$addedCount" },
            failed: { $sum: "$failedCount" },
            skipped: { $sum: "$skippedCount" },
          },
        },
        { $sort: { added: -1 } },
        { $limit: 50 },
      ]),

      // Ta'lim darajasi taqsimoti — statistik baholash qanday
      // taqsimlanganini ko'rish uchun.
      RegistrationMember.aggregate([
        { $match: { ...memberFilter, status: "added" } },
        { $group: { _id: "$studyLevelCode", count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]),

      // O'rtacha tezlik — qolgan vaqtni taxmin qilish uchun.
      RegistrationMember.aggregate([
        { $match: { ...memberFilter, durationMs: { $gt: 0 } } },
        {
          $group: {
            _id: null,
            avgMs: { $avg: "$durationMs" },
            count: { $sum: 1 },
          },
        },
      ]),
    ]);

    const toMap = (rows) =>
      rows.reduce((acc, row) => {
        acc[row._id ?? "nomalum"] = row.count;
        return acc;
      }, {});

    const members = toMap(membersByStatus);
    const homes = toMap(homesByStatus);

    const STUDY_LABELS = {
      1: "Oliy",
      2: "Tugallanmagan oliy",
      3: "O'rta maxsus",
      4: "O'rta",
      5: "Ma'lumoti yo'q",
    };

    return res.status(200).json({
      run: describeRun(run),

      members: {
        total: Object.values(members).reduce((sum, n) => sum + n, 0),
        added: members.added ?? 0,
        failed: members.failed ?? 0,
        skipped: members.skipped ?? 0,
        exists: members.exists ?? 0,
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

      byStreet: byStreet.map((row) => ({
        street: row._id ?? "—",
        homes: row.homes,
        added: row.added,
        failed: row.failed,
        skipped: row.skipped,
      })),

      byStudyLevel: byStudyLevel.map((row) => ({
        code: row._id,
        label: STUDY_LABELS[row._id] ?? row._id ?? "—",
        count: row.count,
      })),

      avgMs: timing[0]?.avgMs ? Math.round(timing[0].avgMs) : null,
    });
  } catch {
    return res.status(500).json({ message: "Server xatoligi" });
  }
};

// Vaqtinchalik sabablar: tashqi server nosozligi yoki tarmoq
// uzilishi. Bunday yozuvni qayta urinib ko'rish mantiqiy —
// ma'lumotning o'zida nuqson yo'q. Qolgan sabablar (vafot etgan,
// boshqa xonadon egasi, hujjat nuqsoni) qayta urinishdan
// o'zgarmaydi.
const RETRYABLE_REASONS = ["server_xatosi", "tarmoq"];

/**
 * Vaqtinchalik xatolik bergan xonadonlarni navbatga qaytaradi.
 *
 * Faqat shu sababli xato bo'lgan yozuvlar tozalanadi va xonadon
 * "pending" ga qaytariladi — keyingi yurishda qaytadan urinib
 * ko'riladi. Muvaffaqiyatli qo'shilganlarga tegilmaydi: platformada
 * dublikat paydo bo'lmasligi kerak.
 */
export const retryRegistrationFailures = async (req, res) => {
  const user = requireUser(res);
  if (!user) return;

  const { runId } = req.params;
  if (!mongoose.isValidObjectId(runId)) {
    return res.status(400).json({ message: "Yurish ID'si noto'g'ri" });
  }

  try {
    const run = await RegistrationRun.findOne({ _id: runId, userUid: user.uid });
    if (!run) return res.status(404).json({ message: "Yurish topilmadi" });

    if (isRunActive(run._id)) {
      return res
        .status(409)
        .json({ message: "Jarayon ketmoqda — avval to'xtatish kerak" });
    }

    // Qayta urinishga arziydigan yozuvlar.
    const retryable = await RegistrationMember.find(
      {
        runId: run._id,
        status: "failed",
        reasonCode: { $in: RETRYABLE_REASONS },
      },
      "homeRowId",
    ).lean();

    if (!retryable.length) {
      return res
        .status(200)
        .json({ message: "Qayta urinishga arziydigan yozuv yo'q", reset: 0 });
    }

    const homeRowIds = [...new Set(retryable.map((row) => String(row.homeRowId)))];

    // Yozuvlarni o'chiramiz — xonadon qayta ishlanganda yangisi
    // yoziladi (processHome "pending" larni o'zi tozalaydi, bular
    // esa "failed" holatda).
    await RegistrationMember.deleteMany({
      _id: { $in: retryable.map((row) => row._id) },
    });

    // Xonadonlarni navbatga qaytaramiz.
    await RegistrationHome.updateMany(
      { _id: { $in: homeRowIds } },
      {
        $set: { status: "pending" },
        $unset: { reason: 1, finishedAt: 1, durationMs: 1 },
      },
    );

    return res.status(200).json({
      message: `${retryable.length} yozuv va ${homeRowIds.length} xonadon navbatga qaytarildi`,
      reset: retryable.length,
      homes: homeRowIds.length,
    });
  } catch {
    return res.status(500).json({ message: "Server xatoligi" });
  }
};

/**
 * Yurishni o'chirish (kuzatuv yozuvlari bilan birga).
 *
 * Diqqat: bu faqat BIZNING kuzatuv ma'lumotimizni o'chiradi.
 * Platformaga qo'shilgan odamlar joyida qoladi — platforma a'zoni
 * o'chirishga ruxsat bermaydi (canDelete: false).
 */
export const deleteRegistrationRun = async (req, res) => {
  const user = requireUser(res);
  if (!user) return;

  const { runId } = req.params;
  if (!mongoose.isValidObjectId(runId)) {
    return res.status(400).json({ message: "Yurish ID'si noto'g'ri" });
  }

  try {
    const run = await RegistrationRun.findOne({ _id: runId, userUid: user.uid });
    if (!run) return res.status(404).json({ message: "Yurish topilmadi" });

    if (isRunActive(run._id)) {
      return res.status(409).json({
        message: "Jarayon ketmoqda — avval to'xtatish kerak",
      });
    }

    await Promise.all([
      RegistrationHome.deleteMany({ runId: run._id }),
      RegistrationMember.deleteMany({ runId: run._id }),
    ]);
    await RegistrationRun.deleteOne({ _id: run._id });

    return res.status(200).json({ message: "O'chirildi" });
  } catch {
    return res.status(500).json({ message: "Server xatoligi" });
  }
};
