import type { FilteringConfig } from "./config.js";
import { getMusicBrainzReleaseGroupIncludeDecision } from "../metadata/musicbrainz-release-group-filter.js";

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
    if ((module || "").toUpperCase().includes("APPEARS_ON")) {
        return { include: false, reason: "provider_appears_on_excluded" };
    }

    const mbSecondary = getMbSecondary(module, title || "");
    return getMusicBrainzReleaseGroupIncludeDecision({
        primary_type: albumType || "album",
        secondary_types: mbSecondary ? [mbSecondary] : [],
    }, filteringConfig);
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

// NOTE: Discogenius previously gated the monitoring cycle to a start_hour /
// duration_hours time-of-day window. That window only controlled when a cycle
// was *queued* (it never stopped in-flight work) and ran in the container's
// local time, which caused timezone surprises. We now follow Lidarr's model:
// scheduled tasks run purely on their interval in UTC, no time-of-day window.
// The start_hour/duration_hours config fields are retained for backwards
// compatibility but are no longer consulted by the scheduler.
