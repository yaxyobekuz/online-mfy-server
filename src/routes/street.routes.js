import { Router } from "express";
import {
  getUserStreets,
  updateUserStreets,
} from "../controllers/street.controller.js";

const router = Router();

router.get("/streets", getUserStreets);
router.post("/streets/update", updateUserStreets);

export default router;
