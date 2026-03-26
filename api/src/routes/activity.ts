import { Router } from "express";
import type { ActivityListResponseContract } from "../contracts/status.js";
import {
    ACTIVITY_FILTERS,
    getActivityEventsPage,
    getActivityPage,
} from "../services/command-history.js";
import { getCommandTypesForQueueCategory, type CommandQueueCategory } from "../services/command-registry.js";
import { parseActivityFilters, parseListPagination } from "../utils/activity-query.js";

const router = Router();
const defaultActivityStatuses: readonly (typeof ACTIVITY_FILTERS.statuses)[number][] = ["completed", "failed", "cancelled"];
const defaultActivityCategories: readonly CommandQueueCategory[] = ["downloads", "scans", "other"];

function normalizeStatusFilterValue(status: string): string {
    return status === "running" ? "processing" : status;
}

router.get("/", (req, res) => {
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

router.get("/events", (req, res) => {
    try {
        const { limit, offset } = parseListPagination(req.query as Record<string, unknown>);
        const page = getActivityEventsPage({ limit, offset });

        return res.json(page);
    } catch (error: any) {
        return res.status(500).json({ detail: error.message });
    }
});

export default router;

