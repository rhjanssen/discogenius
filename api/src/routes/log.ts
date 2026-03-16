import { Router } from "express";
import { getLogs } from "../services/app-logger.js";

const router = Router();

router.get("/", (req, res) => {
  try {
    const limit = parseInt(String(req.query.limit || "100"), 10) || 100;
    const offset = parseInt(String(req.query.offset || "0"), 10) || 0;
    const level = typeof req.query.level === "string" ? req.query.level : null;

    res.json(getLogs({ limit, offset, level }));
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

export default router;
