import mongoose from "mongoose";
import XLSX from "xlsx";
import Citizen from "../models/Citizen.js";
import Home from "../models/Home.js";
import RegistrationRun from "../models/RegistrationRun.js";
import MahallaToken from "../models/MahallaToken.js";
import RegistrationHome from "../models/RegistrationHome.js";
import RegistrationMember from "../models/RegistrationMember.js";
import { getRequestUser, getRequestToken } from "../utils/request-context.js";
import { extractMahallaName, mahallaKey } from "../utils/mahalla.js";
import { getRunLogs } from "../utils/registration-log.js";
import { getRateLimitState } from "../utils/rate-limit.js";
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

/**
 * Joriy foydalanuvchi KO'RA OLADIGAN barcha MFY egalari.
 *
 * Boshqa MFY yurishlari o'sha token EGASI nomidan yaratiladi
 * (`userUid` — token egasiniki), shuning uchun faqat `user.uid`
 * bo'yicha filtrlash boshqa mahallalarni butunlay yashirib
 * qo'yardi: ro'yxat bo'sh chiqar, "Boshlash" esa mavjud yurishni
 * topa olmay xato berardi.
 *
 * Qo'shilgan tokenlar umumiy ro'yxat — kim qo'shgan bo'lsa ham
 * hamma ko'radi (bir mahallaga bir nechta xodim mas'ul bo'lishi
 * mumkin).
 */
const visibleUids = async (user) => {
  const tokens = await MahallaToken.find({}, "uid").lean();
  return [...new Set([user.uid, ...tokens.map((t) => t.uid)])];
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

  // Token javobga TUSHMASLIGI kerak. Sxemada `select: false`, lekin
  // davom ettirish uchun ba'zi joylarda `+token` bilan o'qiladi —
  // shuning uchun bu yerda aniq olib tashlanadi, aks holda bitta
  // e'tiborsizlik maxfiy ma'lumotni client'ga chiqarib yuborardi.
  const { token, ...safe } = run;
  void token;

  return {
    ...safe,
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
    // Qaysi kadastr qaysi TOKEN ga tegishli ekanini ham bilamiz:
    // bir nechta MFY tokeni qo'shilgan bo'lsa, har mahalla o'z
    // tokeni bilan boshlanishi kerak.
    const ownerUids = await visibleUids(user);
    const uids = ownerUids;

    const cadasterOwner = new Map();

    for (const uid of new Set(ownerUids)) {
      for (const cadaster of await Home.distinct("cadasterNumber", {
        userUid: uid,
      })) {
        // Birinchi egasi qoladi: bitta kadastr bitta MFY ga tegishli.
        if (cadaster && !cadasterOwner.has(cadaster)) {
          cadasterOwner.set(cadaster, uid);
        }
      }
    }

    const ownCadasters = new Set(cadasterOwner.keys());

    // Har mahalla uchun eng yangi yurish — ro'yxatda holat ko'rinib
    // turishi uchun. Boshqa MFY yurishlari ham ko'rinadi.
    const runs = await RegistrationRun.find({ userUid: { $in: uids } })
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
        // Mahalla kadastrlari qaysi token egasiga tegishli — eng
        // ko'p uchragani mahalla egasi deb olinadi.
        const ownerCounts = new Map();

        for (const cadaster of entry.cadasters) {
          if (!ownCadasters.has(cadaster)) continue;

          available += 1;
          const owner = cadasterOwner.get(cadaster);
          if (owner) ownerCounts.set(owner, (ownerCounts.get(owner) ?? 0) + 1);
        }

        const ownerUid =
          [...ownerCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

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
          // Shu mahalla qaysi token egasiga tegishli — client
          // boshlashda o'sha tokenni uzatadi.
          ownerUid,
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
    // Barcha ko'rinadigan MFY yurishlari — faqat o'zimizniki emas.
    const uids = await visibleUids(user);

    const runs = await RegistrationRun.find({ userUid: { $in: uids } })
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
 * Body: { mahalla: "<key>", tokenId?: "<id>" }
 *
 * `tokenId` berilsa, yurish O'SHA MFY tokeni bilan ketadi — ya'ni
 * foydalanuvchi o'z seansidan turib boshqa mahallani ham boshlay
 * oladi. Berilmasa, joriy so'rov tokeni ishlatiladi.
 *
 * Turli MFY yurishlari PARALLEL ketaveradi: har birining o'z tokeni
 * va o'z rate-limit oqimi bor (`adaptiveKey` foydalanuvchi bo'yicha),
 * shuning uchun bir-biriga xalaqit bermaydi.
 */
export const startRegistration = async (req, res) => {
  const requester = requireUser(res);
  if (!requester) return;

  const key = String(req.body?.mahalla ?? req.query.mahalla ?? "").trim();
  if (!key) {
    return res.status(400).json({ message: "Mahalla tanlanmagan" });
  }

  try {
    // Yurish qaysi MFY nomidan ketadi: boshqa tokenmi yoki o'zimizniki.
    let user = requester;
    let token = getRequestToken();

    const tokenId = String(req.body?.tokenId ?? "").trim();

    if (tokenId) {
      if (!mongoose.isValidObjectId(tokenId)) {
        return res.status(400).json({ message: "Token ID'si noto'g'ri" });
      }

      const entry = await MahallaToken.findById(tokenId).select("+token");
      if (!entry) return res.status(404).json({ message: "Token topilmadi" });

      // Yurish token EGASI nomidan ketadi — hudud, xonadonlar va
      // rate-limit oqimi o'shanikidir.
      user = {
        uid: entry.uid,
        username: entry.username,
        oblId: entry.oblId,
        areaId: entry.areaId,
        districtId: entry.districtId,
      };
      token = entry.token;
    }

    // SHU MAHALLA uchun yurish allaqachon ketyaptimi?
    //
    // Cheklov ataylab mahalla darajasida: har MFY ning o'z tokeni
    // bor, tashqi API limiti ham token bo'yicha hisoblanadi.
    // Shuning uchun turli MFY lar bir-biriga xalaqit bermasdan
    // PARALLEL ishlay oladi. Bitta mahallani esa ikki marta
    // boshlash mumkin emas — bir xonadon ikki marta ishlanib,
    // platformaga dublikat so'rov ketardi.
    // Yurish token EGASI nomidan yaratiladi, shuning uchun qidiruv
    // ham o'sha bo'yicha ketadi (joriy seans emas).
    const running = await RegistrationRun.findOne({
      userUid: user.uid,
      mahallaKey: key,
      status: { $in: ["preparing", "running"] },
    }).lean();

    if (running && isRunActive(running._id)) {
      return res.status(409).json({
        message: "Bu mahalla bo'yicha jarayon allaqachon ketmoqda",
        runId: String(running._id),
      });
    }

    // Shu mahalla uchun tugallanmagan yurish bo'lsa — yangisini
    // yaratmaymiz, o'shani davom ettiramiz. Aks holda bir xonadon
    // ikki marta ishlanib, platformada dublikat urinishlar bo'ladi.
    // "stopped" ham qidiruvga kiradi: foydalanuvchi to'xtatgan
    // yurishda navbat va natijalar saqlanib qoladi. Aks holda
    // "Boshlash" bosilganda yangi bo'sh yurish yaratilib, oldingi
    // ish yo'qolgandek ko'rinardi (va xonadonlar qaytadan
    // ishlanardi).
    //
    // "done" va "error" kirmaydi: birinchisi tugagan, ikkinchisida
    // sabab aniqlanishi kerak.
    const resumable = await RegistrationRun.findOne({
      userUid: user.uid,
      mahallaKey: key,
      status: {
        $in: ["pending", "preparing", "running", "paused", "stopped"],
      },
    })
      .select("+token")
      .sort({ createdAt: -1 });

    if (resumable) {
      resumable.control = "run";
      // Token yangilangan bo'lishi mumkin — har safar joriysini
      // yozamiz, shunda eskirgan token bilan davom etilmaydi.
      resumable.token = token;
      resumable.oblId = user.oblId;
      resumable.areaId = user.areaId;
      resumable.districtId = user.districtId;
      await resumable.save();

      runRegistration(user, resumable, resumable.token);

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
      // Ishchi fonda, so'rov tugagandan keyin ham ishlaydi —
      // shuning uchun token yurish bilan birga saqlanadi.
      token,
      oblId: user.oblId,
      areaId: user.areaId,
      districtId: user.districtId,
    });

    // Fonda ishga tushiramiz — javobni kutmaymiz.
    runRegistration(user, run, token);

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
    // `+token` — sxemada `select: false`, lekin davom ettirishda
    // eski token zaxira sifatida kerak bo'ladi.
    const run = await RegistrationRun.findOne({
      _id: runId,
      userUid: { $in: await visibleUids(user) },
    }).select("+token");
    if (!run) return res.status(404).json({ message: "Yurish topilmadi" });

    if (action === "resume") {
      if (isRunActive(run._id)) {
        return res.status(200).json({ message: "Jarayon allaqachon ketmoqda" });
      }

      // Boshqa MFY yurishlari parallel ketaverishi mumkin: har
      // birining o'z tokeni va o'z rate-limit oqimi bor, shuning
      // uchun bir-biriga xalaqit bermaydi.

      run.control = "run";
      // Davom ettirishda tokenni yangilaymiz: eskisining muddati
      // o'tgan bo'lishi mumkin.
      run.token = getRequestToken() ?? run.token;
      run.oblId = user.oblId;
      run.areaId = user.areaId;
      run.districtId = user.districtId;
      await run.save();

      runRegistration(user, run, run.token);

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
      userUid: { $in: await visibleUids(user) },
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
      run: {
        ...describeRun(run),
        // Tashqi API limiti holati — jarayon kutayotganini
        // ko'rsatish uchun. Kalit ishchidagi bilan bir xil.
        rateLimit: getRateLimitState(`registration:${run.userUid}`),
      },
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
    // Yurish boshqa MFY tokeni nomidan ketgan bo'lishi mumkin.
    const filter = { runId, userUid: { $in: await visibleUids(user) } };

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
      userUid: { $in: await visibleUids(user) },
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
    // Yurish boshqa MFY tokeni nomidan ketgan bo'lishi mumkin.
    const filter = { runId, userUid: { $in: await visibleUids(user) } };

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
      userUid: { $in: await visibleUids(user) },
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
    // Hisobot barcha ko'rinadigan MFY lar bo'yicha — "Umumiy"
    // tanlanganda hammasi qo'shilib hisoblanadi.
    const uids = await visibleUids(user);
    const memberFilter = { userUid: { $in: uids } };
    const homeFilter = { userUid: { $in: uids } };

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
      needDocument,
      elsewhere,
    ] = await Promise.all([
      runId
        ? RegistrationRun.findOne({ _id: runId, userUid: { $in: uids } }).lean()
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

      // Hujjati yaroqsizlar — mahalla uchun AMALIY ro'yxat: bu
      // odamlar aktiv, faqat bazadagi hujjati eskirgan. Yangi
      // hujjat ma'lumotini olib, ro'yxatni yangilash kerak.
      // Bitta odam bir necha marta urinilgan bo'lishi mumkin
      // (xonadon qayta ishlansa), ro'yxatda esa bir marta
      // ko'rinishi kerak — JSHSHIR bo'yicha guruhlaymiz.
      RegistrationMember.aggregate([
        { $match: { ...memberFilter, reasonCode: "hujjat_yaroqsiz" } },
        { $sort: { createdAt: -1 } },
        {
          $group: {
            _id: { $ifNull: ["$pinfl", "$fullName"] },
            fullName: { $first: "$fullName" },
            birthDate: { $first: "$birthDate" },
            document: { $first: "$document" },
            pinfl: { $first: "$pinfl" },
            cadasterNumber: { $first: "$cadasterNumber" },
          },
        },
        { $sort: { fullName: 1 } },
        { $limit: 200 },
      ]),

      // Boshqa joyda ro'yxatda turganlar — ya'ni ko'chib ketganlar.
      // Mahalla uchun bu shunchaki "xato" emas, amaliy ma'lumot:
      // ro'yxatni yangilash kerakligini bildiradi.
      RegistrationMember.aggregate([
        { $match: { ...memberFilter, registeredMahalla: { $ne: null } } },
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

      // Hujjati yangilanishi kerak bo'lganlar (amaliy ro'yxat).
      needDocument: needDocument.map((row) => ({
        id: String(row._id),
        fullName: row.fullName,
        birthDate: row.birthDate,
        document: row.document,
        pinfl: row.pinfl,
        cadasterNumber: row.cadasterNumber,
      })),

      // Boshqa joyda ro'yxatda turganlar: qayerda va nechtasi.
      elsewhere: elsewhere.map((row) => ({
        region: row._id.region ?? "—",
        mahalla: row._id.mahalla ?? "—",
        // true — butunlay boshqa mahallada (ko'chib ketgan),
        // false — shu mahallaning boshqa xonadonida.
        movedAway: Boolean(row._id.movedAway),
        count: row.count,
      })),
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
    const run = await RegistrationRun.findOne({
      _id: runId,
      userUid: { $in: await visibleUids(user) },
    });
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
    const run = await RegistrationRun.findOne({
      _id: runId,
      userUid: { $in: await visibleUids(user) },
    });
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

/**
 * Hisobotni Excel faylga chiqaradi.
 *
 * Nega kerak: mahalla xodimi "hujjati yangilanishi kerak" va
 * "ko'chib ketganlar" ro'yxatlari bilan AMALDA ishlaydi — odamlarga
 * qo'ng'iroq qiladi, hujjat so'raydi. Ekrandagi ro'yxat buning
 * uchun qulay emas.
 *
 * Har bo'lim alohida varaqda chiqadi.
 */
export const exportRegistrationReport = async (req, res) => {
  const user = requireUser(res);
  if (!user) return;

  const { runId } = req.params;
  if (!mongoose.isValidObjectId(runId)) {
    return res.status(400).json({ message: "Yurish ID'si noto'g'ri" });
  }

  try {
    const run = await RegistrationRun.findOne({
      _id: runId,
      userUid: { $in: await visibleUids(user) },
    }).lean();

    if (!run) return res.status(404).json({ message: "Yurish topilmadi" });

    const [added, needDocument, elsewhere, failed] = await Promise.all([
      RegistrationMember.find({ runId, status: "added" })
        .sort({ createdAt: 1 })
        .lean(),
      RegistrationMember.aggregate([
        { $match: { runId: new mongoose.Types.ObjectId(String(runId)), reasonCode: "hujjat_yaroqsiz" } },
        { $sort: { createdAt: -1 } },
        {
          $group: {
            _id: { $ifNull: ["$pinfl", "$fullName"] },
            fullName: { $first: "$fullName" },
            birthDate: { $first: "$birthDate" },
            document: { $first: "$document" },
            cadasterNumber: { $first: "$cadasterNumber" },
          },
        },
        { $sort: { fullName: 1 } },
      ]),
      RegistrationMember.find({
        runId,
        registeredMahalla: { $ne: null },
      })
        .sort({ registeredMahalla: 1 })
        .lean(),
      RegistrationMember.find({ runId, status: "failed" })
        .sort({ createdAt: -1 })
        .lean(),
    ]);

    const workbook = XLSX.utils.book_new();

    const sheet = (name, rows) => {
      if (!rows.length) return;
      XLSX.utils.book_append_sheet(
        workbook,
        XLSX.utils.json_to_sheet(rows),
        name,
      );
    };

    sheet(
      "Kiritilganlar",
      added.map((row, index) => ({
        "№": index + 1,
        "F.I.Sh.": row.verifiedFullName ?? row.fullName,
        "Tug'ilgan sana": row.verifiedBirthDate ?? row.birthDate,
        JSHSHIR: row.verifiedPinfl ?? row.pinfl,
        Hujjat: `${row.verifiedDocSeries ?? ""}${row.verifiedDocNumber ?? ""}`,
        Kadastr: row.cadasterNumber,
        "Platforma ID": row.memberId,
      })),
    );

    sheet(
      "Hujjati yangilanishi kerak",
      needDocument.map((row, index) => ({
        "№": index + 1,
        "F.I.Sh.": row.fullName,
        "Tug'ilgan sana": row.birthDate,
        "Eski hujjat": row.document,
        Kadastr: row.cadasterNumber,
        Izoh: "Davlat bazasida aktiv, hujjati yaroqsiz — yangisini so'rash kerak",
      })),
    );

    sheet(
      "Boshqa joyda ro'yxatda",
      elsewhere.map((row, index) => ({
        "№": index + 1,
        "F.I.Sh.": row.verifiedFullName ?? row.fullName,
        JSHSHIR: row.verifiedPinfl ?? row.pinfl,
        Kadastr: row.cadasterNumber,
        Viloyat: row.registeredRegion,
        Mahalla: row.registeredMahalla,
        Holati: row.movedAway ? "Ko'chib ketgan" : "Shu mahallada (boshqa xonadon)",
      })),
    );

    sheet(
      "Xatoliklar",
      failed.map((row, index) => ({
        "№": index + 1,
        "F.I.Sh.": row.verifiedFullName ?? row.fullName,
        JSHSHIR: row.verifiedPinfl ?? row.pinfl,
        Kadastr: row.cadasterNumber,
        Sabab: REASON_LABELS[row.reasonCode] ?? row.reasonCode,
        "To'liq xabar": row.reason,
      })),
    );

    // Bironta varaq ham bo'lmasa, bo'sh fayl o'rniga tushunarli
    // xabar qaytaramiz.
    if (!workbook.SheetNames.length) {
      return res
        .status(200)
        .json({ message: "Hisobotda hali ma'lumot yo'q" });
    }

    const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
    const fileName = `royxat-${run.mahallaName ?? run.mahallaKey}.xlsx`;

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${encodeURIComponent(fileName)}"`,
    );

    return res.send(buffer);
  } catch (err) {
    return res.status(500).json({ message: err.message || "Server xatoligi" });
  }
};
