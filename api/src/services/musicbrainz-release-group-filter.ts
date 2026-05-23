import type { FilteringConfig } from "./config.js";

type ReleaseGroupFilterInput = {
    primary_type?: string | null;
    album_type?: string | null;
    secondary_types?: unknown;
    slot?: string | null;
};

type IncludeDecision = {
    include: boolean;
    reason: string | null;
};

const SECONDARY_TYPE_CONFIG_KEYS: Record<string, keyof FilteringConfig> = {
    compilation: "include_compilation",
    soundtrack: "include_soundtrack",
    spokenword: "include_spokenword",
    interview: "include_interview",
    audiobook: "include_audiobook",
    "audio-drama": "include_audio_drama",
    live: "include_live",
    remix: "include_remix",
    "dj-mix": "include_dj_mix",
    "mixtape/street": "include_mixtape_street",
    demo: "include_demo",
    "field-recording": "include_field_recording",
};

function normalizeMusicBrainzType(value: unknown): string {
    const normalized = String(value || "")
        .trim()
        .toLowerCase()
        .replace(/[_\s]+/g, "-");

    switch (normalized) {
        case "spoken-word":
            return "spokenword";
        case "audio-drama":
        case "audiodrama":
            return "audio-drama";
        case "field-recording":
        case "fieldrecording":
            return "field-recording";
        case "djmix":
        case "dj-mix":
            return "dj-mix";
        case "mixtape":
        case "street":
        case "mixtape-street":
        case "mixtape/street":
            return "mixtape/street";
        default:
            return normalized;
    }
}

export function parseMusicBrainzSecondaryTypes(value: unknown): string[] {
    if (Array.isArray(value)) {
        return value.map(normalizeMusicBrainzType).filter(Boolean);
    }

    try {
        const parsed = JSON.parse(String(value || "[]"));
        return Array.isArray(parsed)
            ? parsed.map(normalizeMusicBrainzType).filter(Boolean)
            : [];
    } catch {
        return [];
    }
}

function getPrimaryType(input: ReleaseGroupFilterInput): string {
    const primary = normalizeMusicBrainzType(input.primary_type ?? input.album_type);
    return primary || "album";
}

function getPrimaryIncludeDecision(primaryType: string, filteringConfig: FilteringConfig): IncludeDecision {
    const configKey = SECONDARY_TYPE_CONFIG_KEYS[primaryType];
    if (configKey) {
        const include = filteringConfig[configKey] === true;
        return {
            include,
            reason: include ? null : `${primaryType}_excluded`,
        };
    }

    switch (primaryType) {
        case "album":
            return {
                include: filteringConfig.include_album !== false,
                reason: filteringConfig.include_album !== false ? null : "album_excluded",
            };
        case "single":
            return {
                include: filteringConfig.include_single === true,
                reason: filteringConfig.include_single === true ? null : "single_excluded",
            };
        case "ep":
            return {
                include: filteringConfig.include_ep !== false,
                reason: filteringConfig.include_ep !== false ? null : "ep_excluded",
            };
        case "broadcast":
            return {
                include: filteringConfig.include_broadcast === true,
                reason: filteringConfig.include_broadcast === true ? null : "broadcast_excluded",
            };
        case "other":
            return {
                include: filteringConfig.include_other === true,
                reason: filteringConfig.include_other === true ? null : "other_excluded",
            };
        default:
            return {
                include: filteringConfig.include_other === true,
                reason: filteringConfig.include_other === true ? null : "other_excluded",
            };
    }
}

function getSecondaryIncludeDecision(secondaryType: string, filteringConfig: FilteringConfig): IncludeDecision {
    const configKey = SECONDARY_TYPE_CONFIG_KEYS[secondaryType];
    if (!configKey) {
        return {
            include: filteringConfig.include_other === true,
            reason: filteringConfig.include_other === true ? null : "secondary_other_excluded",
        };
    }

    const include = filteringConfig[configKey] === true;
    return {
        include,
        reason: include ? null : `${secondaryType.replace(/\W+/g, "_")}_excluded`,
    };
}

export function getMusicBrainzReleaseGroupIncludeDecision(
    input: ReleaseGroupFilterInput,
    filteringConfig: FilteringConfig,
): IncludeDecision {
    if (String(input.slot || "").trim().toLowerCase() === "spatial" && filteringConfig.include_spatial !== true) {
        return { include: false, reason: "spatial_excluded" };
    }

    const primaryDecision = getPrimaryIncludeDecision(getPrimaryType(input), filteringConfig);
    if (!primaryDecision.include) {
        return primaryDecision;
    }

    for (const secondaryType of parseMusicBrainzSecondaryTypes(input.secondary_types)) {
        const secondaryDecision = getSecondaryIncludeDecision(secondaryType, filteringConfig);
        if (!secondaryDecision.include) {
            return secondaryDecision;
        }
    }

    return { include: true, reason: null };
}

export function isMusicBrainzReleaseGroupIncluded(
    input: ReleaseGroupFilterInput,
    filteringConfig: FilteringConfig,
): boolean {
    return getMusicBrainzReleaseGroupIncludeDecision(input, filteringConfig).include;
}
