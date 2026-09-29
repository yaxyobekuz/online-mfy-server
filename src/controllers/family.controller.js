import api from "../config/api.js";
import Home from "../models/Home.js";
import FamilyMember from "../models/FamilyMember.js";
import { getRequestUser } from "../utils/request-context.js";
import { withRateLimit } from "../utils/rate-limit.js";
import {
  startSync,
  tickSync,
  finishSync,
  failSync,
  getSyncProgress,
  isSyncRunning,
} from "../utils/home-sync-progress.js";

const familySyncKey = (userUid) => `family:${userUid}`;

// Bitta xonadonning survey_uuid'i bo'yicha tashqi API'dan oila
// a'zolari ro'yxatini olib qaytaradi (DB'ga yozmasdan).
const fetchFamilyMembers = (user, streetId, surveyUuid) =>
  withRateLimit(() =>
    api.get("/web/v1/tables/survey_homes_family/data", {
      params: {
        obl_id: user.oblId,
        area_id: user.areaId,
        district_id: user.districtId,
        street_id: streetId,
        survey_uuid: surveyUuid,
      },
    }),
  ).then((response) => response.data.results);

const mapFamilyMember = (member, homeId, userUid) => ({
  memberId: String(member.id),
  homeId,
  fullName: member.full_name,
  relationship: member.relationship,
  birthDate: member.birth_date,
  pinfl: member.pinfl != null ? String(member.pinfl) : null,
  phone: member.phone,
  userUid,
});

// Berilgan xonadon uchun survey_uuid'ni ta'minlaydi: agar hali
// yuklanmagan bo'lsa, xonadon tafsilotini (formData) yuklab, undan
// survey_uuid'ni oladi va DB'ga saqlaydi.
const ensureSurveyUuid = async (user, home) => {
  if (home.surveyUuid) return home.surveyUuid;

  const response = await withRateLimit(() =>
    api.get(`/web/v1/forms/survey_homes/${home.homeId}`, {
      params: {
        obl_id: user.oblId,
        area_id: user.areaId,
        district_id: user.districtId,
      },
    }),
  );

  const surveyUuid = response.formData?.survey_uuid;
  if (surveyUuid) {
    home.surveyUuid = surveyUuid;
    await home.save();
  }

  return surveyUuid;
};

// Berilgan xonadon uchun oila a'zolarini tashqi API'dan olib, DB'ga
// sinxronlaydi (eskilarini o'chirib, yangilarini kiritadi).
const syncHomeFamily = async (user, home) => {
  const surveyUuid = await ensureSurveyUuid(user, home);
  if (!surveyUuid) {
    throw new Error(
      "Xonadonning survey_uuid'i topilmadi (tafsilot yuklanmagan bo'lishi mumkin)",
    );
  }

  const results = await fetchFamilyMembers(user, home.streetId, surveyUuid);

  await FamilyMember.deleteMany({ userUid: user.uid, homeId: home.homeId });

  return results.length
    ? FamilyMember.insertMany(
        results.map((member) => mapFamilyMember(member, home.homeId, user.uid)),
      )
    : [];
};

// Bitta xonadonning DB'da saqlangan oila a'zolarini qaytaradi. Agar
// hali umuman sinxronlanmagan bo'lsa (xonadon uchun bironta ham
// FamilyMember yozuvi yo'q va tafsilot yuklanmagan), lazy-load qilib
// tashqi API'dan olib keshlaydi.
export const getHomeFamily = async (req, res) => {
  const user = getRequestUser();
  if (!user) return res.status(401).json({ message: "Access key noto'g'ri" });

  const { homeId } = req.params;

  try {
    const home = await Home.findOne({ userUid: user.uid, homeId });
    if (!home) return res.status(404).json({ message: "Xonadon topilmadi" });

    const existing = await FamilyMember.find({ userUid: user.uid, homeId });
    if (existing.length || home.familySyncedAt) {
      return res.status(200).json(existing);
    }

    const members = await syncHomeFamily(user, home);
    home.familySyncedAt = new Date();
    await home.save();

    return res.status(200).json(members);
  } catch (err) {
    const status = err.response?.status || 500;
    const message = err.response?.data?.message || err.message || "Server xatoligi";

    return res.status(status).json({ message });
  }
};

// Berilgan xonadonning oila a'zolarini background'da (progress bilan)
// tashqi API'dan qayta yuklaydi — "Xonadon tafsilotini yuklash" bilan
// bir xil pattern, lekin bitta xonadon uchun.
export const syncFamilyForHome = async (req, res) => {
  const user = getRequestUser();
  if (!user) return res.status(401).json({ message: "Access key noto'g'ri" });

  const key = familySyncKey(user.uid);
  if (isSyncRunning(key)) {
    return res.status(409).json({ message: "Yuklash allaqachon ketmoqda" });
  }

  const { homeId } = req.params;

  try {
    const home = await Home.findOne({ userUid: user.uid, homeId });
    if (!home) return res.status(404).json({ message: "Xonadon topilmadi" });

    startSync(key, 1);

    try {
      const members = await syncHomeFamily(user, home);
      home.familySyncedAt = new Date();
      await home.save();
      tickSync(key);
      finishSync(key);

      return res.status(200).json(members);
    } catch (err) {
      const reason = err.response?.data?.message || err.message || "Noma'lum xatolik";
      tickSync(key, {
        failed: true,
        error: { homeId, fullName: home.fullName, reason },
      });
      finishSync(key);

      return res.status(500).json({ message: reason });
    }
  } catch (err) {
    failSync(key, err.message);
    return res.status(500).json({ message: "Server xatoligi" });
  }
};

// Oila a'zolarini ommaviy yuklashning joriy progressini qaytaradi.
export const getFamilySyncStatus = async (req, res) => {
  const user = getRequestUser();
  if (!user) return res.status(401).json({ message: "Access key noto'g'ri" });

  const progress = getSyncProgress(familySyncKey(user.uid));
  if (!progress) {
    return res.status(200).json({ status: "idle" });
  }

  return res.status(200).json(progress);
};
