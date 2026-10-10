import { Router } from "express";
import {
  getHomeFamily,
  syncFamilyForHome,
  getFamilySyncStatus,
  syncStreetHomesFamily,
  syncAllHomesFamily,
} from "../controllers/family.controller.js";

const router = Router();

router.get("/family/sync/status", getFamilySyncStatus);
// Ommaviy yuklash route'lari ":homeId" naqshidan oldin turishi kerak —
// aks holda "family" so'zi homeId sifatida qabul qilinadi.
router.post("/homes/family/sync", syncAllHomesFamily);
router.post("/streets/:streetId/homes/family/sync", syncStreetHomesFamily);
router.get("/homes/:homeId/family", getHomeFamily);
router.post("/homes/:homeId/family/sync", syncFamilyForHome);

export default router;
