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
import {
  startHomeMembersScan,
  stopHomeMembersScan,
  getHomeMembersScanStatus,
  getHomeMembers,
  exportHomeMembers,
} from "../controllers/home-members.controller.js";

const router = Router();

// "Hisoblash" — MFY xonadonlarini bir martalik aniqlab olish.
router.post("/mahalla-scan", startMahallaScan);
router.get("/mahalla-scan/status", getMahallaScanStatus);

// MFY xonadon a'zolarini to'liq yuklab olish.
// Aniq yo'llar :param'dan oldin turishi kerak.
router.post("/home-members/scan", startHomeMembersScan);
router.post("/home-members/scan/stop", stopHomeMembersScan);
router.get("/home-members/scan/status", getHomeMembersScanStatus);
router.get("/home-members/export", exportHomeMembers);
router.get("/home-members", getHomeMembers);

// Aniq yo'llar :param'dan oldin turishi kerak.
router.get("/dashboard/stream", streamDashboard);
router.get("/dashboard/members/:memberId", getDashboardMember);
router.post("/dashboard/control", controlDashboard);
router.post("/dashboard/random-start", randomStart);
router.get("/dashboard", getDashboard);

router.get("/statistics", getStatistics);

export default router;
