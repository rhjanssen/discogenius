import type { QueryValidationError } from "./activity-query.js";

export type QueueHistoryOutcomeFilter = "completed" | "warning" | "failed";
export type QueueHistoryMediaKindFilter = "stereo" | "spatial" | "video";

export type ParsedQueueHistoryFilters = {
    outcomes: QueueHistoryOutcomeFilter[];
    mediaKinds: QueueHistoryMediaKindFilter[];
};

const ALLOWED_OUTCOMES: readonly QueueHistoryOutcomeFilter[] = ["completed", "warning", "failed"];
const ALLOWED_MEDIA_KINDS: readonly QueueHistoryMediaKindFilter[] = ["stereo", "spatial", "video"];

function parseCsvQuery(value: unknown): string[] {
    if (typeof value !== "string") {
        return [];
    }

    return value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
}

function normalizeOutcomeToken(value: string): string {
    const normalized = value.trim().toLowerCase();
    if (normalized === "completedwithwarning" || normalized === "warn") {
        return "warning";
    }
    if (normalized === "error" || normalized === "errors") {
        return "failed";
    }
    return normalized;
}

function normalizeMediaKindToken(value: string): string {
    return value.trim().toLowerCase();
}

/**
 * Parse queue history filter query params.
 * Empty / omitted → no restriction (all outcomes / all media kinds).
 * Supported aliases: outcome|outcomes, slot|slots|mediaKind|mediaKinds.
 */
export function parseQueueHistoryFilters(
    query: Record<string, unknown>,
): { value: ParsedQueueHistoryFilters } | { error: QueryValidationError } {
    const requestedOutcomes = [
        ...parseCsvQuery(query.outcome ?? query.outcomes),
    ].map(normalizeOutcomeToken);

    const invalidOutcomes = requestedOutcomes.filter(
        (value) => !(ALLOWED_OUTCOMES as readonly string[]).includes(value),
    );
    if (invalidOutcomes.length > 0) {
        return {
            error: {
                error: "Invalid outcome filter",
                message: `Unsupported queue history outcomes: ${invalidOutcomes.join(", ")}`,
            },
        };
    }

    const requestedMediaKinds = [
        ...parseCsvQuery(query.slot ?? query.slots ?? query.mediaKind ?? query.mediaKinds),
    ].map(normalizeMediaKindToken);

    const invalidMediaKinds = requestedMediaKinds.filter(
        (value) => !(ALLOWED_MEDIA_KINDS as readonly string[]).includes(value),
    );
    if (invalidMediaKinds.length > 0) {
        return {
            error: {
                error: "Invalid media kind filter",
                message: `Unsupported queue history media kinds: ${invalidMediaKinds.join(", ")}`,
            },
        };
    }

    return {
        value: {
            outcomes: requestedOutcomes as QueueHistoryOutcomeFilter[],
            mediaKinds: requestedMediaKinds as QueueHistoryMediaKindFilter[],
        },
    };
}
