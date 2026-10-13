import RegistrationRun from "../models/RegistrationRun.js";
import RegistrationHome from "../models/RegistrationHome.js";
import RegistrationMember from "../models/RegistrationMember.js";
import { getRequestUser } from "../utils/request-context.js";
import { getRateLimitState } from "../utils/rate-limit.js";
import { REASON_LABELS } from "../utils/registration-codes.js";
import { isRunActiveAnywhere } from "../services/registration-worker.js";
import { collectStats } from "./dashboard.controller.js";

/**
 * Asosiy sahifaning jonli oqimi (SSE — Server-Sent Events).
 *
 * Nega WebSocket emas: ma'lumot FAQAT serverdan clientga oqadi
 * (holat, ko'rsatkichlar, yangi qatorlar). SSE aynan shunga
 * mo'ljallangan, Express'da qo'shimcha kutubxonasiz ishlaydi.
 * Boshqaruv (boshlash/to'xtatish) oddiy POST orqali ketadi.
 *
 * Nega polling emas: jarayon soatlab ketadi va har sekundda to'liq
 * holat so'ralsa bekorga yuk tushadi. SSE'da bitta ulanish ochiq
 * turadi va faqat O'ZGARISH yuboriladi.
 *
 * Oqim foydalanuvchining O'Z `uid` i bo'yicha filtrlanadi: bir
 * nechta xodim turli tokenlar bilan ishlasa, har biri faqat o'z
 * jarayonini ko'radi.
 */

// Holat necha millisekundda tekshiriladi.
const TICK_MS = 1000;

// Proxy'lar bo'sh ulanishni yopib qo'ymasligi uchun.
const PING_MS = 25000;

// Jonli ro'yxatda nechta qator uzatiladi.
const FEED_LIMIT = 40;

export const streamDashboard = async (req, res) => {
  const user = getRequestUser();
  if (!user) return res.status(401).json({ message: "Access key noto'g'ri" });

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

  const collect = async () => {
    const run = await RegistrationRun.findOne({ userUid: user.uid })
      .sort({ createdAt: -1 })
      .lean();

    if (!run) return { run: null, stats: null, members: [], currentHome: null };

    // Ko'rsatkichlar panel endpointi bilan BIR XIL funksiyadan
    // olinadi. Ilgari mantiq ikki joyda takrorlanardi va shuning
    // uchun ular bir-biridan ajralib ketgan edi.
    const [stats, members, currentHome] = await Promise.all([
      collectStats(run, user.uid),
      RegistrationMember.find({
        userUid: user.uid,
        // "pending" — hali urinilmagan, natijasi yo'q.
        status: { $ne: "pending" },
      })
        .sort({ createdAt: -1 })
        .limit(FEED_LIMIT)
        .select(
          "fullName verifiedFullName pinfl verifiedPinfl status reason reasonCode durationMs createdAt",
        )
        .lean(),
      RegistrationHome.findOne({ runId: run._id, status: "processing" })
        .sort({ queueIndex: 1 })
        .lean(),
    ]);

    const isActive = isRunActiveAnywhere(run);

    return {
      run: {
        id: String(run._id),
        status: run.status,
        stage: run.stage ?? null,
        isActive,
        isStale: run.status === "running" && !isActive,
        waitingUntil: run.waitingUntil ?? null,
        error: run.error ?? null,
        randomMode: run.randomMode ?? false,
        randomTarget: run.randomTarget ?? 0,
        randomAdded: run.randomAdded ?? 0,
      },
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
      members: members.map((member) => ({
        id: String(member._id),
        fullName: member.verifiedFullName ?? member.fullName ?? "—",
        pinfl: member.verifiedPinfl ?? member.pinfl ?? null,
        status: member.status,
        reason: member.reason ?? null,
        reasonLabel: member.reasonCode
          ? (REASON_LABELS[member.reasonCode] ?? member.reasonCode)
          : null,
        durationMs: member.durationMs ?? null,
        at: member.createdAt,
      })),
      rateLimit: getRateLimitState(`registration:${user.uid}`),
    };
  };

  const tick = async () => {
    if (closed) return;

    try {
      const payload = await collect();
      const snapshot = JSON.stringify(payload);

      // O'zgarmagan bo'lsa yubormaymiz.
      if (snapshot !== previous) {
        previous = snapshot;
        res.write(`event: state\ndata: ${snapshot}\n\n`);
      }
    } catch {
      // Bitta xato oqimni yopmasligi kerak — keyingi tsiklda qayta
      // urinadi.
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
