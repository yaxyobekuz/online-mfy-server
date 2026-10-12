/**
 * Yurish jurnali (terminal ko'rinishidagi jonli log).
 *
 * Har bir qadam — so'rov, javob, xatolik — shu yerga yoziladi va
 * client polling orqali o'qib boradi. Jurnal XOTIRADA saqlanadi:
 * uning vazifasi "hozir nima bo'lyapti" ni ko'rsatish, tarix esa
 * DB'da (RegistrationMember) to'liq qoladi — hisobot shundan
 * tuziladi. Shuning uchun server qayta ishga tushsa jurnal
 * bo'shashi muammo emas.
 */

// Bitta yurish uchun nechta qator saqlanadi. Jarayon soatlab
// davom etadi, hammasini xotirada ushlab turish shart emas.
const LOG_LIMIT = 400;

const logsByRun = new Map();

export const pushRunLog = (runId, entry) => {
  const key = String(runId);

  if (!logsByRun.has(key)) logsByRun.set(key, []);

  const logs = logsByRun.get(key);
  logs.push({ ...entry, at: Date.now() });

  if (logs.length > LOG_LIMIT) logs.shift();
};

// `since` — client oxirgi olgan qatorning vaqti. Faqat yangilari
// qaytariladi, shunda har pollingda butun jurnal uzatilmaydi.
export const getRunLogs = (runId, since = 0) =>
  (logsByRun.get(String(runId)) ?? []).filter((entry) => entry.at > since);

export const clearRunLogs = (runId) => {
  logsByRun.delete(String(runId));
};
