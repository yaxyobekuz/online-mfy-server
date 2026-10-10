import { Router } from "express";
import {
  startFamilyAdd,
  getFamilyAddStatus,
  getFamilyAddStats,
  resetFailedFamilyAdd,
} from "../controllers/family-add.controller.js";

const router = Router();

router.post("/family-add/start", startFamilyAdd);
router.get("/family-add/status", getFamilyAddStatus);
router.get("/family-add/stats", getFamilyAddStats);
router.post("/family-add/reset-failed", resetFailedFamilyAdd);

export default router;
