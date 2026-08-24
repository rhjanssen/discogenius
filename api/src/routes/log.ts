import { Router } from "express";
import { getLogs } from "../services/config/app-logger.js";
import { parseBoundedQueryInteger } from "../utils/request-validation.js";

const router = Router();

router.get("/", (req, res) => {
  try {
    const limit = parseBoundedQueryInteger(req.query.limit, 100, { min: 1, max: 500 });
    const offset = parseBoundedQueryInteger(req.query.offset, 0);
    const level = typeof req.query.level === "string" ? req.query.level : null;

    res.json(getLogs({ limit, offset, level }));
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

export default router;
