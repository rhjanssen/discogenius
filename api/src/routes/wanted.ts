import { Router } from "express";
import { WantedQueryService, type WantedItemType } from "../services/wanted-query-service.js";
import type { DiscogeniusLibraryType } from "../services/lidarr-domain-schema.js";

const router = Router();

const ITEM_TYPES = new Set<WantedItemType>(["album", "video"]);
const LIBRARY_TYPES = new Set<DiscogeniusLibraryType>(["stereo", "atmos", "video"]);

function parseItemType(value: unknown): WantedItemType | undefined {
  const normalized = Array.isArray(value) ? value[0] : value;
  if (typeof normalized !== "string") {
    return undefined;
  }

  return ITEM_TYPES.has(normalized as WantedItemType) ? normalized as WantedItemType : undefined;
}

function parseLibraryType(value: unknown): DiscogeniusLibraryType | undefined {
  const normalized = Array.isArray(value) ? value[0] : value;
  if (typeof normalized !== "string") {
    return undefined;
  }

  return LIBRARY_TYPES.has(normalized as DiscogeniusLibraryType) ? normalized as DiscogeniusLibraryType : undefined;
}

router.get("/", (req, res) => {
  try {
    res.json(WantedQueryService.listWanted({
      artistId: typeof req.query.artistId === "string" ? req.query.artistId : undefined,
      type: parseItemType(req.query.type),
      libraryType: parseLibraryType(req.query.libraryType),
      limit: parseInt(req.query.limit as string, 10) || undefined,
      offset: parseInt(req.query.offset as string, 10) || undefined,
    }));
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

export default router;
