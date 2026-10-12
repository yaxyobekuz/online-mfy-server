import { Router } from "express";
import {
  getMahallaList,
  getMahallaStats,
  getMahallaCitizens,
} from "../controllers/mahalla.controller.js";

const router = Router();

// Aniq yo'l :param'dan oldin turishi kerak.
router.get("/mahallas/stats", getMahallaStats);
router.get("/mahallas/:key/citizens", getMahallaCitizens);
router.get("/mahallas", getMahallaList);

export default router;
