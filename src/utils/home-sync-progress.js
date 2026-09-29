/**
 * Ommaviy fon-yuklash jarayonlarining progressini xotirada (in-memory)
 * saqlaydi. Har bir jarayon turi (xonadon tafsiloti, oila a'zolari, ...)
 * o'z kaliti bilan alohida kuzatiladi, shuning uchun ikkalasi bir vaqtda
 * ishlasa bir-birini bosib qo'ymaydi. Kalit odatda `${kind}:${userUid}`
 * shaklida tuziladi. Yuklash background'da davom etadi, client esa
 * progress holatini polling orqali so'rab turadi.
 */
const progressByKey = new Map();

export const startSync = (key, total) => {
  progressByKey.set(key, {
    status: "running",
    total,
    done: 0,
    failed: 0,
    errors: [],
    // Rate-limit (429) tufayli kutayotgan bo'lsa, shu vaqtgacha (ms,
    // Date.now() bilan solishtiriladigan) kutish davom etadi. Bo'sh
    // bo'lsa hozircha kutish yo'q — jarayon oddiy davom etmoqda.
    waitingUntil: null,
    startedAt: Date.now(),
    finishedAt: null,
  });
};

export const tickSync = (key, { failed = false, error = null } = {}) => {
  const progress = progressByKey.get(key);
  if (!progress) return;

  progress.done += 1;
  progress.waitingUntil = null;
  if (failed) {
    progress.failed += 1;
    if (error) progress.errors.push(error);
  }
};

// Rate-limitga uchrab kutish boshlanganda/tugaganda progressni
// yangilaydi — client "N soniya kutilmoqda" deb ko'rsatishi uchun.
export const setSyncWaiting = (key, untilTimestampMs) => {
  const progress = progressByKey.get(key);
  if (!progress) return;

  progress.waitingUntil = untilTimestampMs;
};

export const finishSync = (key) => {
  const progress = progressByKey.get(key);
  if (!progress) return;

  progress.status = "done";
  progress.finishedAt = Date.now();
};

export const failSync = (key, message) => {
  const progress = progressByKey.get(key);
  if (!progress) return;

  progress.status = "error";
  progress.error = message;
  progress.finishedAt = Date.now();
};

export const getSyncProgress = (key) => progressByKey.get(key) ?? null;

export const isSyncRunning = (key) => progressByKey.get(key)?.status === "running";
