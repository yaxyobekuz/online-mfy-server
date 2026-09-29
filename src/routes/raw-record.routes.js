import { Router } from "express";
import multer from "multer";
import {
  uploadRawRecords,
  getRawRecords,
  getRawRecordsStats,
  deleteRawRecords,
  fixRawRecordPhones,
  syncRawRecordsGcp,
  getRawRecordsGcpSyncStatus,
} from "../controllers/raw-record.controller.js";

const router = Router();

// Xotirada saqlaymiz (diskka yozmasdan) — fayl faqat parse qilish
// uchun kerak, keyin xotiradan chiqib ketadi.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
});

router.get("/raw-records", getRawRecords);
router.get("/raw-records/stats", getRawRecordsStats);
router.post("/raw-records/upload", upload.single("file"), uploadRawRecords);
router.post("/raw-records/fix-phones", fixRawRecordPhones);
router.post("/raw-records/gcp-sync", syncRawRecordsGcp);
router.get("/raw-records/gcp-sync/status", getRawRecordsGcpSyncStatus);
router.delete("/raw-records", deleteRawRecords);

export default router;
