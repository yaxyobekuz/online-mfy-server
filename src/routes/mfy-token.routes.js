import { Router } from "express";
import {
  listMfyTokens,
  addMfyToken,
  updateMfyToken,
  deleteMfyToken,
} from "../controllers/mfy-token.controller.js";

const router = Router();

router.get("/mfy-tokens", listMfyTokens);
router.post("/mfy-tokens", addMfyToken);
router.put("/mfy-tokens/:uid", updateMfyToken);
router.delete("/mfy-tokens/:uid", deleteMfyToken);

export default router;
