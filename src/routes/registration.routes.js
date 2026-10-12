import { Router } from "express";
import { streamRegistrationState } from "../controllers/registration-stream.controller.js";
import {
  getRegistrationMahallas,
  getRegistrationRuns,
  startRegistration,
  controlRegistration,
  getRegistrationStatus,
  getRegistrationHomes,
  getRegistrationHomeDetails,
  getRegistrationMembers,
  getRegistrationMemberDetails,
  getRegistrationReport,
  retryRegistrationFailures,
  exportRegistrationReport,
  getRegistrationTimings,
  deleteRegistrationRun,
} from "../controllers/registration.controller.js";

const router = Router();

// Aniq yo'llar :param'dan oldin turishi kerak.
router.get("/registration/mahallas", getRegistrationMahallas);
router.get("/registration/report", getRegistrationReport);
router.get("/registration/runs", getRegistrationRuns);
// Jonli uzatish (SSE) — holat va API limiti real vaqtda.
router.get("/registration/stream", streamRegistrationState);
router.post("/registration/runs", startRegistration);

router.get("/registration/members/:memberId", getRegistrationMemberDetails);
router.get("/registration/homes/:homeRowId", getRegistrationHomeDetails);

router.get("/registration/runs/:runId/status", getRegistrationStatus);
router.get("/registration/runs/:runId/homes", getRegistrationHomes);
router.get("/registration/runs/:runId/members", getRegistrationMembers);
router.post("/registration/runs/:runId/control", controlRegistration);
router.post("/registration/runs/:runId/retry", retryRegistrationFailures);
router.get("/registration/runs/:runId/export", exportRegistrationReport);
router.get("/registration/runs/:runId/timings", getRegistrationTimings);
router.delete("/registration/runs/:runId", deleteRegistrationRun);

export default router;
