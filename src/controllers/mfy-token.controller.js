import axios from "axios";
import MfyToken from "../models/MfyToken.js";
import User from "../models/User.js";
import RegistrationRun from "../models/RegistrationRun.js";
import { stopHomeMembersScanFor } from "./home-members.controller.js";

/**
 * MFY tokenlarini boshqarish — qo'shish / yangilash / o'chirish /
 * ro'yxat. Tokenlar SERVER tomonda, maxfiy saqlanadi; endpointlar
 * tokenning o'zini hech qachon qaytarmaydi.
 */

// Tokenni platformada tekshirib, MFY ma'lumotini oladi.
const verifyToken = async (token) => {
  const { data } = await axios.get(
    `${process.env.API_BASE_URL}/auth/user_info`,
    { headers: { Authorization: `Bearer ${token}` }, timeout: 20000 },
  );

  if (!data?.uid) {
    throw new Error("Token yaroqsiz — foydalanuvchi aniqlanmadi");
  }

  return data;
};

// Clientga qaytariladigan xavfsiz ko'rinish (tokensiz).
const publicView = (doc) => ({
  uid: doc.uid,
  username: doc.username ?? null,
  mahallaName: doc.mahallaName ?? null,
  status: doc.status,
  hidden: Boolean(doc.hidden),
  lastCheckedAt: doc.lastCheckedAt ?? null,
});

/**
 * GET /api/mfy-tokens — barcha MFY lar (tokensiz).
 *
 * Mahalla nomi `user_info` da yo'q (faqat username va hudud ID'lari),
 * shuning uchun u oldingi yurishdan olinadi — bo'lsa panelda chiroyli
 * nom ko'rinadi, bo'lmasa username ishlatiladi.
 */
export const listMfyTokens = async (req, res) => {
  const tokens = await MfyToken.find({}).sort({ createdAt: 1 }).lean();

  // Har MFY ning eng so'nggi yurishidagi mahalla nomi.
  const runs = await RegistrationRun.aggregate([
    { $match: { mahallaName: { $ne: null } } },
    { $sort: { createdAt: -1 } },
    { $group: { _id: "$userUid", mahallaName: { $first: "$mahallaName" } } },
  ]);
  const nameByUid = new Map(runs.map((r) => [r._id, r.mahallaName]));

  return res.status(200).json(
    tokens.map((t) => ({
      ...publicView(t),
      mahallaName: t.mahallaName ?? nameByUid.get(t.uid) ?? null,
    })),
  );
};

/**
 * POST /api/mfy-tokens  { token }
 *
 * Yangi MFY qo'shadi. Token platformada tekshiriladi; uid, mahalla
 * va hudud ID'lari o'zidan olinadi.
 */
export const addMfyToken = async (req, res) => {
  const token = String(req.body?.token ?? "").trim();
  if (!token) return res.status(400).json({ message: "Token kiritilmadi" });

  let data;
  try {
    data = await verifyToken(token);
  } catch {
    return res.status(400).json({ message: "Token yaroqsiz yoki tekshirib bo'lmadi" });
  }

  // Foydalanuvchini (hudud) ham saqlab qo'yamiz — ishchiga kerak.
  await User.findOneAndUpdate({ uid: data.uid }, data, { upsert: true });

  const doc = await MfyToken.findOneAndUpdate(
    { uid: data.uid },
    {
      $set: {
        uid: data.uid,
        username: data.username ?? null,
        mahallaName: data.district ?? data.area_name ?? null,
        token,
        status: "active",
        oblId: data.oblId ?? data.defOblId ?? null,
        areaId: data.areaId ?? data.defAreaId ?? null,
        districtId: data.districtId ?? data.defDistrictId ?? null,
        lastCheckedAt: new Date(),
      },
    },
    { upsert: true, returnDocument: "after" },
  ).lean();

  return res.status(201).json(publicView(doc));
};

/**
 * PUT /api/mfy-tokens/:uid  { token }
 *
 * Mavjud MFY tokenini yangilaydi (muddati o'tgan tokenni almashtirish).
 * Yangi token o'sha MFY ga tegishli ekani tekshiriladi.
 */
export const updateMfyToken = async (req, res) => {
  const { uid } = req.params;
  const token = String(req.body?.token ?? "").trim();
  if (!token) return res.status(400).json({ message: "Token kiritilmadi" });

  const existing = await MfyToken.findOne({ uid });
  if (!existing) {
    return res.status(404).json({ message: "Bu MFY topilmadi" });
  }

  let data;
  try {
    data = await verifyToken(token);
  } catch {
    return res.status(400).json({ message: "Token yaroqsiz yoki tekshirib bo'lmadi" });
  }

  // Yangi token boshqa MFY ga tegishli bo'lsa — rad etamiz: aks
  // holda bir MFY o'rniga butunlay boshqasi kirib qolardi.
  if (data.uid !== uid) {
    return res.status(400).json({
      message: "Bu token boshqa MFY ga tegishli — mos token kiriting",
    });
  }

  await User.findOneAndUpdate({ uid: data.uid }, data, { upsert: true });

  const doc = await MfyToken.findOneAndUpdate(
    { uid },
    {
      $set: {
        token,
        status: "active",
        username: data.username ?? existing.username,
        lastCheckedAt: new Date(),
      },
    },
    { returnDocument: "after" },
  ).lean();

  return res.status(200).json(publicView(doc));
};

/**
 * PATCH /api/mfy-tokens/:uid/visibility  { hidden }
 *
 * MFY ni panelda yashiradi yoki qayta ochadi. Bu FAQAT ko'rinish:
 * token, jarayonlar va statistika o'zgarmaydi — yashirilgan MFY
 * baribir ishlayveradi, shunchaki ro'yxatda ko'rinmaydi.
 */
export const setMfyVisibility = async (req, res) => {
  const { uid } = req.params;
  const hidden = Boolean(req.body?.hidden);

  const doc = await MfyToken.findOneAndUpdate(
    { uid },
    { $set: { hidden } },
    { returnDocument: "after" },
  ).lean();

  if (!doc) return res.status(404).json({ message: "Bu MFY topilmadi" });

  return res.status(200).json(publicView(doc));
};

/**
 * GET /api/mfy-tokens/:uid/token
 *
 * MFY ning XOM tokenini qaytaradi — panelda "nusxalash" tugmasi
 * uchun. Butun API serverning yagona paroli ortida, shuning uchun
 * faqat kirgan admin o'qiy oladi. Token boshqa joyda (ro'yxatda)
 * hech qachon qaytarilmaydi.
 */
export const getMfyTokenValue = async (req, res) => {
  const { uid } = req.params;

  const doc = await MfyToken.findOne({ uid }).select("+token").lean();
  if (!doc) return res.status(404).json({ message: "Bu MFY topilmadi" });

  return res.status(200).json({ uid: doc.uid, token: doc.token });
};

/**
 * DELETE /api/mfy-tokens/:uid
 *
 * MFY tokenini o'chiradi va shu MFY bo'yicha har qanday jarayonni
 * to'xtatadi: ro'yxatga olish yurishlari va xonadon a'zolarini
 * yuklash.
 */
export const deleteMfyToken = async (req, res) => {
  const { uid } = req.params;

  const existing = await MfyToken.findOne({ uid });
  if (!existing) {
    return res.status(404).json({ message: "Bu MFY topilmadi" });
  }

  // 1. Ro'yxatga olish yurishlarini to'xtatamiz: ishchi har qadamda
  //    `control` ni o'qiydi va "stop" ni ko'rib chiqadi.
  await RegistrationRun.updateMany(
    { userUid: uid, status: { $in: ["pending", "preparing", "running", "paused"] } },
    { $set: { control: "stop" } },
  );

  // 2. Xonadon a'zolarini yuklashni to'xtatamiz.
  stopHomeMembersScanFor(uid);

  // 3. Tokenni o'chiramiz.
  await MfyToken.deleteOne({ uid });

  return res.status(200).json({ message: "MFY o'chirildi, jarayonlari to'xtatildi" });
};
