import * as XLSX from "xlsx";
import api from "../config/api.js";
import FamilyMember from "../models/FamilyMember.js";
import { getRequestUser } from "../utils/request-context.js";
import { withRateLimit, getRateLimitState } from "../utils/rate-limit.js";

/**
 * MFY ning BARCHA xonadonlari va ulardagi oila a'zolarini yuklab,
 * DB'ga saqlaydi. Har a'zoga xonadon kadastri biriktiriladi va
 * qarindoshlik (relationship) ham yoziladi.
 *
 * Endpoint zanjiri (barchasi token hududi bo'yicha):
 *   1. survey_homes/cache/street          — ko'chalar
 *   2. survey_homes_street/cache/data      — xonadonlar (kadastr, egasi)
 *   3. forms/survey_homes/{homeId}         — survey_uuid
 *   4. tables/pa_survey_family/data        — a'zolar ro'yxati (id + matn)
 *   5. forms/survey_v3_family/{memberId}   — a'zo detali (kod, hujjat)
 *
 * 4-qadam bitta so'rovda butun xonadon a'zolarini beradi; 5-qadam
 * esa HAR A'ZOGA alohida so'rov — shuning uchun jarayon uzoq
 * (minglab so'rov). Shu sabab:
 *   - fonda ishlaydi (so'rov darhol qaytadi),
 *   - holati saqlanadi (sahifa yopilsa ham ko'rinadi),
 *   - a'zolar bosqichma-bosqich DB'ga yoziladi (to'xtasa ham
 *     yozilgani qoladi).
 */

const PAGE_SIZE = 100;

// Jarayon holati — xotirada (uid bo'yicha). Oddiy so'rov bilan
// o'qiladi: SSE shart emas.
const scans = new Map();

const scanState = (uid) =>
  scans.get(uid) ?? {
    status: "idle",
    stage: null,
    error: null,
    streetsTotal: 0,
    homesTotal: 0,
    homesDone: 0,
    membersFound: 0,
    membersSaved: 0,
  };

const setScan = (uid, patch) => scans.set(uid, { ...scanState(uid), ...patch });

// To'xtatish bayrog'i (foydalanuvchi "to'xtatish" bossa).
const stopFlags = new Set();

/**
 * Shu MFY ning yuklash jarayonini tashqaridan to'xtatish — token
 * o'chirilganda chaqiriladi.
 */
export const stopHomeMembersScanFor = (uid) => {
  if (scanState(uid).status === "running") stopFlags.add(uid);
};

const limited = (uid, fn) =>
  withRateLimit(fn, { delayMs: 150, adaptiveKey: `home-members:${uid}` });

// --- Tashqi API chaqiruvlari ---

const fetchStreets = (user) =>
  limited(user.uid, () =>
    api.get("/api/v1/survey_homes/cache/street", {
      params: {
        obl_id: user.oblId,
        area_id: user.areaId,
        district_id: user.districtId,
      },
    }),
  ).then((r) => r.data?.results ?? []);

const fetchStreetHomes = async (user, streetId) => {
  const all = [];
  let page = 1;
  let total = Infinity;

  while ((page - 1) * PAGE_SIZE < total) {
    const response = await limited(user.uid, () =>
      api.get("/api/v1/survey_homes_street/cache/data", {
        params: {
          obl_id: user.oblId,
          area_id: user.areaId,
          district_id: user.districtId,
          street_id: streetId,
          surveyed: 0,
          page,
          size: PAGE_SIZE,
        },
      }),
    );

    const results = response.data?.results ?? [];
    all.push(...results);
    total = response.data?.total ?? 0;
    page += 1;

    if (!results.length) break;
  }

  return all;
};

// Xonadon so'rovnomasi — survey_uuid VA egasining ma'lumoti shu
// yerdan. Egasi a'zolar ro'yxatida bo'lmasligi mumkin, formadagi
// qiymat esa xonadon ro'yxatidagidan ("- " kabi joy to'ldirgich)
// ishonchliroq.
const fetchHomeForm = (user, homeId) =>
  limited(user.uid, () =>
    api.get(`/web/v1/forms/survey_homes/${homeId}`, {
      params: {
        obl_id: user.oblId,
        area_id: user.areaId,
        district_id: user.districtId,
      },
    }),
  ).then((r) => r.formData ?? null);

// Xonadondagi a'zolar ro'yxati.
//
// DIQQAT: platformada xonadonlar IKKI xil so'rovnoma versiyasida:
//   - yangi (v5):  pa_survey_family + survey_v3_family/{id}
//   - eski:        survey_homes_family + survey_homes_family/{id}
// Bir xonadon faqat bittasida bo'ladi. Shuning uchun avval yangisi
// so'raladi, bo'sh bo'lsa eskisiga o'tiladi. Qaytgan `source` detal
// qaysi endpointdan olinishini belgilaydi.
const fetchFamilyList = async (user, streetId, surveyUuid) => {
  const params = {
    obl_id: user.oblId,
    area_id: user.areaId,
    district_id: user.districtId,
    street_id: streetId,
    survey_uuid: surveyUuid,
  };

  const fresh = await limited(user.uid, () =>
    api.get("/web/v1/tables/pa_survey_family/data", { params }),
  ).then((r) => r.data?.results ?? []);

  if (fresh.length) return { source: "v5", members: fresh };

  const legacy = await limited(user.uid, () =>
    api.get("/web/v1/tables/survey_homes_family/data", { params }),
  ).then((r) => r.data?.results ?? []);

  return { source: "legacy", members: legacy };
};

// Bitta a'zo detali — relationship kodi, hujjat, family_num.
// Endpoint ro'yxat manbasiga qarab tanlanadi.
const fetchMemberDetail = (user, source, memberId, streetId, surveyUuid) => {
  const path =
    source === "legacy"
      ? `/web/v1/forms/survey_homes_family/${memberId}`
      : `/web/v1/forms/survey_v3_family/${memberId}`;

  return limited(user.uid, () =>
    api.get(path, {
      params: {
        _target: "modal",
        obl_id: user.oblId,
        area_id: user.areaId,
        district_id: user.districtId,
        street_id: streetId,
        // Eski endpoint `survey_uuid`, yangisi `uuid` kutadi —
        // ikkalasini ham yuboramiz, ortiqchasi e'tiborsiz qoladi.
        uuid: surveyUuid,
        survey_uuid: surveyUuid,
      },
    }),
  ).then((r) => r.formData ?? null);
};

// "хонадон эгаси" — kodli emas, alohida rol.
const isOwnerRelationship = (text) =>
  /хонадон\s+эгаси|xonadon\s+egasi/i.test(String(text ?? ""));

/**
 * Asosiy ish — fonda ketadi.
 */
const runScan = async (user) => {
  stopFlags.delete(user.uid);
  setScan(user.uid, {
    status: "running",
    stage: "Ko'chalar yuklanmoqda",
    error: null,
  });

  const streets = await fetchStreets(user);

  if (!streets.length) {
    throw new Error(
      "Platforma bu token uchun ko'cha qaytarmadi — token yaroqli ekanini tekshiring",
    );
  }

  setScan(user.uid, { streetsTotal: streets.length });

  // Avval barcha xonadonlarni yig'amiz (son aniq ko'rinsin).
  const homes = [];

  for (const [index, street] of streets.entries()) {
    if (stopFlags.has(user.uid)) {
      setScan(user.uid, { status: "stopped", stage: "To'xtatildi" });
      return;
    }

    setScan(user.uid, {
      stage: `Ko'chalar: ${index + 1}/${streets.length} — ${street.name}`,
    });

    let streetHomes = [];
    try {
      streetHomes = await fetchStreetHomes(user, String(street.id));
    } catch {
      // Bitta ko'cha yuklanmasa, qolganlari davom etadi.
      continue;
    }

    for (const home of streetHomes) {
      homes.push({
        homeId: String(home.id),
        streetId: String(street.id),
        streetName: street.name,
        homeNum: home.home_num,
        cadasterNumber: home.cadaster_number ?? null,
        // Egasi — a'zolar ro'yxatida (ayniqsa yangi v5 da) bo'lmaydi,
        // shuning uchun xonadon ro'yxatidan olinadi.
        ownerFullName: home.full_name ?? null,
        ownerPinfl: home.pinfl != null ? String(home.pinfl) : null,
        ownerPhone: home.mobile_phone ?? null,
      });
    }
  }

  setScan(user.uid, { homesTotal: homes.length, homesDone: 0 });

  // Endi har xonadon: survey_uuid -> a'zolar ro'yxati -> har a'zo detali.
  let membersFound = 0;
  let membersSaved = 0;

  for (const [index, home] of homes.entries()) {
    if (stopFlags.has(user.uid)) {
      setScan(user.uid, {
        status: "stopped",
        stage: "To'xtatildi",
        homesDone: index,
        membersFound,
        membersSaved,
      });
      return;
    }

    setScan(user.uid, {
      stage: `Xonadon ${index + 1}/${homes.length} — ${home.cadasterNumber ?? home.homeId}`,
      homesDone: index,
    });

    let form = null;
    try {
      form = await fetchHomeForm(user, home.homeId);
    } catch {
      continue;
    }

    const surveyUuid = form?.survey_uuid ?? form?.uuid ?? null;
    if (!surveyUuid) continue;

    // Egasi ma'lumoti. Asosiy manba — XONADON RO'YXATI (`home.owner*`):
    // u har xonadon uchun bir so'rovda keladi va so'rovnoma
    // versiyasiga bog'liq emas. `survey_homes` formasi v5
    // xonadonlarda egani bo'sh beradi, `pa_survey_v5` esa boshqa
    // id talab qiladi — shuning uchun ularga tayanmaymiz. Forma
    // qiymati faqat ro'yxatda "- " joy to'ldirgich bo'lsa ishga
    // tushadi.
    const clean = (value) => {
      const text = String(value ?? "").trim();
      return text && text !== "-" ? text : null;
    };
    const ownerFullName =
      clean(home.ownerFullName) ?? clean(form?.full_name);
    const ownerPinfl = clean(home.ownerPinfl) ?? clean(form?.pinfl);
    const ownerPhone = clean(home.ownerPhone) ?? clean(form?.mobile_phone);

    let list = [];
    let source = "v5";
    try {
      const result = await fetchFamilyList(user, home.streetId, surveyUuid);
      list = result.members;
      source = result.source;
    } catch {
      continue;
    }

    // Egasini alohida saqlaymiz: yangi (v5) ro'yxat egasini umuman
    // qaytarmaydi, eski ro'yxat esa egasini a'zo id'si bilan emas,
    // xonadon id'si bilan beradi. Shuning uchun egani xonadon
    // ma'lumotidan sintez qilamiz. A'zolar ro'yxatida egasi bor
    // bo'lsa (eski variant), takror bo'lmasligi uchun o'sha qatorni
    // o'tkazamiz.
    const listHasOwner = list.some((m) => isOwnerRelationship(m.relationship));

    if (ownerPinfl || ownerFullName) {
      const ownerMemberId = `owner:${home.homeId}`;

      await FamilyMember.updateOne(
        { userUid: user.uid, memberId: ownerMemberId },
        {
          $set: {
            memberId: ownerMemberId,
            homeId: home.homeId,
            cadasterNumber: home.cadasterNumber,
            surveyUuid,
            streetId: home.streetId,
            streetName: home.streetName,
            homeNum: home.homeNum,
            fullName: ownerFullName,
            relationship: "хонадон эгаси",
            relationshipCode: null,
            isOwner: true,
            birthDate: clean(form?.birth_date),
            pinfl: ownerPinfl,
            phone: ownerPhone,
            userUid: user.uid,
          },
        },
        { upsert: true },
      );

      membersFound += 1;
      membersSaved += 1;
      setScan(user.uid, { membersFound, membersSaved });
    }

    // Ro'yxatdan egani (eski variantda bo'lsa) chiqarib tashlaymiz —
    // yuqorida allaqachon saqladik.
    const realMembers = listHasOwner
      ? list.filter((m) => !isOwnerRelationship(m.relationship))
      : list;

    membersFound += realMembers.length;
    setScan(user.uid, { membersFound });

    for (const member of realMembers) {
      if (stopFlags.has(user.uid)) break;

      const memberId = String(member.id);

      // Detal (relationship kodi, hujjat). Xato bo'lsa ham ro'yxat
      // ma'lumoti bilan saqlaymiz — a'zo yo'qolib ketmasin. Egalar
      // bu bosqichga yetmaydi: ular yuqorida alohida saqlanib,
      // ro'yxatdan chiqarilgan.
      let detail = null;
      try {
        detail = await fetchMemberDetail(
          user,
          source,
          memberId,
          home.streetId,
          surveyUuid,
        );
      } catch {
        detail = null;
      }

      const doc = {
        memberId,
        homeId: home.homeId,
        cadasterNumber: home.cadasterNumber,
        surveyUuid,
        streetId: home.streetId,
        streetName: home.streetName,
        homeNum: home.homeNum,
        fullName: detail?.full_name ?? member.full_name ?? null,
        relationship: member.relationship ?? null,
        relationshipCode:
          detail?.relationship != null ? Number(detail.relationship) : null,
        isOwner: false,
        birthDate: member.birth_date ?? detail?.birth_date ?? null,
        pinfl:
          member.pinfl != null
            ? String(member.pinfl)
            : detail?.pinfl != null
              ? String(detail.pinfl)
              : null,
        phone: member.phone ?? detail?.phone ?? null,
        docSerial: detail?.doc_serial || null,
        docNumber: detail?.doc_number || null,
        documentType:
          detail?.document_type != null ? Number(detail.document_type) : null,
        familyNum: detail?.family_num != null ? Number(detail.family_num) : null,
        detailsSyncedAt: detail ? new Date() : null,
        rawDetail: detail ?? null,
        userUid: user.uid,
      };

      await FamilyMember.updateOne(
        { userUid: user.uid, memberId },
        { $set: doc },
        { upsert: true },
      );

      membersSaved += 1;
      setScan(user.uid, { membersSaved });
    }
  }

  setScan(user.uid, {
    status: "done",
    stage: null,
    homesDone: homes.length,
    membersFound,
    membersSaved,
  });
};

// --- HTTP ---

/**
 * POST /api/home-members/scan — yuklashni boshlaydi (fonda).
 */
export const startHomeMembersScan = async (req, res) => {
  const user = getRequestUser();
  if (!user) return res.status(401).json({ message: "Access key noto'g'ri" });

  if (scanState(user.uid).status === "running") {
    return res.status(200).json({ message: "Yuklash allaqachon ketmoqda" });
  }

  runScan(user).catch((err) => {
    setScan(user.uid, {
      status: "error",
      stage: null,
      error: err?.message || "Yuklashda xatolik",
    });
  });

  return res.status(202).json({ message: "Yuklash boshlandi" });
};

/**
 * POST /api/home-members/scan/stop — to'xtatadi (yozilgani qoladi).
 */
export const stopHomeMembersScan = async (req, res) => {
  const user = getRequestUser();
  if (!user) return res.status(401).json({ message: "Access key noto'g'ri" });

  if (scanState(user.uid).status === "running") {
    stopFlags.add(user.uid);
    return res.status(200).json({ message: "To'xtatilmoqda" });
  }

  return res.status(200).json({ message: "Jarayon ketayotgani yo'q" });
};

/**
 * GET /api/home-members/scan/status
 */
export const getHomeMembersScanStatus = async (req, res) => {
  const user = getRequestUser();
  if (!user) return res.status(401).json({ message: "Access key noto'g'ri" });

  const state = scanState(user.uid);
  const stored = await FamilyMember.countDocuments({ userUid: user.uid });

  return res.status(200).json({
    ...state,
    stored,
    rateLimit: getRateLimitState(`home-members:${user.uid}`),
  });
};

/**
 * GET /api/home-members — saqlangan a'zolarni sahifalab beradi.
 */
export const getHomeMembers = async (req, res) => {
  const user = getRequestUser();
  if (!user) return res.status(401).json({ message: "Access key noto'g'ri" });

  const page = Math.max(1, Number(req.query.page) || 1);
  const size = Math.min(100, Math.max(1, Number(req.query.size) || 50));
  const search = String(req.query.search ?? "").trim();

  const filter = { userUid: user.uid };

  if (search) {
    // Kirill/lotin FIO, JSHSHIR yoki kadastr bo'yicha.
    const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [
      { fullName: rx },
      { pinfl: rx },
      { cadasterNumber: rx },
    ];
  }

  const [total, items] = await Promise.all([
    FamilyMember.countDocuments(filter),
    FamilyMember.find(filter)
      .sort({ cadasterNumber: 1, _id: 1 })
      .skip((page - 1) * size)
      .limit(size)
      .lean(),
  ]);

  return res.status(200).json({
    items,
    page,
    total,
    totalPages: Math.max(1, Math.ceil(total / size)),
  });
};

// Qarindoshlik kodini odam tiliga (hisobot va Excel uchun).
const RELATIONSHIP_LABELS = {
  1: "Otasi",
  2: "Onasi",
  3: "Opasi",
  4: "Akasi",
  5: "Singlisi",
  6: "Ukasi",
  7: "Turmush o'rtog'i",
  8: "Qizi",
  9: "O'g'li",
  10: "Qaynotasi",
  11: "Qaynonasi",
  12: "Kelini",
  13: "Boshqa",
  14: "Kuyovi",
  15: "Nabira",
};

const DOCUMENT_TYPE_LABELS = { 1: "Pasport / ID-karta", 2: "Guvohnoma" };

/**
 * GET /api/home-members/export — barcha a'zolarni Excel qilib beradi.
 */
export const exportHomeMembers = async (req, res) => {
  const user = getRequestUser();
  if (!user) return res.status(401).json({ message: "Access key noto'g'ri" });

  const rows = await FamilyMember.find({ userUid: user.uid })
    .sort({ cadasterNumber: 1, homeId: 1, _id: 1 })
    .lean();

  const data = rows.map((m, index) => ({
    "№": index + 1,
    Kadastr: m.cadasterNumber ?? "",
    "Ko'cha": m.streetName ?? "",
    "Uy №": m.homeNum ?? "",
    "F.I.Sh.": m.fullName ?? "",
    JSHSHIR: m.pinfl ?? "",
    "Tug'ilgan sana": m.birthDate ?? "",
    Qarindoshlik:
      m.relationship ??
      (m.relationshipCode != null
        ? (RELATIONSHIP_LABELS[m.relationshipCode] ?? "")
        : ""),
    "Qarindoshlik kodi": m.relationshipCode ?? "",
    "Xonadon egasi": m.isOwner ? "Ha" : "",
    "Hujjat seriya": m.docSerial ?? "",
    "Hujjat raqami": m.docNumber ?? "",
    "Hujjat turi":
      m.documentType != null
        ? (DOCUMENT_TYPE_LABELS[m.documentType] ?? m.documentType)
        : "",
    Telefon: m.phone ?? "",
  }));

  const worksheet = XLSX.utils.json_to_sheet(data);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Oila a'zolari");

  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

  const fileName = `oila-azolari-${new Date().toISOString().slice(0, 10)}.xlsx`;

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);

  return res.status(200).send(buffer);
};
