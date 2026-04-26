import { Router } from "express";
import {
  CatalogSearchValidationError,
  searchCatalog,
} from "../services/catalog-search-service.js";

const router = Router();

router.get("/", async (req, res) => {
  try {
    const payload = await searchCatalog({
      query: req.query.query,
      type: req.query.type,
      limit: req.query.limit,
    });
    res.json(payload);
  } catch (error: any) {
    if (error instanceof CatalogSearchValidationError) {
      return res.status(error.status).json({ detail: error.message });
    }

    console.error("[search] Error:", error);
    res.status(500).json({ detail: "Search request failed" });
  }
});

export default router;
