import { Router } from "express";
import multer from "multer";
import {
  uploadRawRecords,
  getRawRecords,
  deleteRawRecords,
  fixRawRecordPhones,
} from "../controllers/raw-record.controller.js";

const router = Router();

// Xotirada saqlaymiz (diskka yozmasdan) — fayl faqat parse qilish
// uchun kerak, keyin xotiradan chiqib ketadi.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
});

router.get("/raw-records", getRawRecords);
router.post("/raw-records/upload", upload.single("file"), uploadRawRecords);
router.post("/raw-records/fix-phones", fixRawRecordPhones);
router.delete("/raw-records", deleteRawRecords);

export default router;
