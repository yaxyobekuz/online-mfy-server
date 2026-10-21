import mongoose from "mongoose";
import Citizen from "../models/Citizen.js";
import RegistrationHome from "../models/RegistrationHome.js";
import RegistrationMember from "../models/RegistrationMember.js";
import { getRequestUser } from "../utils/request-context.js";
import {
  describeMember,
  isHomeFinished,
  MEMBER_BEST_EXPR,
  MEMBER_KEY_EXPR,
  memberScopeMatch,
  pickVisibleRun,
  resolveScope,
} from "./dashboard.controller.js";

/**
 * Asosiy sahifa kartochkalarining "ro'yxati".
 *
 * Har kartochka bosilganda shu yerdagi ro'yxat ochiladi. Sonlar
 * `collectStats` bilan BIR XIL qoida va BIR XIL manbadan
 * (`resolveScope`, `memberScopeMatch`, `MEMBER_BEST_EXPR`) olinadi —
 * shuning uchun kartochkadagi 27 ta ro'yxatda ham 27 ta chiqadi.
 */

const PAGE_SIZE = 50;

// Jonli kuzatuvdagi "Ba'tafsil qidiruv" bir sahifada nechta
// yozuv ko'rsatadi. Jonli ro'yxat (SSE) oxirgi 40 tani beradi,
// qidiruv esa shundan eskiroqlariga ham yetadi.
const FEED_PAGE_SIZE = 40;

// Kartochka kalitlari — client'dagi URL ham shularni ishlatadi.
export const LIST_KINDS = {
  total: "Jami aholi",
  added: "Ro'yxatga olingan aholi",
  exists: "Platformada mavjud aholi",
  movedAway: "Boshqa MFY da mavjud",
  failed: "Ro'yxatga olib bo'lmagan aholi",
  pending: "Ro'yxatga olinish kutilmoqda",
  homes: "Jami xonadon",
};

// MEMBER_BEST_EXPR qiymatini odam holati nomiga o'giramiz.
const BEST_TO_STATUS = {
  4: "added",
  3: "exists",
  2: "movedAway",
  1: "failed",
  0: "pending",
};

// Qaysi kartochka qaysi "eng yaxshi natija"ga to'g'ri keladi.
const MEMBER_KIND_BEST = { added: 4, movedAway: 2, failed: 1 };

const parsePage = (value) => {
  const page = Number.parseInt(value, 10);
  return Number.isFinite(page) && page > 0 ? page : 1;
};

const newestFirst = (a, b) => new Date(b.at ?? 0) - new Date(a.at ?? 0);

// Odam urinishi (RegistrationMember) qatori.
const memberRow = (doc, best) => ({
  ...describeMember(doc),
  kind: "member",
  status: BEST_TO_STATUS[best],
  cadasterNumber: doc.cadasterNumber ?? null,
  document: doc.document ?? null,
  subtitle: null,
});

// Bazadagi fuqaro qatori (urinilmagan yoki platformada bor odam).
const citizenRow = (citizen, status) => ({
  id: String(citizen._id),
  kind: "citizen",
  fullName: citizen.fullName ?? citizen.fullNameCyrillic ?? "—",
  pinfl: citizen.pinfl ?? null,
  cadasterNumber: citizen.cadasterNumber ?? null,
  document: citizen.document ?? null,
  status,
  subtitle: citizen.address ?? null,
  reasonLabel: null,
  durationMs: null,
  at: null,
});

// Xonadon qatori.
const homeRow = (home) => ({
  id: String(home._id),
  kind: "home",
  fullName: home.ownerFullName ?? "—",
  pinfl: home.ownerPinfl ?? null,
  cadasterNumber: home.cadasterNumber ?? null,
  document: null,
  status: home.status,
  subtitle:
    [home.streetName, home.homeNum ? `${home.homeNum}-uy` : null]
      .filter(Boolean)
      .join(", ") || null,
  reasonLabel: home.reason ?? null,
  durationMs: home.durationMs ?? null,
  at: home.finishedAt ?? home.updatedAt ?? null,
});

/**
 * Berilgan kartochka uchun qatorlar. Sonlar kartochkalar bilan mos
 * kelishi uchun quyidagilar `collectStats` dagi bilan bir xil:
 *   - added/movedAway/failed: odam bo'yicha eng yaxshi natija;
 *   - pending: hali ishlanmagan xonadonlardagi fuqarolar;
 *   - exists: tugagan xonadonlardagi, lekin biz qo'shmagan/rad
 *     etmagan (qoldiq) fuqarolar;
 *   - total: kadastr xonadonlaridagi hamma fuqarolar.
 */
const buildRows = async (kind, run, userUid) => {
  const scope = await resolveScope(run, userUid);
  // Odamlar klassifikatsiyasi (pending/exists) collectStats bilan AYNI
  // bo'lishi uchun "stats" pending'dan foydalanamiz: qayta navbatga
  // qo'yilgan tugagan xonadonning odamlari "kutilmoqda" ga tushib
  // ketmaydi.
  const { allCadasters, statsPendingCadasters } = scope;
  const pendingSet = new Set(statsPendingCadasters);

  if (kind === "homes") {
    const homes = await RegistrationHome.find({
      runId: { $in: scope.runIds },
      cadasterNumber: { $in: allCadasters },
    })
      .sort({ queueIndex: 1 })
      .lean();

    // Kadastr bo'yicha BITTA xonadon — collectStats bilan bir xil
    // tanlov: birinchi tugagan yozuv ustun turadi.
    const chosen = new Map();
    for (const home of homes) {
      const current = chosen.get(home.cadasterNumber);
      const isFinished = isHomeFinished(home);

      if (!current || (isFinished && !isHomeFinished(current))) {
        chosen.set(home.cadasterNumber, home);
      }
    }

    return [...chosen.values()].map(homeRow);
  }

  // Odamlar: kalit bo'yicha eng yaxshi urinish (collectStats bilan bir xil).
  const attempts = await RegistrationMember.aggregate([
    { $match: memberScopeMatch(scope) },
    {
      $project: {
        fullName: 1,
        verifiedFullName: 1,
        pinfl: 1,
        verifiedPinfl: 1,
        document: 1,
        status: 1,
        reason: 1,
        reasonCode: 1,
        durationMs: 1,
        createdAt: 1,
        cadasterNumber: 1,
        movedAway: 1,
        best: MEMBER_BEST_EXPR,
        key: MEMBER_KEY_EXPR,
      },
    },
    { $sort: { best: -1, createdAt: -1 } },
    {
      $group: {
        _id: "$key",
        best: { $first: "$best" },
        doc: { $first: "$$ROOT" },
      },
    },
  ]);

  if (kind in MEMBER_KIND_BEST) {
    const want = MEMBER_KIND_BEST[kind];
    return attempts
      .filter((group) => group.best === want)
      .map((group) => memberRow(group.doc, group.best))
      .sort(newestFirst);
  }

  // Bazadagi fuqarolar — kartochka sonlari shu ro'yxatdan olinadi.
  const bestByKey = new Map(attempts.map((group) => [group._id, group.best]));
  const keyOf = (citizen) => citizen.pinfl ?? citizen.fullName ?? null;
  const bestOf = (citizen) => {
    const key = keyOf(citizen);
    return key ? bestByKey.get(key) : undefined;
  };

  const citizens = await Citizen.find({ cadasterNumber: { $in: allCadasters } })
    .select("fullName fullNameCyrillic pinfl document cadasterNumber address rowNumber")
    .sort({ rowNumber: 1, _id: 1 })
    .lean();

  if (kind === "pending") {
    return citizens
      .filter((citizen) => pendingSet.has(citizen.cadasterNumber))
      .map((citizen) => citizenRow(citizen, "pending"));
  }

  if (kind === "exists") {
    return citizens
      .filter((citizen) => !pendingSet.has(citizen.cadasterNumber))
      .filter((citizen) => ![4, 2, 1].includes(bestOf(citizen)))
      .map((citizen) => citizenRow(citizen, "exists"));
  }

  if (kind === "total") {
    return citizens.map((citizen) => {
      const best = bestOf(citizen);
      if (best !== undefined) return citizenRow(citizen, BEST_TO_STATUS[best]);
      return citizenRow(
        citizen,
        pendingSet.has(citizen.cadasterNumber) ? "pending" : "exists",
      );
    });
  }

  return [];
};

const matchesSearch = (row, query) =>
  [row.fullName, row.pinfl, row.cadasterNumber, row.document, row.subtitle]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(query));

/**
 * GET /api/dashboard/list?kind=added&page=1&search=...
 *
 * Kartochka ro'yxati, sahifalangan. `total` — qidiruvdan keyingi son,
 * `count` — qidiruvsiz (kartochkadagi son bilan solishtirish uchun).
 */
export const getDashboardList = async (req, res) => {
  const user = getRequestUser();
  if (!user) return res.status(401).json({ message: "Access key noto'g'ri" });

  const kind = String(req.query.kind ?? "");
  if (!Object.hasOwn(LIST_KINDS, kind)) {
    return res.status(400).json({ message: "Noto'g'ri ro'yxat turi" });
  }

  try {
    const run = await pickVisibleRun(user.uid);
    const rows = run ? await buildRows(kind, run, user.uid) : [];

    const query = String(req.query.search ?? "").trim().toLowerCase();
    const filtered = query
      ? rows.filter((row) => matchesSearch(row, query))
      : rows;

    const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    const page = Math.min(parsePage(req.query.page), totalPages);
    const start = (page - 1) * PAGE_SIZE;

    return res.status(200).json({
      kind,
      title: LIST_KINDS[kind],
      count: rows.length,
      total: filtered.length,
      page,
      pageSize: PAGE_SIZE,
      totalPages,
      items: filtered.slice(start, start + PAGE_SIZE),
    });
  } catch {
    return res.status(500).json({ message: "Server xatoligi" });
  }
};

// Foydalanuvchi kiritgan matnni regex ichida xavfsiz ishlatish
// uchun maxsus belgilarni qochiramiz — aks holda "(" kabi belgi
// so'rovni buzardi.
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Jonli kuzatuv qidiruvida tanlanishi mumkin bo'lgan holatlar.
// "movedAway" — status emas, alohida belgi (odam boshqa MFY da),
// shuning uchun u filtrda `movedAway: true` ga aylanadi.
const FEED_STATUSES = ["added", "exists", "failed", "skipped", "movedAway"];

/**
 * GET /api/dashboard/feed?search=&status=&page=
 *
 * Jonli kuzatuvning "Ba'tafsil qidiruv"i. Jonli ro'yxat faqat
 * oxirgi 40 urinishni ko'rsatadi; bu endpoint esa shu foydalanuvchi
 * bo'ylab (BARCHA yurishlar — eski natijalar ham) qidirib,
 * sahifalab beradi.
 *
 * Qidiruv ism (manba va tasdiqlangan), JSHSHIR va kadastr bo'yicha
 * ketadi. Natija eng yangisidan boshlab tartiblanadi.
 */
export const getDashboardFeed = async (req, res) => {
  const user = getRequestUser();
  if (!user) return res.status(401).json({ message: "Access key noto'g'ri" });

  try {
    const search = String(req.query.search ?? "").trim();
    const status = String(req.query.status ?? "").trim();

    // "pending" — hali urinilmagan, natijasi yo'q — jonli ro'yxatdagi
    // kabi uni ko'rsatmaymiz.
    const filter = { userUid: user.uid, status: { $ne: "pending" } };

    if (status === "movedAway") {
      filter.movedAway = true;
    } else if (FEED_STATUSES.includes(status)) {
      filter.status = status;
    }

    if (search) {
      const rx = new RegExp(escapeRegex(search), "i");
      filter.$or = [
        { fullName: rx },
        { verifiedFullName: rx },
        { pinfl: rx },
        { verifiedPinfl: rx },
        { cadasterNumber: rx },
      ];
    }

    const total = await RegistrationMember.countDocuments(filter);
    const totalPages = Math.max(1, Math.ceil(total / FEED_PAGE_SIZE));
    const page = Math.min(parsePage(req.query.page), totalPages);
    const skip = (page - 1) * FEED_PAGE_SIZE;

    const members = await RegistrationMember.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(FEED_PAGE_SIZE)
      .select(
        "fullName verifiedFullName pinfl verifiedPinfl status reason reasonCode durationMs createdAt",
      )
      .lean();

    return res.status(200).json({
      total,
      page,
      pageSize: FEED_PAGE_SIZE,
      totalPages,
      items: members.map(describeMember),
    });
  } catch {
    return res.status(500).json({ message: "Server xatoligi" });
  }
};

/**
 * GET /api/dashboard/citizens/:citizenId
 * Ro'yxatdagi fuqaroning "Ba'tafsil"i: bazadagi yozuv, davlat bazasi
 * javoblari va shu foydalanuvchining urinishlari.
 */
export const getDashboardCitizen = async (req, res) => {
  const user = getRequestUser();
  if (!user) return res.status(401).json({ message: "Access key noto'g'ri" });

  const { citizenId } = req.params;
  if (!mongoose.isValidObjectId(citizenId)) {
    return res.status(400).json({ message: "ID noto'g'ri" });
  }

  try {
    const citizen = await Citizen.findById(citizenId).lean();
    if (!citizen) return res.status(404).json({ message: "Yozuv topilmadi" });

    const attempts = await RegistrationMember.find({
      userUid: user.uid,
      $or: [
        { citizenId: citizen._id },
        ...(citizen.pinfl ? [{ pinfl: citizen.pinfl }] : []),
      ],
    })
      .sort({ createdAt: -1 })
      .select(
        "fullName verifiedFullName pinfl verifiedPinfl status reason reasonCode durationMs createdAt",
      )
      .lean();

    return res.status(200).json({
      kind: "citizen",
      id: String(citizen._id),
      fullName: citizen.fullName ?? null,
      fullNameCyrillic: citizen.fullNameCyrillic ?? null,
      birthDate: citizen.birthDate ?? null,
      document: citizen.document ?? null,
      documentType: citizen.documentType ?? null,
      pinfl: citizen.pinfl ?? null,
      cadasterNumber: citizen.cadasterNumber ?? null,
      address: citizen.address ?? null,
      rowNumber: citizen.rowNumber ?? null,
      documentExpired: Boolean(citizen.documentExpired),
      fatherFullName: citizen.fatherFullName ?? null,
      fatherPinfl: citizen.fatherPinfl ?? null,
      motherFullName: citizen.motherFullName ?? null,
      motherPinfl: citizen.motherPinfl ?? null,
      gcpSyncedAt: citizen.gcpSyncedAt ?? null,
      birthCertSyncedAt: citizen.birthCertSyncedAt ?? null,
      gcpData: citizen.gcpData ?? null,
      birthCertData: citizen.birthCertData ?? null,
      attempts: attempts.map(describeMember),
    });
  } catch {
    return res.status(500).json({ message: "Server xatoligi" });
  }
};

/**
 * GET /api/dashboard/homes/:homeId
 * Xonadonning "Ba'tafsil"i: xonadon holati, sonlari va shu xonadondagi
 * a'zolarning urinishlari.
 */
export const getDashboardHome = async (req, res) => {
  const user = getRequestUser();
  if (!user) return res.status(401).json({ message: "Access key noto'g'ri" });

  const { homeId } = req.params;
  if (!mongoose.isValidObjectId(homeId)) {
    return res.status(400).json({ message: "ID noto'g'ri" });
  }

  try {
    const home = await RegistrationHome.findOne({
      _id: homeId,
      userUid: user.uid,
    }).lean();
    if (!home) return res.status(404).json({ message: "Yozuv topilmadi" });

    const members = await RegistrationMember.find({
      userUid: user.uid,
      homeRowId: home._id,
    })
      .sort({ createdAt: 1 })
      .select(
        "fullName verifiedFullName pinfl verifiedPinfl status reason reasonCode durationMs createdAt",
      )
      .lean();

    return res.status(200).json({
      kind: "home",
      id: String(home._id),
      streetName: home.streetName ?? null,
      homeNum: home.homeNum ?? null,
      cadasterNumber: home.cadasterNumber ?? null,
      ownerFullName: home.ownerFullName ?? null,
      ownerPinfl: home.ownerPinfl ?? null,
      status: home.status,
      reason: home.reason ?? null,
      existingCount: home.existingCount ?? 0,
      candidatesCount: home.candidatesCount ?? 0,
      addedCount: home.addedCount ?? 0,
      failedCount: home.failedCount ?? 0,
      skippedCount: home.skippedCount ?? 0,
      durationMs: home.durationMs ?? null,
      startedAt: home.startedAt ?? null,
      finishedAt: home.finishedAt ?? null,
      members: members.map(describeMember),
    });
  } catch {
    return res.status(500).json({ message: "Server xatoligi" });
  }
};
