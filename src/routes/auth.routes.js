import { Router } from "express";
import { login } from "../controllers/auth.controller.js";

const router = Router();

router.post("/auth/login", login);

export default router;
