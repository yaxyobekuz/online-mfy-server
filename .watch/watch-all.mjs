/**
 * Barcha faol yurishlarni birdan kuzatadi va to'xtaganini tiklaydi.
 * Bir nechta MFY parallel ishlagani uchun har biri alohida
 * tekshiriladi.
 */
import mongoose from "mongoose";
import fs from "node:fs";

const API = "http://127.0.0.1:5000";
const TOKEN = fs.readFileSync("../agent-lab/.token", "utf8").trim();
const STUCK_MS = 300000;
const TICK_MS = 60000;

const t = () => new Date().toLocaleTimeString("uz-UZ", { hour12: false });

const resume = async (runId, name) => {
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
    console.log(`${t()}  -> ${name} TIKLANDI: ${data.message ?? res.status}`);
  } catch (err) {
    console.log(`${t()}  -> ${name} tiklash xatosi: ${err.message}`);
  }
};

await mongoose.connect("mongodb://127.0.0.1:27017/onlayn_mahalla");
const db = mongoose.connection.db;

for (;;) {
  const runs = await db
    .collection("registrationruns")
    .find({})
    .sort({ createdAt: 1 })
    .toArray();

  const parts = [];
  let allDone = true;

  for (const run of runs) {
    const beat = run.heartbeatAt
      ? Date.now() - new Date(run.heartbeatAt)
      : null;

    parts.push(
      `${String(run.mahallaName).slice(0, 8)} ${run.homesDone}/${run.homesTotal} +${run.membersAdded}`,
    );

    if (run.status === "done" || run.status === "stopped") continue;
    allDone = false;

    const stalled =
      run.status === "error" ||
      run.status === "paused" ||
      (run.status === "running" && beat != null && beat > STUCK_MS);

    if (stalled) {
      console.log(
        `${t()}  !!! ${run.mahallaName} to'xtagan (${run.status}, beat=${beat != null ? Math.round(beat / 1000) : "?"}s)`,
      );
      await resume(String(run._id), run.mahallaName);
    }
  }

  console.log(`${t()}  ${parts.join("  |  ")}`);

  if (allDone) {
    console.log(`${t()}  === BARCHA YURISHLAR YAKUNLANDI ===`);
    break;
  }

  await new Promise((r) => setTimeout(r, TICK_MS));
}

await mongoose.disconnect();
