import { Router } from "express";
import {
  getDashboard,
  controlDashboard,
  getDashboardMember,
  randomStart,
  extraStart,
  uncadastredStart,
  getStreetSettings,
  updateStreetSettings,
} from "../controllers/dashboard.controller.js";
import {
  getDashboardList,
  getDashboardFeed,
  getDashboardCitizen,
  getDashboardHome,
} from "../controllers/dashboard-list.controller.js";
import { getDashboardReport } from "../controllers/dashboard-report.controller.js";
import { streamDashboard } from "../controllers/dashboard-stream.controller.js";
import { getStatistics } from "../controllers/statistics.controller.js";
import { getPlatformStats } from "../controllers/platform-stats.controller.js";
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
router.get("/dashboard/street-settings", getStreetSettings);
router.put("/dashboard/street-settings", updateStreetSettings);
router.get("/dashboard/members/:memberId", getDashboardMember);
router.get("/dashboard/list", getDashboardList);
router.get("/dashboard/feed", getDashboardFeed);
router.get("/dashboard/citizens/:citizenId", getDashboardCitizen);
router.get("/dashboard/homes/:homeId", getDashboardHome);
router.get("/dashboard/report", getDashboardReport);
router.post("/dashboard/control", controlDashboard);
router.post("/dashboard/random-start", randomStart);
router.post("/dashboard/extra-start", extraStart);
// "Kadastrsiz boshlash" — kadastrsiz bazadan familiya bo'yicha moslab kiritadi.
router.post("/dashboard/uncadastred-start", uncadastredStart);
router.get("/dashboard", getDashboard);

router.get("/statistics", getStatistics);
router.get("/platform-stats", getPlatformStats);

export default router;
