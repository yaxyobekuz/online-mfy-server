import { requestContext } from "../utils/request-context.js";
import { verifySession } from "../utils/session.js";
import MfyToken from "../models/MfyToken.js";
import User from "../models/User.js";

/**
 * Ikki bosqichli kirish:
 *
 *   1. SERVER sessiyasi — `Authorization: Bearer <sessiya>`. Bu
 *      serverga kirish huquqi (bitta parol orqali olingan). Yo'q yoki
 *      yaroqsiz bo'lsa — 401, boshqa hech narsa ko'rinmaydi.
 *
 *   2. QAYSI MFY — `X-Mahalla-Uid: <uid>`. Server shu uid bo'yicha
 *      saqlangan MFY tokenini topib, request-context'ga qo'yadi.
 *      Platforma so'rovlari o'sha token bilan ketadi (api.js
 *      interceptor `getRequestToken()` dan oladi).
 *
 * Token endi brauzerda EMAS, serverda: client faqat qaysi mahalla
 * ekanini aytadi.
 */

// Sessiya talab qilinmaydigan yo'llar (kirishning o'zi).
const PUBLIC_PATHS = new Set(["/api/auth/login", "/api/health"]);

export const authContext = async (req, res, next) => {
  // Ochiq yo'llar — tekshiruvsiz o'tadi.
  if (PUBLIC_PATHS.has(req.path)) {
    return requestContext.run({}, () => next());
  }

  // 1. Server sessiyasi.
  const authHeader = req.headers.authorization || "";
  const [, session] = authHeader.split(" ");

  if (!verifySession(session)) {
    return res.status(401).json({ message: "Sessiya yaroqsiz — qayta kiring" });
  }

  // 2. Qaysi MFY (ixtiyoriy: token qo'shish kabi amallarda bo'lmasligi
  //    mumkin). Topilsa, o'sha MFY tokeni va foydalanuvchisi
  //    kontekstga qo'yiladi.
  const uid = req.headers["x-mahalla-uid"] || req.query.mahalla || null;

  const store = { session: true, token: undefined, user: undefined, mahallaUid: uid };

  if (uid) {
    try {
      const mfy = await MfyToken.findOne({ uid }).select("+token").lean();

      if (mfy) {
        store.token = mfy.token;
        store.mahallaStatus = mfy.status;
        // Foydalanuvchi ma'lumoti (hudud) — User kolleksiyasidan.
        store.user = await User.findOne({ uid }).lean();
      }
    } catch {
      // Token topilmasa, store.token undefined qoladi — himoyalangan
      // amal buni o'zi tekshiradi.
    }
  }

  return requestContext.run(store, () => next());
};
