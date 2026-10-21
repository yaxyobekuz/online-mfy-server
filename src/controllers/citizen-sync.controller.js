import Citizen from "../models/Citizen.js";
import { getRequestUser } from "../utils/request-context.js";
import { withRateLimit } from "../utils/rate-limit.js";
import {
  startSync,
  tickSync,
  finishSync,
  failSync,
  getSyncProgress,
  isSyncRunning,
  setSyncWaiting,
} from "../utils/home-sync-progress.js";
import { toIsoDate, isExpiredDocument } from "../utils/person-data.js";
import {
  fetchGcpData,
  fetchBirthCertData,
  mapGcpUpdate,
  mapBirthCertUpdate,
  documentParts,
  needsBirthCert,
  isDeceased,
  isNetworkError,
  pause,
} from "../utils/person-refresh.js";
import { extractMahallaName, mahallaKey } from "../utils/mahalla.js";

// Fuqarolar bazasi global, lekin jarayonni kim boshlaganini
// ajratib turish uchun kalit foydalanuvchi bo'yicha beriladi —
// shunda ikki xodim bir vaqtda boshlasa progress aralashmaydi.
const citizenSyncKey = (userUid) => `citizenSync:${userUid}`;

// Bir yurishda nechta yozuv olinadi. Tashqi API sekundiga bir nechta
// so'rovga ruxsat beradi, 150 mingni bir yurishda yangilab bo'lmaydi —
// shuning uchun bo'laklab ishlanadi.
const MAX_BATCH = 2000;

const logWait = (progressKey, label) => (until) => {
  setSyncWaiting(progressKey, until);
  if (!until) return;

  const seconds = Math.ceil((until - Date.now()) / 1000);
  if (seconds >= 3) {
    console.log(`[${label}] rate limitga yetildi, ${seconds} soniya kutilmoqda...`);
  }
};

// Davlat bazasi so'rovlari uchun rate-limit wrapper'i. person-refresh
// util'i `rateLimit(fn)` ni parametr sifatida kutadi — shu yerda uni
// sync'ning progress/kutish hisoblagichiga ulaymiz.
const makeRateLimit = (progressKey) => (fn) =>
  withRateLimit(fn, {
    delayMs: 150,
    adaptiveKey: progressKey,
    onWait: progressKey ? logWait(progressKey, "Fuqarolar sync") : undefined,
  });

/**
 * Berilgan yozuvlarni ketma-ket yangilaydi. Bitta yozuv xato bersa
 * ham qolganlari davom etadi — butun jarayon to'xtamasin.
 */
const syncCitizens = async (user, citizens) => {
  const key = citizenSyncKey(user.uid);
  const rateLimit = makeRateLimit(key);
  const total = citizens.length;
  startSync(key, total);

  console.log(`[Fuqarolar sync] boshlandi: ${total} ta yozuv`);

  try {
    for (const [index, citizen] of citizens.entries()) {
      const position = index + 1;
      const startedAt = Date.now();

      try {
        const isoBirthDate = toIsoDate(citizen.birthDate);
        if (!isoBirthDate) {
          throw new Error("Tug'ilgan sana noto'g'ri/yo'q");
        }

        let pinfl = citizen.pinfl;
        let viaBirthCert = false;

        // 1-bosqich: JSHSHIR yo'q bo'lsa, guvohnoma bazasidan
        // qidiramiz — u JSHSHIR va ota-ona ma'lumotini qaytaradi.
        if (needsBirthCert(citizen)) {
          const { series, number } = documentParts(citizen);
          const certResponse = await fetchBirthCertData(
            series,
            number,
            isoBirthDate,
            rateLimit,
          );

          const certUpdate = mapBirthCertUpdate(certResponse);
          if (!certUpdate) {
            throw new Error(
              certResponse?.message || "Guvohnoma bo'yicha ma'lumot topilmadi",
            );
          }

          await Citizen.updateOne({ _id: citizen._id }, { $set: certUpdate });
          pinfl = certUpdate.pinfl ?? null;
          viaBirthCert = true;
        }

        if (!pinfl) {
          if (viaBirthCert) {
            // Guvohnoma topildi, lekin JSHSHIR hali berilmagan —
            // bu xato emas, GCP bosqichi o'tkazib yuboriladi.
            tickSync(key);
            console.log(
              `[Fuqarolar sync] ${position}/${total} — OK guvohnoma, JSHSHIR yo'q (${citizen.fullName}) ${Date.now() - startedAt}ms`,
            );
            continue;
          }
          // Pasporti bor, lekin JSHSHIR yo'q: GCP faqat JSHSHIR
          // bo'yicha qidiradi, FHDYO esa faqat guvohnomani biladi —
          // ya'ni bu yozuvni hech qaysi baza orqali topib bo'lmaydi.
          // Excel yangilanmaguncha javob o'zgarmaydi, shuning uchun
          // belgilab qo'yamiz va boshqa so'ramaymiz.
          const reason = citizen.document
            ? `JSHSHIR yo'q, hujjati esa guvohnoma emas (${citizen.document}) — qidirib bo'lmaydi`
            : "JSHSHIR ham, tug'ilganlik guvohnomasi ham yo'q";

          await Citizen.updateOne(
            { _id: citizen._id },
            { $set: { documentExpired: true, documentExpiredAt: new Date() } },
          );

          tickSync(key, {
            failed: true,
            error: {
              recordId: String(citizen._id),
              fullName: citizen.fullName,
              reason,
            },
          });
          console.log(
            `[Fuqarolar sync] ${position}/${total} — QIDIRIB BO'LMAYDI (${citizen.fullName}) ${Date.now() - startedAt}ms`,
          );
          continue;
        }

        // 2-bosqich: JSHSHIR ma'lum — pasport bazasidan so'raymiz.
        const gcpData = await fetchGcpData(pinfl, isoBirthDate, rateLimit);

        if (!gcpData || gcpData.code !== 0) {
          if (viaBirthCert) {
            // Bola hali pasport olmagan — guvohnoma yetarli.
            tickSync(key);
            console.log(
              `[Fuqarolar sync] ${position}/${total} — OK guvohnoma (pasport hali yo'q) (${citizen.fullName}) ${Date.now() - startedAt}ms`,
            );
            continue;
          }

          // Vafot etgan shaxs — javob hech qachon o'zgarmaydi.
          // Qayta so'ramaslik uchun "eskirgan" deb belgilaymiz.
          if (isDeceased(gcpData) || isExpiredDocument(gcpData)) {
            await Citizen.updateOne(
              { _id: citizen._id },
              {
                $set: {
                  documentExpired: true,
                  documentExpiredAt: new Date(),
                  gcpData,
                },
              },
            );

            tickSync(key);
            console.log(
              `[Fuqarolar sync] ${position}/${total} — HUJJATI ESKIRGAN (${citizen.fullName}) ${Date.now() - startedAt}ms`,
            );
            continue;
          }

          throw new Error(gcpData?.message || "GCP'da ma'lumot topilmadi");
        }

        await Citizen.updateOne(
          { _id: citizen._id },
          { $set: mapGcpUpdate(gcpData) },
        );

        tickSync(key);
        console.log(
          `[Fuqarolar sync] ${position}/${total} — OK${viaBirthCert ? " guvohnoma→pasport" : ""} (${citizen.fullName ?? pinfl}) ${Date.now() - startedAt}ms`,
        );
      } catch (err) {
        // Token eskirgan (401) — bu yozuvning emas, butun jarayonning
        // muammosi: token eskirgach qolgan HAMMA yozuv ham 401 beradi va
        // bekorga "xato" bo'lib qolardi. Shuning uchun zanjirni uzamiz:
        // yuqoriga uzatamiz, jarayon "token eskirgan" deb to'xtaydi.
        if (err.response?.status === 401) {
          throw new Error(
            "Platforma tokeni eskirgan — yangilang va qaytadan boshlang",
          );
        }

        // Tarmoq uzilgan bo'lsa — yozuvning aybi yo'q, aloqa
        // tiklanishini kutamiz. Uzilish bir necha soniya davom etsa,
        // aks holda o'nlab yozuv bekorga "xato" bo'lib qolardi.
        if (isNetworkError(err)) {
          console.log(
            `[Fuqarolar sync] ${position}/${total} — tarmoq uzildi (${err.code}), 15 soniya kutilmoqda...`,
          );
          setSyncWaiting(key, Date.now() + 15000);
          await pause(15000);
          setSyncWaiting(key, null);
        }

        const reason =
          err.response?.data?.message || err.message || "Noma'lum xatolik";

        console.log(
          `[Fuqarolar sync] ${position}/${total} — XATO (${citizen.fullName ?? citizen.pinfl}): ${reason} ${Date.now() - startedAt}ms`,
        );

        tickSync(key, {
          failed: true,
          error: {
            recordId: String(citizen._id),
            fullName: citizen.fullName,
            pinfl: citizen.pinfl,
            reason,
          },
        });
      }
    }

    const failed = getSyncProgress(key)?.failed ?? 0;
    console.log(
      `[Fuqarolar sync] tugadi: ${total} tadan ${total - failed} tasi muvaffaqiyatli`,
    );
    finishSync(key);
  } catch (err) {
    failSync(key, err.message);
  }
};

/**
 * Yangilashni background'da boshlaydi.
 *
 * Query parametrlari:
 *   onlyMissing=true  — hali hech qaysi manbadan yangilanmaganlar
 *   mahalla=<key>     — faqat shu mahalla fuqarolari
 *   limit=<n>         — bir yurishda nechta (standart 2000)
 */
export const startCitizenSync = async (req, res) => {
  const user = getRequestUser();
  if (!user) return res.status(401).json({ message: "Access key noto'g'ri" });

  const key = citizenSyncKey(user.uid);
  if (isSyncRunning(key)) {
    return res.status(409).json({ message: "Yuklash allaqachon ketmoqda" });
  }

  try {
    // Hujjati eskirganlarga qayta so'rov yubormaymiz.
    const filter = { documentExpired: { $ne: true } };

    if (req.query.onlyMissing === "true") {
      filter.gcpSyncedAt = null;
      filter.birthCertSyncedAt = null;
    }

    const limit = Math.min(
      Number.parseInt(req.query.limit, 10) || MAX_BATCH,
      MAX_BATCH,
    );

    // Mahalla bo'yicha cheklov. Manzil erkin matn bo'lgani uchun
    // uni so'rov ichida filtrlab bo'lmaydi — avval mos manzillar
    // ro'yxatini aniqlab, keyin shular bo'yicha so'raymiz. (Yozuvlarni
    // olib, keyin ajratish ishlamaydi: bitta mahalla yozuvlari
    // faylning o'rtasida bo'lishi mumkin va limitga tushmay qoladi.)
    if (req.query.mahalla) {
      const wanted = String(req.query.mahalla);
      const addresses = await Citizen.distinct("address");
      const matched = addresses.filter((address) => {
        const name = extractMahallaName(address);
        return name ? mahallaKey(name) === wanted : false;
      });

      if (!matched.length) {
        return res.status(404).json({ message: "Mahalla topilmadi" });
      }

      filter.address = { $in: matched };
    }

    const citizens = await Citizen.find(filter)
      .sort({ rowNumber: 1, _id: 1 })
      .limit(limit)
      .lean();

    if (!citizens.length) {
      return res.status(200).json({ message: "Yangilanadigan yozuv yo'q" });
    }

    // Background'da ishga tushiramiz, javobni kutmaymiz.
    syncCitizens(user, citizens);

    return res.status(202).json({ total: citizens.length });
  } catch {
    return res.status(500).json({ message: "Server xatoligi" });
  }
};

/**
 * Joriy yangilash progressi.
 */
export const getCitizenSyncStatus = async (req, res) => {
  const user = getRequestUser();
  if (!user) return res.status(401).json({ message: "Access key noto'g'ri" });

  const progress = getSyncProgress(citizenSyncKey(user.uid));
  if (!progress) {
    return res.status(200).json({ status: "idle" });
  }

  return res.status(200).json(progress);
};
