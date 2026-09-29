import { Router } from "express";
import {
  getAllHomes,
  getAllHomesStats,
  getStreetHomes,
  getStreetHomesStats,
  getHomeDetails,
  updateAllHomes,
  updateStreetHomes,
  syncStreetHomesDetails,
  syncAllHomesDetails,
  getHomesDetailsSyncStatus,
} from "../controllers/home.controller.js";

const router = Router();

router.get("/homes/stats", getAllHomesStats);
router.get("/homes", getAllHomes);
router.post("/homes/update", updateAllHomes);
router.post("/homes/details/sync", syncAllHomesDetails);
router.get("/homes/details/sync/status", getHomesDetailsSyncStatus);
router.get("/homes/:homeId", getHomeDetails);

router.get("/streets/:streetId/homes/stats", getStreetHomesStats);
router.get("/streets/:streetId/homes", getStreetHomes);
router.post("/streets/:streetId/homes/update", updateStreetHomes);
router.post(
  "/streets/:streetId/homes/details/sync",
  syncStreetHomesDetails,
);

export default router;
