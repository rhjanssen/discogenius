import type { FilteringConfig } from "./config.js";

export type MonitoringPassWorkflow = "full-cycle" | "curation-cycle" | "root-scan-cycle";

export function normalizeMonitoringPassWorkflow(workflow?: MonitoringPassWorkflow): MonitoringPassWorkflow | undefined {
    if (workflow === "full-cycle" || workflow === "curation-cycle" || workflow === "root-scan-cycle") {
        return workflow;
    }

    return undefined;
}

export function resolveMonitoringPassWorkflow(value: unknown): MonitoringPassWorkflow | null {
    if (value === "full-cycle" || value === "curation-cycle" || value === "root-scan-cycle") {
        return value;
    }

    return null;
}

export function normalizeArtistIds(artistIds?: string[]) {
    if (!Array.isArray(artistIds)) {
        return undefined;
    }

    const normalized = artistIds.map((value) => String(value).trim()).filter(Boolean);
    return normalized.length > 0 ? normalized : [];
}

/**
 * Get MusicBrainz-style secondary type from module and title.
 */
export function getMbSecondary(module: string | undefined, title: string = ""): string | null {
    const mod = (module || "").toUpperCase();

    if (mod.includes("COMPILATION")) return "compilation";
    if (mod.includes("LIVE")) return "live";
    if (mod.includes("APPEARS_ON")) return "compilation";

    const lowerTitle = (title || "").toLowerCase();

    if (lowerTitle.includes("soundtrack") || lowerTitle.includes("o.s.t.") || lowerTitle.includes("original score")) return "soundtrack";
    if (lowerTitle.includes("remix") || lowerTitle.includes("remixed") || lowerTitle.includes("remixes")) return "remix";
    if (lowerTitle.includes("live at") || lowerTitle.includes("live from") || lowerTitle.includes("in concert") || lowerTitle.includes("(live)")) return "live";
    if (lowerTitle.includes("greatest hits") || lowerTitle.includes("best of") || lowerTitle.includes("anthology")) return "compilation";

    return null;
}

/**
 * Determine if an album should be included based on MusicBrainz-style types and filtering config.
 */
export function getIncludeDecision(
    albumType: string | null | undefined,
    filteringConfig: FilteringConfig,
    module?: string,
    title?: string,
): { include: boolean; reason: string | null } {
    const type = (albumType || "ALBUM").toUpperCase();
    const mbSecondary = getMbSecondary(module, title || "");

    if (mbSecondary) {
        switch (mbSecondary) {
            case "compilation":
                return { include: filteringConfig.include_compilation !== false, reason: filteringConfig.include_compilation !== false ? null : "compilation_excluded" };
            case "soundtrack":
                return { include: filteringConfig.include_soundtrack !== false, reason: filteringConfig.include_soundtrack !== false ? null : "soundtrack_excluded" };
            case "live":
                return { include: filteringConfig.include_live !== false, reason: filteringConfig.include_live !== false ? null : "live_excluded" };
            case "remix":
                return { include: filteringConfig.include_remix !== false, reason: filteringConfig.include_remix !== false ? null : "remix_excluded" };
        }
    }

    switch (type) {
        case "SINGLE":
            return { include: filteringConfig.include_single !== false, reason: filteringConfig.include_single !== false ? null : "single_excluded" };
        case "EP":
            return { include: filteringConfig.include_ep !== false, reason: filteringConfig.include_ep !== false ? null : "ep_excluded" };
        case "ALBUM":
        default:
            return { include: filteringConfig.include_album !== false, reason: filteringConfig.include_album !== false ? null : "album_excluded" };
    }
}

export function parseScheduledTaskTime(raw?: string | null): number | null {
    if (!raw) {
        return null;
    }

    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : null;
}

export function isScheduledTaskDue(intervalMinutes: number, lastQueuedAt?: string | null): boolean {
    const lastQueuedTime = parseScheduledTaskTime(lastQueuedAt ?? null);
    if (lastQueuedTime === null) {
        return true;
    }

    return Date.now() - lastQueuedTime >= intervalMinutes * 60_000;
}

export function getNextMonitoringWindowAtOrAfter(
    minTimestamp: number,
    startHour: number,
    durationHours: number,
): string | null {
    const normalizedDurationHours = Math.max(1, durationHours);
    const normalizedStartHour = Math.max(0, Math.min(23, startHour));
    const candidate = new Date(minTimestamp);
    candidate.setSeconds(0, 0);

    for (let dayOffset = 0; dayOffset < 8; dayOffset += 1) {
        const day = new Date(candidate);
        day.setDate(candidate.getDate() + dayOffset);

        const windowStart = new Date(day);
        windowStart.setHours(normalizedStartHour, 0, 0, 0);

        const windowEnd = new Date(windowStart);
        windowEnd.setHours(windowEnd.getHours() + normalizedDurationHours);

        if (dayOffset === 0) {
            if (minTimestamp < windowStart.getTime()) {
                return windowStart.toISOString();
            }

            if (minTimestamp >= windowStart.getTime() && minTimestamp < windowEnd.getTime()) {
                return new Date(minTimestamp).toISOString();
            }

            continue;
        }

        return windowStart.toISOString();
    }

    return null;
}

export function isWithinTimeWindow(startHour: number, durationHours: number): boolean {
    const now = new Date();
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();
    const currentTimeInMinutes = currentHour * 60 + currentMinute;

    const startTimeInMinutes = startHour * 60;
    const endTimeInMinutes = (startHour + durationHours) * 60;

    if (endTimeInMinutes > 24 * 60) {
        return currentTimeInMinutes >= startTimeInMinutes || currentTimeInMinutes < (endTimeInMinutes % (24 * 60));
    }

    return currentTimeInMinutes >= startTimeInMinutes && currentTimeInMinutes < endTimeInMinutes;
}
