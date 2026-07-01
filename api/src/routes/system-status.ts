import { Router } from "express";
import { collectHealthDiagnosticsSnapshot } from "../services/commands/health.js";

const router = Router();

router.get("/", (_req, res) => {
  try {
    res.json(collectHealthDiagnosticsSnapshot());
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

export default router;
