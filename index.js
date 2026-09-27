import "./src/config/env.js";

import express from "express";
import cors from "cors";
import connectDB from "./src/config/database.js";
import userRoutes from "./src/routes/user.routes.js";
import { authContext } from "./src/middlewares/auth-context.middleware.js";

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());
app.use(authContext);

app.use("/api", userRoutes);

// await connectDB();

app.listen(PORT, () => {
  console.log(`Server ${PORT}-portda ishga tushdi`);
});
