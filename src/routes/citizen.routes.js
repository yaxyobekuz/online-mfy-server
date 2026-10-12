import { Router } from "express";
import multer from "multer";
import {
  uploadCitizens,
  getCitizens,
  getCitizensStats,
  deleteCitizens,
} from "../controllers/citizen.controller.js";
import {
  startCitizenSync,
  getCitizenSyncStatus,
} from "../controllers/citizen-sync.controller.js";

const router = Router();

// Xotirada saqlaymiz — fayl faqat parse qilish uchun kerak.
// Umumiy ro'yxat katta (150 mingdan ortiq qator) bo'lishi mumkin,
// shuning uchun limit xom ma'lumotnikidan kattaroq.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 60 * 1024 * 1024 }, // 60MB
});

// Aniq yo'llar :param'dan oldin turishi kerak.
router.get("/citizens/stats", getCitizensStats);
router.post("/citizens/sync", startCitizenSync);
router.get("/citizens/sync/status", getCitizenSyncStatus);
router.post("/citizens/upload", upload.single("file"), uploadCitizens);
router.get("/citizens", getCitizens);
router.delete("/citizens", deleteCitizens);

export default router;
