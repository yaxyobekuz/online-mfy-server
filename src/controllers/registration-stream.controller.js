import RegistrationRun from "../models/RegistrationRun.js";
import MahallaToken from "../models/MahallaToken.js";
import { getRequestUser } from "../utils/request-context.js";
import { getRateLimitState } from "../utils/rate-limit.js";
import { isRunActive } from "../services/registration-worker.js";

/**
 * Jonli uzatish (SSE — Server-Sent Events).
 *
 * Nega WebSocket emas: bu yerda ma'lumot FAQAT serverdan clientga
 * oqadi (holat, API limiti, progress). SSE aynan shunga mo'ljallangan,
 * Express'da qo'shimcha kutubxonasiz ishlaydi va uzilganda brauzer
 * o'zi qayta ulanadi. WebSocket ikki tomonlama aloqa uchun kerak
 * bo'lardi — boshqaruv esa oddiy POST orqali ketadi.
 *
 * Nega polling emas: har sekundda to'liq holat so'ralsa, 4 ta MFY
 * parallel ishlaganda ortiqcha yuk tushadi. SSE'da bitta ulanish
 * ochiq turadi va faqat o'zgarish yuboriladi.
 */

// Har necha millisekundda holat tekshiriladi. Tashqi API limiti
// sekundlab sanalgani uchun 1 soniya yetarli.
const TICK_MS = 1000;

// Uzilib qolgan ulanishni aniqlash uchun vaqti-vaqti bilan izoh
// yuboriladi (proxy'lar bo'sh ulanishni yopib qo'yishi mumkin).
const PING_MS = 25000;

export const streamRegistrationState = async (req, res) => {
  const user = getRequestUser();
  if (!user) return res.status(401).json({ message: "Access key noto'g'ri" });

  // Ko'rinadigan MFY egalari — boshqa tokenlar yurishi ham
  // kuzatiladi.
  const tokens = await MahallaToken.find({}, "uid label").lean();
  const uids = [...new Set([user.uid, ...tokens.map((t) => t.uid)])];
  const labelByUid = new Map(tokens.map((t) => [t.uid, t.label]));

  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // Nginx kabi proxy'lar oqimni buferlab qo'ymasligi uchun.
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();

  let closed = false;
  // Oldingi holat — faqat o'zgarganda yuborish uchun.
  let previous = null;

  const send = (event, data) => {
    if (closed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const collect = async () => {
    const runs = await RegistrationRun.find({ userUid: { $in: uids } })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();

    return runs.map((run) => {
      // Har MFY o'z rate-limit oqimiga ega — kalit ishchidagi
      // bilan bir xil bo'lishi shart.
      const limit = getRateLimitState(`registration:${run.userUid}`);

      return {
        id: String(run._id),
        mahallaName: run.mahallaName,
        mahallaKey: run.mahallaKey,
        label: labelByUid.get(run.userUid) ?? run.mahallaName,
        status: run.status,
        stage: run.stage,
        homesDone: run.homesDone,
        homesTotal: run.homesTotal,
        membersAdded: run.membersAdded,
        membersFailed: run.membersFailed,
        membersSkipped: run.membersSkipped,
        isActive: isRunActive(run._id),
        // Yurishning o'z kutishi (ishchi yozadi).
        waitingUntil: run.waitingUntil ?? null,
        // Tashqi API limiti holati.
        rateLimit: limit,
      };
    });
  };

  const tick = async () => {
    if (closed) return;

    try {
      const runs = await collect();
      const snapshot = JSON.stringify(runs);

      // O'zgarmagan bo'lsa yubormaymiz — tarmoqni bekorga
      // band qilmaslik uchun.
      if (snapshot !== previous) {
        previous = snapshot;
        send("state", { runs, at: Date.now() });
      }
    } catch {
      // Bitta xato oqimni yopmasligi kerak — keyingi tsiklda
      // qayta urinadi.
    }
  };

  // Birinchi holat darhol yuboriladi — client kutmasin.
  await tick();

  const timer = setInterval(tick, TICK_MS);
  const ping = setInterval(() => {
    if (!closed) res.write(": ping\n\n");
  }, PING_MS);

  const stop = () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    clearInterval(ping);
  };

  req.on("close", stop);
  req.on("error", stop);
  res.on("error", stop);
};
