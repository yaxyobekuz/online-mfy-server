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
