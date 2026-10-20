import { Router } from "express";
import multer from "multer";
import {
  uploadUncadastred,
  getUncadastred,
  getUncadastredStats,
  getUncadastredGroups,
  createUncadastredGroup,
  updateUncadastredGroup,
  deleteUncadastredGroup,
  deleteUncadastredCitizen,
} from "../controllers/uncadastred.controller.js";

const router = Router();

// Xotirada saqlaymiz — fayl faqat parse qilish uchun kerak.
// Hajm chegarasi umumiy baza bilan bir xil: kadastrsiz ro'yxat ham
// o'n minglab qatorli bo'lishi mumkin.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 60 * 1024 * 1024 }, // 60MB
});

// Aniq yo'llar :param'dan oldin turishi kerak.
router.get("/uncadastred/stats", getUncadastredStats);

router.get("/uncadastred/groups", getUncadastredGroups);
router.post("/uncadastred/groups", createUncadastredGroup);
router.put("/uncadastred/groups/:groupId", updateUncadastredGroup);
router.delete("/uncadastred/groups/:groupId", deleteUncadastredGroup);

router.post("/uncadastred/upload", upload.single("file"), uploadUncadastred);

router.get("/uncadastred", getUncadastred);
router.delete("/uncadastred/:citizenId", deleteUncadastredCitizen);

export default router;
