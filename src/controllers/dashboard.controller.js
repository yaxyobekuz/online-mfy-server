import mongoose from "mongoose";
import api from "../config/api.js";
import Citizen from "../models/Citizen.js";
import Home from "../models/Home.js";
import RegistrationRun from "../models/RegistrationRun.js";
import FamilyMember from "../models/FamilyMember.js";
import RegistrationHome from "../models/RegistrationHome.js";
import RegistrationMember from "../models/RegistrationMember.js";
import { getRequestUser, getRequestToken } from "../utils/request-context.js";
import { extractMahallaName, mahallaKey } from "../utils/mahalla.js";
import { cadasterKey } from "../utils/cadaster.js";
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

// Xonadon shu holatlarda ishlab bo'lingan hisoblanadi: undagi hamma
// odam ko'rib chiqilgan.
export const FINISHED_HOME_STATUSES = ["done", "partial", "skipped", "failed"];

const requireUser = (res) => {
  const user = getRequestUser();
  if (!user) {
    res.status(401).json({ message: "Access key noto'g'ri" });
    return null;
  }
  return user;
};

/**
 * Panelda qaysi yurish ko'rsatiladi.
 *
 * Endi bir foydalanuvchida ikki xil yurish bo'lishi mumkin: kadastr
 * bo'yicha (asosiy) va random. Agar oddiygina "eng so'nggisi" olinsa,
 * bir marta random boshlangandan keyin kadastr yurishining natijasi
 * (masalan 1411 ta kiritilgan odam) paneldan butunlay yo'qolardi —
 * chunki random yurish hujjati har doim yangiroq bo'ladi.
 *
 * Qoida: hozir ishlayotgan yurish ko'rsatiladi; ishlayotgani
 * bo'lmasa — eng so'nggi KADASTR yurishi; u ham bo'lmasa — nima
 * bo'lsa o'shanisi.
 */
export const pickVisibleRun = async (uid) => {
  const runs = await RegistrationRun.find({ userUid: uid })
    .sort({ createdAt: -1 })
    .limit(10)
    .lean();

  if (!runs.length) return null;

  // 1. Hozir ishlayotgani — o'shani ko'rsatamiz.
  const active = runs.find((run) => isRunActiveAnywhere(run));
  if (active) return active;

  // 2. Ishlayotgani yo'q — ASOSIY (kadastr) yurish ustun.
  //
  // Diqqat: kadastr yurish faqat BITTA bo'ladi va u eng eskisi
  // bo'lishi mumkin (ko'p marta random boshlangan bo'lsa). Shuning
  // uchun uni `limit(10)` oynasidan emas, alohida so'rov bilan
  // olamiz — aks holda panel random ko'rinishida qotib qolardi.
  const cadaster = await RegistrationRun.findOne({
    userUid: uid,
    randomMode: { $ne: true },
    extraMode: { $ne: true },
  })
    .sort({ createdAt: -1 })
    .lean();

  if (cadaster) return cadaster;

  // 3. Kadastr yurish umuman bo'lmasa — nima bo'lsa o'shanisi.
  return runs[0];
};

/**
 * Shu token egasining MFY si.
 *
 * Token faqat o'z hududiga kirish beradi, shuning uchun MFY ni
 * foydalanuvchidan so'rashning hojati yo'q: oldin shu token bilan
 * yurish bo'lgan bo'lsa o'shanisi olinadi, bo'lmasa platformadan
 * yuklangan xonadonlar kadastri bo'yicha topiladi.
 */
export const resolveMahalla = async (user) => {
  // 1. Oldingi yurish bo'lsa — eng ishonchli manba.
  //
  // Random yurishlar hisobga olinmaydi: ularda mahalla aniqlanmasa
  // "random" kaliti yozilib qolishi mumkin, u esa bu yerga tushsa
  // kadastr yurishi boshqa mahallaga tegishlidek ko'rinardi va
  // "Boshlash" tugagan ishni topa olmay noldan yangi yurish
  // yaratardi.
  const previous = await RegistrationRun.findOne({
    userUid: user.uid,
    randomMode: { $ne: true },
  })
    .sort({ createdAt: -1 })
    .select("mahallaKey mahallaName")
    .lean();

  if (previous?.mahallaKey) {
    return { key: previous.mahallaKey, name: previous.mahallaName };
  }

  // 2. Aks holda: platformadagi xonadonlar kadastrlari qaysi
  //    mahallaga tegishli ekanini fuqarolar bazasidan qaraymiz.
  //
  // Kadastr uch xil yoziladi ("17:03:...", "17030102...",
  // "17 030 ... "), shuning uchun taqqoslash RAQAM bo'yicha ketadi
  // (`cadasterKey`). Avval aynan moslik qidirilardi va shu sababli
  // bir qism xonadon chetda qolardi.
  const cadasters = (
    await Home.distinct("cadasterNumber", { userUid: user.uid })
  ).filter(Boolean);

  if (!cadasters.length) return null;

  const wanted = new Set();
  for (const value of cadasters) {
    const key = cadasterKey(value);
    if (key) wanted.add(key);
  }

  if (!wanted.size) return null;

  // Fuqarolar bazasidagi mos kadastrlarning ASL yozilishi.
  const citizenCadasters = await Citizen.distinct("cadasterNumber");
  const matched = citizenCadasters.filter((value) => {
    const key = cadasterKey(value);
    return key ? wanted.has(key) : false;
  });

  if (!matched.length) return null;

  const rows = await Citizen.aggregate([
    { $match: { cadasterNumber: { $in: matched } } },
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
 * Odamning eng yaxshi natijasi (kichik son — kamroq muvaffaqiyat):
 *   4 — biz qo'shdik (added)
 *   3 — platformada allaqachon bor edi (exists)
 *   2 — boshqa MFY da ro'yxatda (ko'chib ketgan, movedAway)
 *   1 — kirmadi (failed/skipped)
 *   0 — hali urinilmagan
 *
 * "added" va "exists" ajratilgan: ikkalasi ham "odam bazada", lekin
 * biri bizning ishimiz, ikkinchisi avvaldan turgani. "movedAway" esa
 * rad etilganlardan ajratiladi: bu xato emas — odam shunchaki boshqa
 * mahallada yashaydi, mahalla xodimi uchun bu alohida ma'noli
 * ko'rsatkich.
 *
 * Kartochkalar (collectStats) va ro'yxatlar (dashboard-list) shu
 * ifodalardan foydalanadi — qoida bir joyda turadi.
 */
export const MEMBER_BEST_EXPR = {
  $switch: {
    branches: [
      { case: { $eq: ["$status", "added"] }, then: 4 },
      { case: { $eq: ["$status", "exists"] }, then: 3 },
      // Rad etilgan, lekin sababi "boshqa MFY da bor".
      {
        case: {
          $and: [
            { $in: ["$status", ["failed", "skipped"]] },
            { $eq: ["$movedAway", true] },
          ],
        },
        then: 2,
      },
      { case: { $in: ["$status", ["failed", "skipped"]] }, then: 1 },
    ],
    default: 0,
  },
};

// Odamning kaliti: tasdiqlangan JSHSHIR, bo'lmasa Excel'dagi, bo'lmasa
// F.I.Sh. (guvohnomali bolalarda JSHSHIR bo'lmaydi).
export const MEMBER_KEY_EXPR = {
  $ifNull: ["$verifiedPinfl", { $ifNull: ["$pinfl", "$fullName"] }],
};

/**
 * Odamlar uchun YAKUNIY urinishlar filtri.
 *
 * FAQAT tugagan kadastrlardagi urinishlar: pending kadastrdagi urinish
 * hali yakuniy emas, shuning uchun chiqarib tashlanadi.
 */
export const memberScopeMatch = ({ runIds, randomRunIds, pendingCadasters }) => ({
  $or: [
    {
      // Kadastr yurishlaridagi yakuniy urinishlar.
      runId: { $in: runIds },
      ...(pendingCadasters.length
        ? { cadasterNumber: { $nin: pendingCadasters } }
        : {}),
    },
    {
      // Random rejimda QO'SHILGANLAR — ular ham "added".
      runId: { $in: randomRunIds },
      status: "added",
    },
  ],
});

/**
 * Shu MFY ning hisob doirasi: qaysi yurishlar, qaysi xonadonlar
 * tugagan va qaysilari hali kutilmoqda.
 *
 * Kartochka sonlari va ro'yxatlar AYNAN shu natijadan olinadi —
 * shuning uchun ular doim bir-biriga mos keladi.
 */
export const resolveScope = async (run, userUid) => {
  // Hisob BITTA yurish bo'yicha emas, shu MFY ning HAMMA yurishlari
  // bo'yicha ketadi: ilgari tugagan yurishdan keyin "Boshlash"
  // bosilsa yangi bo'sh yurish yaratilardi va panel faqat o'shani
  // ko'rsatib, oldingi ish ko'rinmay qolardi.
  // Kadastr yurishlari — hisob-kitob shular bo'yicha ketadi
  // (xonadon, sabab, "allaqachon bor"). Random yurishlar bu yerga
  // KIRMAYDI: ularda xonadon yo'q, ko'p odam rad etiladi (tasodifiy
  // tanlov), va bu sonlar kadastr manzarasini buzardi. Random
  // rejimda QO'SHILGAN odamlar pastda alohida, additiv tarzda
  // qo'shiladi.
  const runIds = await RegistrationRun.distinct("_id", {
    userUid,
    mahallaKey: run.mahallaKey,
  });

  // Shu MFY ning random yurishlari (ularda mahallaKey username
  // bo'lishi mumkin, shuning uchun alohida olinadi).
  const randomRunIds = await RegistrationRun.distinct("_id", {
    userUid,
    randomMode: true,
  });

  // --- Xonadonlar ---
  //
  // Bir kadastr bir necha yurishda uchrashi mumkin, shuning uchun
  // har kadastrdan BITTA — eng yaxshi — holat olinadi.
  const homeRows = await RegistrationHome.find(
    { runId: { $in: runIds } },
    "cadasterNumber status",
  ).lean();

  const bestStatus = new Map();

  for (const row of homeRows) {
    if (!row.cadasterNumber) continue;

    const current = bestStatus.get(row.cadasterNumber);
    const isFinished = FINISHED_HOME_STATUSES.includes(row.status);

    if (!current || (isFinished && !FINISHED_HOME_STATUSES.includes(current))) {
      bestStatus.set(row.cadasterNumber, row.status);
    }
  }

  const allCadasters = [...bestStatus.keys()];

  // Hali ishlanmagan xonadonlar — "kutilmoqda" aynan shular
  // bo'yicha hisoblanadi.
  const pendingCadasters = allCadasters.filter(
    (cadaster) => !FINISHED_HOME_STATUSES.includes(bestStatus.get(cadaster)),
  );
  return { runIds, randomRunIds, bestStatus, allCadasters, pendingCadasters };
};

/**
 * Maketdagi 5 ta KPI kartasi uchun ko'rsatkichlar.
 *
 * "Jami aholi" — navbatdagi xonadonlarga tegishli fuqarolarning
 * ANIQ soni, taxmin emas.
 *
 * Nega bu muhim: avval qolganlar o'rtacha bilan baholanardi
 * (`urinilgan / tugagan_xonadon * qolgan_xonadon`). O'rtacha esa
 * har xonadondan keyin siljiydi, natijada "jami" raqami doimiy
 * o'zgarib turardi — 990, 987, 991... Foydalanuvchi aniq sonni
 * bila olmasdi va jarayon noto'g'ri ketayotgandek ko'rinardi.
 *
 * Endi son manbadan to'g'ridan-to'g'ri sanaladi: ishchi odamlarni
 * aynan `cadasterNumber` bo'yicha topadi (`registration-worker.js`),
 * shuning uchun navbatdagi kadastrlarga tegishli fuqarolarni
 * sanash kifoya. Bu son jarayon davomida O'ZGARMAYDI.
 *
 * Diqqat: butun fuqarolar bazasi emas, faqat SHU yurish navbati —
 * aks holda tumandagi 185 ming odam ko'rinib, foiz ma'nosiz
 * bo'lib qolardi.
 */
export const collectStats = async (run, userUid) => {
  const empty = {
    peopleTotal: 0,
    added: 0,
    exists: 0,
    movedAway: 0,
    failed: 0,
    pending: 0,
    homesTotal: 0,
    homesDone: 0,
    percent: 0,
  };

  if (!run) return empty;

  const scope = await resolveScope(run, userUid);
  const { allCadasters, pendingCadasters } = scope;

  const homesTotal = allCadasters.length;
  const homesDone = homesTotal - pendingCadasters.length;

  // --- Odamlar ---
  const [cadasterPeople, pending, people] = await Promise.all([
    Citizen.countDocuments({ cadasterNumber: { $in: allCadasters } }),

    // KUTILMOQDA = hali ishlanmagan xonadonlardagi odamlar.
    //
    // Nega ayirma bilan emas: ishchi platformada ALLAQACHON turgan
    // odamga so'rov yubormaydi (rate-limit ni tejash uchun), ya'ni
    // ularda `RegistrationMember` yozuvi umuman bo'lmaydi. Ayirma
    // bilan hisoblaganda ular "navbatda" bo'lib qolardi va xonadon
    // 424/424 tugagan holda ham "53 kishi kutilmoqda" ko'rinardi.
    //
    // Xonadon tugagan bo'lsa, undagi HAMMA odam ko'rib chiqilgan:
    // kimdir kiritilgan, kimdir rad etilgan, kimdir allaqachon
    // ro'yxatda bo'lgan. Kutayotgani qolmaydi.
    pendingCadasters.length
      ? Citizen.countDocuments({ cadasterNumber: { $in: pendingCadasters } })
      : 0,

    // Urinishlar ODAM bo'yicha guruhlanadi: bir odam bir necha marta
    // urinilgan bo'lishi mumkin (xonadon qayta ishlanganda).
    // Turli natija chiqqan bo'lsa eng yaxshisi olinadi — odam
    // baribir bazaga kirgan.
    //
    // FAQAT tugagan kadastrlardagi urinishlar: bir odam bir
    // kadastrda ishlanib (failed/moved), boshqa — hali `pending`
    // kadastrda ham turishi mumkin. Unda u ham o'z ustunida, ham
    // "kutilmoqda" da sanalib, yig'indi jamidan oshib ketardi.
    // Pending kadastrdagi urinish hali yakuniy emas, shuning uchun
    // chiqarib tashlanadi — odam "kutilmoqda" bo'lib qoladi.
    RegistrationMember.aggregate([
      {
        $match: memberScopeMatch(scope),
      },
      {
        $group: {
          _id: MEMBER_KEY_EXPR,
          best: { $max: MEMBER_BEST_EXPR },
        },
      },
      { $group: { _id: "$best", count: { $sum: 1 } } },
    ]),
  ]);

  const byBest = (value) =>
    people.find((row) => row._id === value)?.count ?? 0;

  // Biz haqiqatan qo'shgan odamlar — kadastr va random, ODAM
  // bo'yicha birlashtirilgan (yuqoridagi agregatsiya random
  // "added" larni ham qamrab oladi).
  const added = byBest(4);
  // Boshqa MFY da ro'yxatda turgani uchun kirita olmaganlar.
  const movedAway = byBest(2);
  // Haqiqiy xatolar (ma'lumot mos emas, hujjat yaroqsiz, ...).
  const failed = byBest(1);

  // JAMI AHOLI = kadastr xonadonlaridagi fuqarolar, lekin KAMIDA
  // allaqachon hisobga olinganlar yig'indisi. Random rejimda
  // qo'shilgan odamlar kadastr bazasida bo'lmasligi mumkin (ular
  // alohida tanlangan), shuning uchun "qo'shilgan" soni kadastr
  // aholisidan oshib ketishi mumkin. Bunday holda jami ularni ham
  // qamrab oladi — aks holda "qo'shilgan > jami" degan bema'nilik
  // chiqardi va `exists` manfiy bo'lardi.
  const peopleTotal = Math.max(
    cadasterPeople,
    added + movedAway + failed + pending,
  );

  // ALLAQACHON BOR = qolgan hammasi (ayirma bilan).
  //
  // Nega ayirma: platformada avvaldan turgan odamga ishchi so'rov
  // YUBORMAYDI (rate-limit tejash uchun), ya'ni ularning ko'pida
  // `RegistrationMember` yozuvi umuman bo'lmaydi. "exists" yozuvi
  // bo'lganlari ham bor, lekin ularni alohida sanab, yozuvsizlarini
  // ayirmadan qo'shsak ikki marta hisoblanib ketardi. Shuning uchun
  // butun qoldiq shu ustunga olinadi.
  //
  // Tugagan xonadondagi odam quyidagi holatlarda bo'ladi: biz
  // qo'shdik (added), avval shu bazada bor edi (exists), boshqa
  // MFY da ro'yxatda (movedAway), yoki rad etildi (failed).
  // Pending — hali ishlanmagan xonadonlarники. Demak qoldiq aynan
  // "allaqachon bor" ga teng.
  const exists = Math.max(
    0,
    peopleTotal - added - movedAway - failed - pending,
  );

  return {
    peopleTotal,
    added,
    exists,
    movedAway,
    failed,
    pending,
    homesTotal,
    homesDone,
    percent: homesTotal > 0 ? Math.round((homesDone / homesTotal) * 100) : 0,
  };
};

/** Jonli ro'yxat uchun bitta qator. */
export const describeMember = (member) => ({
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

    // Shu tokenga tegishli ko'rsatiladigan yurish.
    const run = await pickVisibleRun(user.uid);

    const [stats, members, currentHome, randomTotalRows] = await Promise.all([
      collectStats(run, user.uid),
      run
        ? RegistrationMember.find({
            // Jonli ro'yxat ham SHU foydalanuvchining barcha
            // urinishlaridan — yurish almashgani ro'yxatni
            // bo'shatib yubormasligi kerak.
            userUid: user.uid,
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

      // Barcha RANDOM yurishlar bo'yicha JAMI muvaffaqiyatli
      // qo'shilgan — faqat random rejim ko'rinayotganda kerak.
      run?.randomMode
        ? RegistrationRun.aggregate([
            { $match: { userUid: user.uid, randomMode: true } },
            { $group: { _id: null, total: { $sum: "$randomAdded" } } },
          ])
        : Promise.resolve([]),
    ]);

    const isActive = run ? isRunActiveAnywhere(run) : false;
    const randomAddedTotal = randomTotalRows[0]?.total ?? 0;

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
            randomMode: run.randomMode ?? false,
            randomTarget: run.randomTarget ?? 0,
            randomAdded: run.randomAdded ?? 0,
            // Barcha random yurishlar bo'yicha jami.
            randomAddedTotal,
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
        // Diqqat: sabab odatda Excel EMAS. Fuqarolar bazasi joyida
        // turgan bo'lsa ham, shu token uchun platformadan
        // xonadonlar hali yuklanmagan bo'ladi — "Hisoblash" aynan
        // shuni qiladi. Avvalgi matn "Excel yuklang" deb turardi va
        // chalg'itardi: baza to'la bo'lsa ham xato o'zgarmasdi.
        const citizensTotal = await Citizen.estimatedDocumentCount();

        return res.status(404).json({
          message: citizensTotal
            ? "Mahalla hali hisoblanmagan — avval \"Hisoblash\" tugmasini bosing"
            : "Fuqarolar bazasi bo'sh — avval Excel yuklang",
        });
      }

      // SHU MAHALLA uchun yurish bo'lsa, o'shani davom ettiramiz.
      //
      // Diqqat: `done` ham qidiruvga KIRADI. Avval kirmasdi va
      // natijada tugagan yurishdan keyin "Boshlash" bosilsa, yangi
      // BO'SH yurish yaratilardi. Panel esa faqat eng so'nggi
      // yurishni ko'rsatadi — shuning uchun oldingi ishning
      // natijasi (masalan 855 kiritilgan odam) ko'rinmay qolardi va
      // hammasi noldan boshlangandek tuyulardi.
      //
      // Qayta ishlash xavfsiz: ishchi allaqachon ro'yxatda
      // turganlarni `takenPinfls` orqali o'tkazib yuboradi, ya'ni
      // platformada dublikat paydo bo'lmaydi.
      //
      // Bitta mahallaga bitta yurish — hisobot ham, panel ham shu
      // qoidaga tayanadi.
      //
      // Random yurishlar bu qidiruvga KIRMAYDI. "Boshlash" — bu
      // kadastr bo'yicha yurish. Random alohida tugma bilan
      // boshlanadi va alohida yurish hujjatida yashaydi; uni bu
      // yerda ilib olish tugagan kadastr ishini qaytadan random
      // rejimga burib yuborardi.
      const resumable = await RegistrationRun.findOne({
        userUid: user.uid,
        mahallaKey: mahalla.key,
        randomMode: { $ne: true },
      })
        .select("+token")
        .sort({ createdAt: -1 });

      if (resumable) {
        if (isRunActiveAnywhere(resumable)) {
          return res
            .status(200)
            .json({ message: "Jarayon allaqachon ketmoqda" });
        }

        // Yurish allaqachon tugagan bo'lsa, "Boshlash" — bu qayta
        // urinish. Navbatda `pending` xonadon qolmagani uchun ishchi
        // darhol chiqib ketardi, shuning uchun VAQTINCHALIK sabab
        // bilan chetda qolgan xonadonlarni navbatga qaytaramiz.
        //
        // Faqat vaqtinchalik sabablar: tashqi server xatosi va
        // tarmoq uzilishi. Qolganlari (vafot etgan, boshqa xonadon
        // egasi, hujjat nuqsoni) qayta urinishdan o'zgarmaydi —
        // ularni qaytarish rate-limit ni bekorga sarflardi.
        let requeued = 0;

        if (resumable.status === "done") {
          const retryable = await RegistrationMember.distinct("homeRowId", {
            runId: resumable._id,
            reasonCode: { $in: ["server_xatosi", "tarmoq"] },
          });

          if (retryable.length) {
            const result = await RegistrationHome.updateMany(
              { _id: { $in: retryable }, runId: resumable._id },
              { $set: { status: "pending" } },
            );
            requeued = result.modifiedCount;
          }

          if (!requeued) {
            return res.status(200).json({
              message: "Bu mahalla bo'yicha qayta urinadigan yozuv qolmadi",
            });
          }
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

        return res.status(202).json({
          message: requeued
            ? `${requeued} ta xonadon qayta urinish uchun navbatga qaytarildi`
            : "Davom ettirildi",
        });
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

    // pause / stop — panelda ko'rinib turgan yurish to'xtatiladi,
    // ya'ni aynan foydalanuvchi kuzatayotgani (kadastr yoki random).
    const visible = await pickVisibleRun(user.uid);
    const run = visible
      ? await RegistrationRun.findById(visible._id).select("+token")
      : null;

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
 * POST /api/dashboard/random-start  { target: number, homeId?: string }
 *
 * Random rejimda bitta xonadonga MFY dagi ixtiyoriy fuqarolarni
 * qo'shadi. `target` — nechta muvaffaqiyatli qo'shish kerak.
 *
 * Xonadon platformadan topiladi: birinchi ko'chaning birinchi
 * xonadoni olinadi (yoki `homeId` berilsa o'sha).
 */
export const randomStart = async (req, res) => {
  const user = requireUser(res);
  if (!user) return;

  const target = Number(req.body?.target);
  if (!Number.isFinite(target) || target < 1 || target > 50000) {
    return res.status(400).json({ message: "Maqsad soni 1 dan 50000 gacha bo'lishi kerak" });
  }

  try {
    const token = getRequestToken();

    // Allaqachon ishlayotgan yurish bormi?
    //
    // Random ham, kadastr ham tekshiriladi: ikkalasi bir vaqtda
    // ketsa tashqi API limitini bo'lishib olishardi va ikkalasi ham
    // sekinlashardi.
    const running = await RegistrationRun.find({
      userUid: user.uid,
      status: { $in: ["pending", "preparing", "running"] },
    }).limit(10);

    const active = running.find((run) => isRunActiveAnywhere(run));

    if (active) {
      return res.status(200).json({
        message: active.randomMode
          ? "Random jarayon allaqachon ketmoqda"
          : "Avval joriy jarayonni to'xtating",
      });
    }

    // Xonadon topish: platformadan birinchi ko'chaning birinchi
    // xonadonini olamiz — oila a'zolarini o'shanga qo'shamiz.
    const requestedHomeId = req.body?.homeId ? String(req.body.homeId) : null;

    let homeId = requestedHomeId;
    let streetId = null;
    let surveyUuid = null;
    let ownerPinfl = null;

    if (homeId) {
      // Berilgan homeId dan formani yuklaymiz.
      const formResponse = await api.get(`/web/v1/forms/survey_homes/${homeId}`, {
        params: {
          obl_id: user.oblId,
          area_id: user.areaId,
          district_id: user.districtId,
        },
      });

      const formData = formResponse.formData ?? null;
      if (!formData?.survey_uuid) {
        return res.status(400).json({ message: "Xonadon formasi yuklanmadi yoki survey_uuid yo'q" });
      }

      surveyUuid = formData.survey_uuid;
      ownerPinfl = formData.pinfl ? String(formData.pinfl) : null;

      // streetId ni Home kolleksiyasidan yoki RegistrationHome dan topamiz.
      const home = await Home.findOne({ homeId, userUid: user.uid }).lean();
      streetId = home?.streetId ?? null;

      if (!streetId) {
        const regHome = await RegistrationHome.findOne({ homeId }).lean();
        streetId = regHome?.streetId ?? null;
      }

      if (!streetId) {
        return res.status(400).json({ message: "Ko'cha (streetId) aniqlanmadi — xonadon topilmadi" });
      }
    } else {
      // Avtomatik tanlash: birinchi ko'chadan birinchi xonadon.
      const streets = await api.get("/api/v1/survey_homes/cache/street", {
        params: {
          obl_id: user.oblId,
          area_id: user.areaId,
          district_id: user.districtId,
        },
      }).then((r) => r.data?.results ?? []);

      if (!streets.length) {
        return res.status(404).json({ message: "Ko'chalar topilmadi" });
      }

      // Xonadon bor ko'chani topamiz.
      //
      // Diqqat: `surveyed` MAJBURIY parametr — uni yubormasa
      // platforma bo'sh ro'yxat qaytaradi (tekshirildi: 0 ta).
      // Qiymati 0 yoki 1 bo'lishidan qat'i nazar bir xil xonadonlar
      // keladi, shuning uchun 0 qoldirilgan.
      // Platformada bitta xonadonga cheklangan sondagi a'zo sig'adi
      // (odatda 20, ba'zan 15). Birinchi uchragan xonadon odatda
      // to'la bo'ladi, shuning uchun bo'sh joyi borini qidiramiz —
      // aks holda hamma so'rov "N tadan ziyod" deb rad etilardi.
      const HOME_MEMBER_LIMIT = 20;

      // Nechta xonadonni tekshiramiz: har biri 2 ta so'rov, ya'ni
      // rate-limit bilan uzoq kutish. Lekin juda kam tekshirish ham
      // yaramaydi: oldingi yurishlardan keyin birinchi o'nlab
      // xonadon to'lib qolgan bo'ladi va qidiruv "xonadon topilmadi"
      // deb to'xtab qolardi.
      const MAX_PROBES = 60;
      let probes = 0;

      // Oldingi yurishlarda O'ZIMIZ to'ldirgan xonadonlarni
      // bilamiz — ularni platformadan qayta so'rab, rate-limitni
      // behuda sarflamaymiz.
      const filled = await RegistrationMember.aggregate([
        { $match: { userUid: user.uid, status: "added" } },
        { $group: { _id: "$homeId", n: { $sum: 1 } } },
        { $match: { n: { $gte: 12 } } },
      ]);
      const likelyFull = new Set(filled.map((row) => String(row._id)));

      outer: for (const street of streets) {
        const homesResponse = await api.get("/api/v1/survey_homes_street/cache/data", {
          params: {
            obl_id: user.oblId,
            area_id: user.areaId,
            district_id: user.districtId,
            street_id: String(street.id),
            surveyed: 0,
            page: 1,
            size: 100,
          },
        });

        const homes = homesResponse.data?.results ?? [];

        for (const home of homes) {
          if (probes >= MAX_PROBES) break outer;
          if (likelyFull.has(String(home.id))) continue;
          probes += 1;

          const form = await api
            .get(`/web/v1/forms/survey_homes/${home.id}`, {
              params: {
                obl_id: user.oblId,
                area_id: user.areaId,
                district_id: user.districtId,
              },
            })
            .then((r) => r.formData ?? null)
            .catch(() => null);

          if (!form?.survey_uuid) continue;

          const members = await api
            .get("/web/v1/tables/survey_homes_family/data", {
              params: {
                obl_id: user.oblId,
                area_id: user.areaId,
                district_id: user.districtId,
                street_id: String(street.id),
                survey_uuid: form.survey_uuid,
              },
            })
            .then((r) => r.data?.results ?? [])
            .catch(() => []);

          if (members.length >= HOME_MEMBER_LIMIT) continue;

          homeId = String(home.id);
          streetId = String(street.id);
          surveyUuid = form.survey_uuid;
          ownerPinfl = form.pinfl ? String(form.pinfl) : null;
          break outer;
        }
      }

      if (!homeId || !streetId || !surveyUuid) {
        return res.status(404).json({
          message: `Bo'sh joyi bor xonadon topilmadi (${probes} ta tekshirildi) — hammasi to'lgan bo'lishi mumkin`,
        });
      }

    }

    // Mahalla nomini aniqlash.
    const mahalla = await resolveMahalla(user);

    const run = await RegistrationRun.create({
      mahallaKey: mahalla?.key ?? "random",
      mahallaName: mahalla?.name ?? "Random rejim",
      status: "pending",
      control: "run",
      userUid: user.uid,
      token,
      oblId: user.oblId,
      areaId: user.areaId,
      districtId: user.districtId,
      randomMode: true,
      randomTarget: target,
      randomAdded: 0,
      randomHomeId: homeId,
      randomStreetId: streetId,
      randomSurveyUuid: surveyUuid,
      randomOwnerPinfl: ownerPinfl,
    });

    runRegistration(user, run, token);

    return res.status(202).json({
      message: `Random rejim boshlandi — ${target} ta muvaffaqiyatli qo'shish maqsad`,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message || "Server xatoligi" });
  }
};

/**
 * POST /api/dashboard/extra-start
 *
 * "Qo'shimcha a'zolar" rejimi: platformadan yuklangan (pa_survey_general)
 * qo'shimcha a'zolarni kadastr bo'yicha oila a'zosi sifatida
 * platformaga qo'shadi. Telefon yo'q bo'lsa avto-generate qilinadi.
 */
export const extraStart = async (req, res) => {
  const user = requireUser(res);
  if (!user) return;

  try {
    const token = getRequestToken();

    // Allaqachon ishlayotgan yurish bo'lmasin.
    const running = await RegistrationRun.find({
      userUid: user.uid,
      status: { $in: ["pending", "preparing", "running"] },
    }).limit(10);

    if (running.find((run) => isRunActiveAnywhere(run))) {
      return res.status(200).json({ message: "Avval joriy jarayonni to'xtating" });
    }

    // Yuklangan qo'shimcha a'zolar bormi? Kadastr emas, homeId tekshiriladi:
    // kadastr ba'zi MFY larda bo'sh qaytadi, lekin POST uchun kerak emas.
    const count = await FamilyMember.countDocuments({
      userUid: user.uid,
      isOwner: { $ne: true },
      homeId: { $nin: [null, ""] },
    });

    if (!count) {
      return res.status(404).json({
        message:
          "Qo'shimcha a'zolar yuklanmagan — avval \"Qo'shimcha a'zolar\" bo'limida yuklang",
      });
    }

    const mahalla = await resolveMahalla(user);

    const run = await RegistrationRun.create({
      mahallaKey: mahalla?.key ?? "extra",
      mahallaName: mahalla?.name ?? "Qo'shimcha a'zolar",
      status: "pending",
      control: "run",
      userUid: user.uid,
      token,
      oblId: user.oblId,
      areaId: user.areaId,
      districtId: user.districtId,
      extraMode: true,
    });

    runRegistration(user, run, token);

    return res.status(202).json({
      message: `Qo'shimcha a'zolar rejimi boshlandi — ${count} ta a'zo`,
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
