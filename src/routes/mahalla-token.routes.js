import { Router } from "express";
import {
  getMahallaTokens,
  addMahallaToken,
  deleteMahallaToken,
  getTokenMahallas,
  syncTokenHomes,
} from "../controllers/mahalla-token.controller.js";

const router = Router();

router.get("/mahalla-tokens", getMahallaTokens);
router.post("/mahalla-tokens", addMahallaToken);
router.get("/mahalla-tokens/:tokenId/mahallas", getTokenMahallas);
router.post("/mahalla-tokens/:tokenId/sync", syncTokenHomes);
router.delete("/mahalla-tokens/:tokenId", deleteMahallaToken);

export default router;
