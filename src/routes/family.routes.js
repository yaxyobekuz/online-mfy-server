import { Router } from "express";
import {
  getHomeFamily,
  syncFamilyForHome,
  getFamilySyncStatus,
} from "../controllers/family.controller.js";

const router = Router();

router.get("/family/sync/status", getFamilySyncStatus);
router.get("/homes/:homeId/family", getHomeFamily);
router.post("/homes/:homeId/family/sync", syncFamilyForHome);

export default router;
