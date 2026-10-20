import "./src/config/env.js";

import express from "express";
import cors from "cors";
import connectDB from "./src/config/database.js";
import authRoutes from "./src/routes/auth.routes.js";
import mfyTokenRoutes from "./src/routes/mfy-token.routes.js";
import userRoutes from "./src/routes/user.routes.js";
import citizenRoutes from "./src/routes/citizen.routes.js";
import uncadastredRoutes from "./src/routes/uncadastred.routes.js";
import dashboardRoutes from "./src/routes/dashboard.routes.js";
import { authContext } from "./src/middlewares/auth-context.middleware.js";

const app = express();
const PORT = process.env.PORT || 5000;

await connectDB();

// Server qayta ishga tushganda, OLDINGI nusxasi qoldirgan egalikni
// bo'shatib, uzilib qolgan yurishlarni AVTOMATIK davom ettiramiz.
//
// Nega kerak: ishchi egalikni `finally` blokida bo'shatadi, lekin
// jarayon majburan to'xtatilsa (kill, deploy, qayta ishga tushirish)
// u ishlamaydi. Natijada yurish "ketmoqda" deb qolib ketardi,
// ishchisi esa o'lgan bo'lardi — foydalanuvchi qo'lda "Boshlash"
// bosishi kerak edi. Endi server o'zi ko'tarib ketadi.
//
// Faqat SHU server nomidagi egalik tozalanadi: boshqa serverniki
// tegilmaydi (u haqiqatan ishlayotgan bo'lishi mumkin).
{
  const { default: RegistrationRun } = await import(
    "./src/models/RegistrationRun.js"
  );
  const { runRegistration } = await import(
    "./src/services/registration-worker.js"
  );

  const serverName = process.env.SERVER_NAME ?? "asosiy";
  const released = await RegistrationRun.updateMany(
    { ownerName: serverName },
    { $set: { ownerId: null, ownerName: null } },
  );

  if (released.modifiedCount) {
    console.log(
      `Oldingi nusxadan qolgan ${released.modifiedCount} ta yurish egaligi bo'shatildi`,
    );
  }

  // Foydalanuvchi to'xtatgan, lekin ishchi yozib ulgurmagan
  // yurishlar: `control` "stop"/"pause" bo'lsa-yu, status hali
  // "running" bo'lsa — statusni to'g'rilaymiz (aks holda ular
  // abadiy "ketmoqda" ko'rinardi va statistika chalg'itardi).
  await RegistrationRun.updateMany(
    { status: { $in: ["running", "preparing"] }, control: "stop" },
    { $set: { status: "stopped", stage: "To'xtatildi", finishedAt: new Date() } },
  );
  await RegistrationRun.updateMany(
    { status: { $in: ["running", "preparing"] }, control: "pause" },
    { $set: { status: "paused", stage: "To'xtatib turildi" } },
  );

  // Uzilib qolgan yurishlarni davom ettiramiz.
  //
  // Faqat ishlashi kerak bo'lganlari: "running"/"preparing" —
  // foydalanuvchi to'xtatmagan (pause/stop EMAS), demak uzilish
  // deploy yoki nosozlik tufayli. Token saqlanган bo'lishi shart
  // (usiz tashqi API ishlamaydi).
  const stranded = await RegistrationRun.find({
    status: { $in: ["running", "preparing"] },
    control: "run",
    token: { $nin: [null, ""] },
  })
    .select("+token")
    .lean();

  for (const run of stranded) {
    const user = {
      uid: run.userUid,
      oblId: run.oblId,
      areaId: run.areaId,
      districtId: run.districtId,
    };

    // Fonda ishga tushiramiz — serverni bloklamaymiz.
    runRegistration(user, run, run.token).catch((err) =>
      console.error(`Yurish davom ettirilmadi (${run.mahallaName}):`, err.message),
    );
  }

  if (stranded.length) {
    console.log(
      `${stranded.length} ta uzilib qolgan yurish avtomatik davom ettirilmoqda`,
    );
  }
}

app.use(cors());
app.use(express.json());

// Sog'liq tekshiruvi — sessiyasiz.
app.get("/api/health", (req, res) => res.json({ ok: true }));

app.use(authContext);

app.use("/api", authRoutes);
app.use("/api", mfyTokenRoutes);
app.use("/api", userRoutes);
app.use("/api", citizenRoutes);
app.use("/api", uncadastredRoutes);
app.use("/api", dashboardRoutes);

app.listen(PORT, () => {
  console.log(`Server ${PORT}-portda ishga tushdi`);
});
