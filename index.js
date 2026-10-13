import "./src/config/env.js";

import express from "express";
import cors from "cors";
import connectDB from "./src/config/database.js";
import userRoutes from "./src/routes/user.routes.js";
import streetRoutes from "./src/routes/street.routes.js";
import homeRoutes from "./src/routes/home.routes.js";
import familyRoutes from "./src/routes/family.routes.js";
import rawRecordRoutes from "./src/routes/raw-record.routes.js";
import rawHomeRoutes from "./src/routes/raw-home.routes.js";
import familyAddRoutes from "./src/routes/family-add.routes.js";
import citizenRoutes from "./src/routes/citizen.routes.js";
import mahallaRoutes from "./src/routes/mahalla.routes.js";
import registrationRoutes from "./src/routes/registration.routes.js";
import mahallaTokenRoutes from "./src/routes/mahalla-token.routes.js";
import { authContext } from "./src/middlewares/auth-context.middleware.js";

const app = express();
const PORT = process.env.PORT || 5000;

await connectDB();

// Server qayta ishga tushganda, OLDINGI nusxasi qoldirgan egalikni
// bo'shatamiz.
//
// Nega kerak: ishchi egalikni `finally` blokida bo'shatadi, lekin
// jarayon majburan to'xtatilsa (kill, qayta ishga tushirish) u
// ishlamaydi. Natijada yurish "asosiy serverda ketmoqda" deb
// qolib ketadi va "Davom ettirish" o'tkazib yuboriladi — jarayon
// esa aslida to'xtagan.
//
// Faqat SHU server nomidagi egalik tozalanadi: boshqa serverniki
// tegilmaydi (u haqiqatan ishlayotgan bo'lishi mumkin).
{
  const { default: RegistrationRun } = await import(
    "./src/models/RegistrationRun.js"
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
}

app.use(cors());
app.use(express.json());
app.use(authContext);

app.use("/api", userRoutes);
app.use("/api", streetRoutes);
app.use("/api", homeRoutes);
app.use("/api", familyRoutes);
app.use("/api", rawRecordRoutes);
app.use("/api", rawHomeRoutes);
app.use("/api", familyAddRoutes);
app.use("/api", citizenRoutes);
app.use("/api", mahallaRoutes);
app.use("/api", registrationRoutes);
app.use("/api", mahallaTokenRoutes);

app.listen(PORT, () => {
  console.log(`Server ${PORT}-portda ishga tushdi`);
});
