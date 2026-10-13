import { Router } from "express";
import {
  getDashboard,
  controlDashboard,
  getDashboardMember,
  randomStart,
} from "../controllers/dashboard.controller.js";
import { streamDashboard } from "../controllers/dashboard-stream.controller.js";
import { getStatistics } from "../controllers/statistics.controller.js";
import {
  startMahallaScan,
  getMahallaScanStatus,
} from "../controllers/mahalla-scan.controller.js";

const router = Router();

// "Hisoblash" — MFY xonadonlarini bir martalik aniqlab olish.
router.post("/mahalla-scan", startMahallaScan);
router.get("/mahalla-scan/status", getMahallaScanStatus);

// Aniq yo'llar :param'dan oldin turishi kerak.
router.get("/dashboard/stream", streamDashboard);
router.get("/dashboard/members/:memberId", getDashboardMember);
router.post("/dashboard/control", controlDashboard);
router.post("/dashboard/random-start", randomStart);
router.get("/dashboard", getDashboard);

router.get("/statistics", getStatistics);

export default router;
