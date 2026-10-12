/**
 * Ro'yxatga olish jarayonini uzluksiz kuzatadi va o'zi tiklaydi.
 *
 * Vazifasi ikkita:
 *   1. Har daqiqada holatni yozib boradi (tahlil uchun tarix);
 *   2. Jarayon to'xtab qolsa — o'zi davom ettiradi.
 *
 * Nega kerak: yurish 10 soatdan ko'proq davom etadi. Shu vaqt
 * ichida tarmoq uzilishi, tashqi API nosozligi yoki server qayta
 * ishga tushishi bo'lishi mumkin. Odam kutib o'tirmasligi uchun
 * tiklash avtomatik bo'lgani ma'qul.
 */

import mongoose from "mongoose";
import fs from "node:fs";

const MONGO = "mongodb://127.0.0.1:27017/onlayn_mahalla";
const API = "http://127.0.0.1:5000";
const TOKEN = fs.readFileSync("../agent-lab/.token", "utf8").trim();

// Heartbeat shundan eski bo'lsa, jarayon qotib qolgan hisoblanadi.
// Bitta odam ~20 soniya, rate-limit kutishi ~56 soniya — shuning
// uchun chegara ulardan sezilarli katta olinadi.
const STUCK_MS = 300000; // 5 daqiqa

const TICK_MS = 60000;

const t = () => new Date().toLocaleTimeString("uz-UZ", { hour12: false });

const resume = async (runId) => {
  try {
    const res = await fetch(`${API}/api/registration/runs/${runId}/control`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action: "resume" }),
    });
    const data = await res.json();
    console.log(`${t()}  -> TIKLANDI: ${data.message ?? res.status}`);
  } catch (err) {
    console.log(`${t()}  -> tiklash xatosi: ${err.message}`);
  }
};

await mongoose.connect(MONGO);
const db = mongoose.connection.db;

let lastDone = -1;
let lastAdded = -1;

for (;;) {
  const run = await db.collection("registrationruns").findOne({});

  if (!run) {
    console.log(`${t()}  yurish topilmadi`);
    break;
  }

  const beatMs = run.heartbeatAt ? Date.now() - new Date(run.heartbeatAt) : null;
  const moved = run.homesDone !== lastDone || run.membersAdded !== lastAdded;
  lastDone = run.homesDone;
  lastAdded = run.membersAdded;

  console.log(
    `${t()}  [${run.status}] ${run.homesDone}/${run.homesTotal}` +
      `  +${run.membersAdded} xato=${run.membersFailed} otdi=${run.membersSkipped}` +
      (beatMs != null ? `  beat=${Math.round(beatMs / 1000)}s` : "") +
      (moved ? "" : "  (o'zgarmadi)"),
  );

  if (run.status === "done") {
    console.log(`${t()}  === YURISH YAKUNLANDI ===`);
    break;
  }

  // To'xtab qolgan holatlar — o'zimiz tiklaymiz.
  const stalled =
    run.status === "error" ||
    run.status === "paused" ||
    (run.status === "running" && beatMs != null && beatMs > STUCK_MS);

  if (stalled) {
    console.log(
      `${t()}  !!! to'xtagan (status=${run.status}, beat=${beatMs != null ? Math.round(beatMs / 1000) : "?"}s) — tiklanmoqda`,
    );
    await resume(String(run._id));
  }

  await new Promise((r) => setTimeout(r, TICK_MS));
}

await mongoose.disconnect();
