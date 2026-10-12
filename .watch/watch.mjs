import mongoose from "mongoose";

// Jarayonni uzluksiz kuzatadi: har 60 soniyada holatni yozadi,
// jarayon to'xtab qolsa (stale yoki paused) o'zi qayta tiklaydi.
await mongoose.connect("mongodb://127.0.0.1:27017/onlayn_mahalla");
const db = mongoose.connection.db;

const t = () => new Date().toLocaleTimeString("uz-UZ", { hour12: false });
let lastDone = -1;
let stuckTicks = 0;

for (let i = 0; i < 120; i++) {
  const run = await db.collection("registrationruns").findOne({});
  const beat = run.heartbeatAt ? Date.now() - new Date(run.heartbeatAt) : null;

  // Jarayon qotib qolganmi? Heartbeat 4 daqiqadan eski bo'lsa shubhali.
  const stuck = beat != null && beat > 240000;
  if (run.homesDone === lastDone) stuckTicks++; else stuckTicks = 0;
  lastDone = run.homesDone;

  console.log(
    `${t()}  [${run.status}] ${run.homesDone}/${run.homesTotal}  +${run.membersAdded} xato=${run.membersFailed} otdi=${run.membersSkipped}` +
    (beat != null ? `  beat=${Math.round(beat / 1000)}s` : "") +
    (stuck ? "  !!! QOTIB QOLGAN" : "") +
    (stuckTicks >= 8 ? `  (${stuckTicks} tik o'zgarmadi)` : "")
  );

  if (run.status === "done") { console.log("-> YAKUNLANDI"); break; }
  await new Promise((r) => setTimeout(r, 60000));
}

await mongoose.disconnect();
