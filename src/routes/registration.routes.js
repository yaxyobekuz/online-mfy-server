import { Router } from "express";
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
  deleteRegistrationRun,
} from "../controllers/registration.controller.js";

const router = Router();

// Aniq yo'llar :param'dan oldin turishi kerak.
router.get("/registration/mahallas", getRegistrationMahallas);
router.get("/registration/report", getRegistrationReport);
router.get("/registration/runs", getRegistrationRuns);
router.post("/registration/runs", startRegistration);

router.get("/registration/members/:memberId", getRegistrationMemberDetails);
router.get("/registration/homes/:homeRowId", getRegistrationHomeDetails);

router.get("/registration/runs/:runId/status", getRegistrationStatus);
router.get("/registration/runs/:runId/homes", getRegistrationHomes);
router.get("/registration/runs/:runId/members", getRegistrationMembers);
router.post("/registration/runs/:runId/control", controlRegistration);
router.post("/registration/runs/:runId/retry", retryRegistrationFailures);
router.delete("/registration/runs/:runId", deleteRegistrationRun);

export default router;
