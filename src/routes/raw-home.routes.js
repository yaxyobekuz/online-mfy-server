import { Router } from "express";
import {
  getRawHomes,
  getRawHomesStats,
  getRawHomeMembers,
} from "../controllers/raw-home.controller.js";

const router = Router();

router.get("/raw-homes", getRawHomes);
// "stats" ":cadasterNumber" naqshidan oldin turishi kerak — aks holda
// u kadastr raqami sifatida qabul qilinadi.
router.get("/raw-homes/stats", getRawHomesStats);
router.get("/raw-homes/:cadasterNumber", getRawHomeMembers);

export default router;
