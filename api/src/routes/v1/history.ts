import { Router, Request, Response } from "express";
import { authMiddleware } from "../../middleware/auth.js";
import {
  HISTORY_EVENT_TYPE_VALUES,
  type HistoryEventType,
  listHistoryEvents,
} from "../../services/commands/history-events.js";
import {
  ACTIVITY_FILTERS,
  getActivityEventsPage,
  getActivityPage,
} from "../../services/commands/command-history.js";
import type { ActivityListResponseContract } from "../../contracts/status.js";
import {
  getCommandTypesForQueueCategory,
  type CommandQueueCategory,
} from "../../services/commands/command-registry.js";
import { parseActivityFilters, parseListPagination } from "../../utils/activity-query.js";

const router = Router();
router.use(authMiddleware);

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

// --- HISTORY EVENTS ENDPOINT (replaces /api/history) ---
router.get("/", (req: Request, res: Response) => {
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

// --- TASK ACTIVITY ENDPOINTS (replaces /api/activity) ---
const defaultActivityStatuses: readonly (typeof ACTIVITY_FILTERS.statuses)[number][] = ["completed", "failed", "cancelled"];
const defaultActivityCategories: readonly CommandQueueCategory[] = ["downloads", "scans", "other"];

function normalizeStatusFilterValue(status: string): string {
  return status === "running" ? "started" : status;
}

router.get("/activity", (req: Request, res: Response) => {
  try {
    const { limit, offset } = parseListPagination(req.query as Record<string, unknown>);

    const filtersResult = parseActivityFilters({
      query: req.query as Record<string, unknown>,
      defaultStatuses: defaultActivityStatuses,
      defaultCategories: defaultActivityCategories,
      allowedStatuses: ACTIVITY_FILTERS.statuses,
      allowedCategories: ACTIVITY_FILTERS.categories,
      unsupportedLabel: "activity",
      normalizeStatus: normalizeStatusFilterValue,
      getSupportedTypes: (categories) => categories.flatMap((category) => getCommandTypesForQueueCategory(category)),
    });

    if ("error" in filtersResult) {
      return res.status(400).json(filtersResult.error);
    }

    const { statuses, categories, types } = filtersResult.value;

    const page = getActivityPage({
      limit,
      offset,
      statuses: statuses as Array<(typeof ACTIVITY_FILTERS.statuses)[number]>,
      categories,
      types,
    });

    const payload: ActivityListResponseContract = {
      items: page.items,
      total: page.total,
      limit: page.limit,
      offset: page.offset,
      hasMore: page.hasMore,
    };

    res.json(payload);
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

router.get("/events", (req: Request, res: Response) => {
  try {
    const { limit, offset } = parseListPagination(req.query as Record<string, unknown>);
    const page = getActivityEventsPage({ limit, offset });

    return res.json(page);
  } catch (error: any) {
    return res.status(500).json({ detail: error.message });
  }
});

export default router;
