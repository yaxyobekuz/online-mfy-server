/**
 * Dublikat yurishlarni BITTAGA birlashtiradi.
 *
 * Nega kerak: "Boshlash" bosilganda tugagan yurish qidiruvga
 * kirmagani uchun har safar yangi BO'SH yurish yaratilgan edi
 * (bu xato endi tuzatilgan). Natijada bitta mahallada bir nechta
 * yurish paydo bo'lib, har birining o'z navbati va o'z yozuvlari
 * bor. Panel hisobni allaqachon hammasi bo'yicha oladi, lekin
 * baza tartibsiz qolgan — uni tozalaymiz.
 *
 * Qoida: eng ESKI yurish asosiy bo'lib qoladi (unda eng ko'p ish
 * bor), qolganlarining yozuvlari unga ko'chiriladi.
 *
 * Xonadonlar (`RegistrationHome`) kadastr bo'yicha birlashtiriladi:
 * har kadastrdan BITTA yozuv qoladi va unga eng YAXSHI holat
 * yoziladi (done > partial > failed/skipped > pending).
 *
 * A'zolar (`RegistrationMember`) hammasi saqlanadi — ular haqiqiy
 * urinishlar tarixi. Faqat `runId` va `homeRowId` asosiy yurishga
 * ko'chiriladi.
 *
 * Ishga tushirish (server papkasidan):
 *   node merge-runs.mjs           -- faqat ko'rsatadi (quruq yurish)
 *   node merge-runs.mjs --apply   -- haqiqatan o'zgartiradi
 */

import "./src/config/env.js";
import mongoose from "mongoose";
import fs from "node:fs";

const APPLY = process.argv.includes("--apply");

await mongoose.connect(process.env.MONGODB_URI);
const db = mongoose.connection.db;

const runs = db.collection("registrationruns");
const homes = db.collection("registrationhomes");
const members = db.collection("registrationmembers");

// Xonadon holatining "yaxshilik" darajasi. Bir kadastr bir necha
// yurishda turli holatda bo'lishi mumkin — eng yaxshisi qoladi.
const RANK = {
  done: 5,
  partial: 4,
  failed: 3,
  skipped: 2,
  processing: 1,
  pending: 0,
};

const groups = await runs
  .aggregate([
    {
      $group: {
        _id: { uid: "$userUid", key: "$mahallaKey" },
        n: { $sum: 1 },
        nom: { $first: "$mahallaName" },
      },
    },
    { $match: { n: { $gt: 1 } } },
  ])
  .toArray();

if (!groups.length) {
  console.log("Dublikat yurish yo'q — hammasi tartibda.");
  await mongoose.disconnect();
  process.exit(0);
}

console.log(
  APPLY
    ? "=== BIRLASHTIRISH (o'zgartiriladi) ==="
    : "=== QURUQ YURISH (hech narsa o'zgartirilmaydi) ===",
);
console.log();

// Zaxira: o'zgarishdan oldingi holat faylga yoziladi. Xato bo'lsa
// qaytarish uchun yagona imkoniyat.
const backup = [];

for (const group of groups) {
  const list = await runs
    .find({ userUid: group._id.uid, mahallaKey: group._id.key })
    .sort({ createdAt: 1 })
    .toArray();

  const main = list[0];
  const extras = list.slice(1);
  const extraIds = extras.map((run) => run._id);

  console.log(`${group.nom}: ${list.length} ta yurish -> 1 ta`);
  console.log(`   asosiy: ${String(main._id).slice(-6)} (${main.createdAt.toISOString().slice(0, 16)})`);

  // --- Xonadonlar ---
  const allHomes = await homes
    .find({ runId: { $in: [main._id, ...extraIds] } })
    .toArray();

  // Kadastr bo'yicha eng yaxshi holatni aniqlaymiz.
  const best = new Map();

  for (const home of allHomes) {
    const key = home.cadasterNumber ?? String(home._id);
    const current = best.get(key);
    const rank = RANK[home.status] ?? 0;

    // Asosiy yurishdagi yozuv ustunlik qiladi: `homeRowId` havolalari
    // o'shanga bog'lanadi.
    const isMain = String(home.runId) === String(main._id);

    if (
      !current ||
      rank > current.rank ||
      (rank === current.rank && isMain && !current.isMain)
    ) {
      best.set(key, { home, rank, isMain });
    }
  }

  // Qaysi eski xonadon yozuvi qaysi yangisiga mos keladi —
  // a'zolarning `homeRowId` ini ko'chirish uchun.
  const homeMap = new Map();
  for (const home of allHomes) {
    const key = home.cadasterNumber ?? String(home._id);
    homeMap.set(String(home._id), String(best.get(key).home._id));
  }

  const keepIds = new Set([...best.values()].map((v) => String(v.home._id)));
  const dropHomes = allHomes.filter((h) => !keepIds.has(String(h._id)));

  const memberCount = await members.countDocuments({
    runId: { $in: extraIds },
  });

  console.log(`   xonadon: ${allHomes.length} -> ${best.size} (${dropHomes.length} ta ortiqcha o'chiriladi)`);
  console.log(`   a'zo   : ${memberCount} ta yozuv asosiy yurishga ko'chiriladi`);

  backup.push({
    mahalla: group.nom,
    mainRunId: String(main._id),
    extraRunIds: extraIds.map(String),
    homesBefore: allHomes.map((h) => ({
      _id: String(h._id),
      runId: String(h.runId),
      cadasterNumber: h.cadasterNumber,
      status: h.status,
    })),
  });

  if (!APPLY) {
    console.log();
    continue;
  }

  // 1. A'zolarni asosiy yurishga ko'chiramiz.
  //    `homeRowId` ham yangi xonadon yozuviga qayta bog'lanadi,
  //    aks holda "Ba'tafsil" bo'sh xonadonga ishora qilardi.
  const ops = [];

  for (const [oldId, newId] of homeMap) {
    if (oldId === newId) continue;
    ops.push({
      updateMany: {
        filter: { homeRowId: new mongoose.Types.ObjectId(oldId) },
        update: {
          $set: {
            homeRowId: new mongoose.Types.ObjectId(newId),
            runId: main._id,
          },
        },
      },
    });
  }

  if (ops.length) await members.bulkWrite(ops, { ordered: false });

  // Qolganlari (homeRowId mos kelmaganlari) ham ko'chiriladi.
  await members.updateMany(
    { runId: { $in: extraIds } },
    { $set: { runId: main._id } },
  );

  // 2. Saqlanadigan xonadonlarni asosiy yurishga bog'laymiz va
  //    eng yaxshi holatni yozamiz.
  const homeOps = [...best.values()].map(({ home }) => ({
    updateOne: {
      filter: { _id: home._id },
      update: { $set: { runId: main._id, status: home.status } },
    },
  }));

  if (homeOps.length) await homes.bulkWrite(homeOps, { ordered: false });

  // 3. Ortiqcha xonadon yozuvlarini o'chiramiz.
  if (dropHomes.length) {
    await homes.deleteMany({ _id: { $in: dropHomes.map((h) => h._id) } });
  }

  // 4. Asosiy yurishning hisoblagichlarini manbadan qayta sanaymiz.
  const homesDone = await homes.countDocuments({
    runId: main._id,
    status: { $in: ["done", "partial", "skipped", "failed"] },
  });
  const homesTotal = await homes.countDocuments({ runId: main._id });

  const added = await members.countDocuments({
    runId: main._id,
    status: "added",
  });
  const failed = await members.countDocuments({
    runId: main._id,
    status: "failed",
  });
  const skipped = await members.countDocuments({
    runId: main._id,
    status: "skipped",
  });

  await runs.updateOne(
    { _id: main._id },
    {
      $set: {
        homesTotal,
        homesDone,
        membersAdded: added,
        membersFailed: failed,
        membersSkipped: skipped,
        // Eng so'nggi yurishning holati olinadi: foydalanuvchi
        // oxirgi marta nima qilgan bo'lsa, o'sha saqlanadi.
        status: list[list.length - 1].status,
      },
    },
  );

  // 5. Ortiqcha yurishlarni o'chiramiz.
  await runs.deleteMany({ _id: { $in: extraIds } });

  console.log(`   ✓ birlashtirildi (xonadon ${homesDone}/${homesTotal})`);
  console.log();
}

if (!APPLY) {
  console.log("Haqiqatan bajarish uchun: node merge-runs.mjs --apply");
} else {
  const file = `backup-runs-${Date.now()}.json`;
  fs.writeFileSync(file, JSON.stringify(backup, null, 2));
  console.log(`Zaxira yozildi: ${file}`);
}

await mongoose.disconnect();
