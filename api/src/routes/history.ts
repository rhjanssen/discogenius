import { Router } from "express";
import {
  HISTORY_EVENT_TYPE_VALUES,
  type HistoryEventType,
  listHistoryEvents,
} from "../services/history-events.js";

const router = Router();
const INTEGER_PATTERN = /^\d+$/;

function parseOptionalPositiveInt(value: unknown, fieldName: string): number | undefined {
  if (value === undefined || value === null || String(value).trim() === "") {
    return undefined;
  }

  const text = String(value).trim();
  if (!INTEGER_PATTERN.test(text)) {
    throw new Error(`${fieldName} must be a positive integer`);
  }

  const parsed = Number.parseInt(text, 10);
  if (parsed <= 0) {
    throw new Error(`${fieldName} must be a positive integer`);
  }

  return parsed;
}

function parseLimit(value: unknown): number {
  if (value === undefined || value === null || String(value).trim() === "") {
    return 50;
  }

  const text = String(value).trim();
  if (!INTEGER_PATTERN.test(text)) {
    throw new Error("limit must be an integer between 1 and 200");
  }

  const parsed = Number.parseInt(text, 10);
  if (parsed < 1 || parsed > 200) {
    throw new Error("limit must be between 1 and 200");
  }

  return parsed;
}

function parseOffset(value: unknown): number {
  if (value === undefined || value === null || String(value).trim() === "") {
    return 0;
  }

  const text = String(value).trim();
  if (!INTEGER_PATTERN.test(text)) {
    throw new Error("offset must be a non-negative integer");
  }

  return Number.parseInt(text, 10);
}

router.get("/", (req, res) => {
  try {
    const artistId = parseOptionalPositiveInt(req.query.artistId, "artistId");
    const albumId = parseOptionalPositiveInt(req.query.albumId, "albumId");
    const mediaId = parseOptionalPositiveInt(req.query.mediaId, "mediaId");
    const limit = parseLimit(req.query.limit);
    const offset = parseOffset(req.query.offset);

    const eventTypeRaw = req.query.eventType;
    let eventType: HistoryEventType | undefined;

    if (eventTypeRaw !== undefined && eventTypeRaw !== null && String(eventTypeRaw).trim() !== "") {
      const candidate = String(eventTypeRaw).trim() as HistoryEventType;
      if (!HISTORY_EVENT_TYPE_VALUES.includes(candidate)) {
        return res.status(400).json({
          detail: `eventType must be one of: ${HISTORY_EVENT_TYPE_VALUES.join(", ")}`,
        });
      }
      eventType = candidate;
    }

    const result = listHistoryEvents({
      artistId,
      albumId,
      mediaId,
      eventType,
      limit,
      offset,
    });

    return res.json(result);
  } catch (error: any) {
    return res.status(400).json({ detail: error.message });
  }
});

export default router;
