/**
 * Which Release Groups enter a curated discography, and which Editions of them
 * automatic curation may choose.
 *
 * Two independent questions, deliberately kept apart:
 *
 *  - **Release Group type** decides whether the *work* belongs in the
 *    discography at all. An excluded type means the Release Group is not
 *    curated.
 *  - **Release status** decides which *Editions* automatic curation may pick.
 *    It never deletes a Release Group: a group stays eligible while it has at
 *    least one status-eligible Edition, and ineligible Editions remain stored,
 *    visible, usable as matching evidence, and available to monitor by hand.
 *
 * The vocabularies are MusicBrainz's own, read from the corpus rather than
 * transcribed: 5 primary types, 12 secondary types, 7 statuses. Counts in the
 * comments below are corpus-wide Release Group / Release counts.
 *
 * Secondary types follow Lidarr's semantics exactly:
 *
 *     albums.Where(album => primaryTypes.Contains(album.Type) &&
 *         ((!album.SecondaryTypes.Any() && secondaryTypes.Contains("Studio")) ||
 *          album.SecondaryTypes.Any(x => secondaryTypes.Contains(x))))
 *
 * — one enabled secondary type is enough. MusicBrainz asks editors to assign
 * every applicable type, so a secondary type is a facet, not a category: a
 * "Live + Spokenword" record is a live record that also has speech, and
 * enabling Live means wanting it. Rejecting on any disabled facet instead would
 * lose 2,322 `Live + Spokenword` and 464 `Compilation + Spokenword` groups to
 * spare ~700 `Audio drama + …` ones. Only 0.9% of Release Groups carry more
 * than one secondary type at all, so this is a narrow question either way.
 *
 * `Studio` is that rule's representation of the empty set — the reason Lidarr
 * has it, and why it is a filter-side concept only. It is never a MusicBrainz
 * value, is never stored, and never reaches a written tag.
 *
 * Defaults are permissive where Lidarr's are restrictive. Lidarr's stock
 * profile allows Album + Studio + Official only — an opt-in discography.
 * Discogenius aims at full coverage of an artist's work filtered *down* by
 * preference. Status is the one place we fail closed, because a bootleg or a
 * pseudo-release is a worse copy of a record the user already gets, not
 * additional coverage.
 */
import type { FilteringConfig } from "../config/config.js";

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

/**
 * MusicBrainz's five primary types. There is no sixth.
 *
 * 99,535 Release Groups have no primary type, and a future MusicBrainz addition
 * would be a value this build does not know. Both read as `Other` — "not one of
 * the four named kinds" — rather than getting a category of their own. An
 * untyped Release Group is one MusicBrainz cannot describe, and with `Other`
 * shipping off, not curating it automatically is the honest default.
 */
const PRIMARY_TYPE_CONFIG_KEYS: Record<string, keyof FilteringConfig> = {
    album: "include_album",          // 2,278,381
    single: "include_single",        // 1,355,220
    ep: "include_ep",                //   563,504
    other: "include_other",          //    62,655
    broadcast: "include_broadcast",  //    26,573
};

/** MusicBrainz's twelve secondary types, complete. */
const SECONDARY_TYPE_CONFIG_KEYS: Record<string, keyof FilteringConfig> = {
    compilation: "include_compilation",            // 486,796
    live: "include_live",                          // 154,884
    soundtrack: "include_soundtrack",              //  93,327
    remix: "include_remix",                        //  74,533
    demo: "include_demo",                          //  36,659
    "dj-mix": "include_dj_mix",                    //  33,225
    "mixtape/street": "include_mixtape_street",    //  17,940
    audiobook: "include_audiobook",                //  18,987
    spokenword: "include_spokenword",              //  17,636
    "audio-drama": "include_audio_drama",          //  16,111
    interview: "include_interview",                //   3,735
    "field-recording": "include_field_recording",  //     861
};

/**
 * MusicBrainz's seven release statuses, plus the unset case.
 *
 * 275,102 releases carry no status. Treating that as ineligible would open a
 * silent coverage hole, so it gets its own toggle and ships on.
 */
const RELEASE_STATUS_CONFIG_KEYS: Record<string, keyof FilteringConfig> = {
    official: "include_status_official",              // 5,082,652
    promotion: "include_status_promotion",            //   117,616
    bootleg: "include_status_bootleg",                //    98,022
    "pseudo-release": "include_status_pseudo_release", //   25,610
    withdrawn: "include_status_withdrawn",            //    10,806
    cancelled: "include_status_cancelled",            //       559
    expunged: "include_status_expunged",              //       333
};

export function normalizeMusicBrainzType(value: unknown): string {
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
        case "pseudo-release":
        case "pseudorelease":
        case "pseudo":
            return "pseudo-release";
        default:
            return normalized;
    }
}

export function parseMusicBrainzSecondaryTypes(value: unknown): string[] {
    if (Array.isArray(value)) {
        return value.map(normalizeMusicBrainzType).filter(Boolean);
    }

    const raw = String(value || "").trim();
    if (!raw) {
        return [];
    }

    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed)
            ? parsed.map(normalizeMusicBrainzType).filter(Boolean)
            : [];
    } catch {
        return raw
            .split(/[;,]/)
            .map(normalizeMusicBrainzType)
            .filter(Boolean);
    }
}

/**
 * The primary type as MusicBrainz states it, or `""` when it states none.
 *
 * Deliberately does not fall back to `album`. A Release Group with no type is
 * not an album we happen not to have labelled; calling it one admits it under a
 * toggle the user pointed at albums.
 */
function getPrimaryType(input: ReleaseGroupFilterInput): string {
    return normalizeMusicBrainzType(input.primary_type ?? input.album_type);
}

function getPrimaryIncludeDecision(
    primaryType: string,
    filteringConfig: FilteringConfig,
): IncludeDecision {
    // Untyped and unrecognized alike read as `Other`; see the note on the key map.
    const configKey = PRIMARY_TYPE_CONFIG_KEYS[primaryType] ?? "include_other";
    const include = filteringConfig[configKey] === true;
    if (include) return { include: true, reason: null };
    const label = primaryType ? primaryType.replace(/\W+/g, "_") : "untyped";
    return { include: false, reason: `${label}_excluded` };
}

/**
 * Lidarr's rule: no secondary types means `Studio`, otherwise one enabled type
 * is enough.
 *
 * A type this build does not recognise counts as enabled. It cannot veto under
 * these semantics anyway, and letting it stand alone would mean a future
 * MusicBrainz addition silently deleting Release Groups nobody chose to
 * exclude. MusicBrainz has added twelve secondary types in twenty years, so the
 * permissive side of that trade costs approximately nothing.
 */
function getSecondaryIncludeDecision(
    secondaryTypes: readonly string[],
    filteringConfig: FilteringConfig,
): IncludeDecision {
    if (secondaryTypes.length === 0) {
        const include = filteringConfig.include_studio !== false;
        return { include, reason: include ? null : "studio_excluded" };
    }

    const enabled = secondaryTypes.some((secondaryType) => {
        const configKey = SECONDARY_TYPE_CONFIG_KEYS[secondaryType];
        return configKey ? filteringConfig[configKey] === true : true;
    });
    if (enabled) return { include: true, reason: null };
    return {
        include: false,
        reason: `${secondaryTypes[0].replace(/\W+/g, "_")}_excluded`,
    };
}

/**
 * Whether automatic curation may choose an Edition with this release status.
 *
 * Edition eligibility only. An ineligible Edition stays in the database, stays
 * on the Album page, stays usable as matching evidence, and can still be
 * monitored by hand — a manual or locked selection outranks this entirely.
 */
export function getReleaseStatusIncludeDecision(
    status: string | null | undefined,
    filteringConfig: FilteringConfig,
): IncludeDecision {
    const normalized = normalizeMusicBrainzType(status);
    if (!normalized) {
        const include = filteringConfig.include_status_unknown !== false;
        return { include, reason: include ? null : "unset_status_excluded" };
    }

    const configKey = RELEASE_STATUS_CONFIG_KEYS[normalized];
    if (!configKey) {
        // Same reasoning as an unrecognized type: a status MusicBrainz added
        // after this build must not quietly remove Editions.
        const include = filteringConfig.include_status_unknown !== false;
        return {
            include,
            reason: include ? null : `${normalized.replace(/\W+/g, "_")}_unrecognized_excluded`,
        };
    }

    const include = filteringConfig[configKey] === true;
    return { include, reason: include ? null : `status_${normalized.replace(/\W+/g, "_")}_excluded` };
}

/**
 * Preference rank for an Edition's release status; higher wins a tie.
 *
 * Only meaningful among statuses that are already eligible. Official outranks
 * every other enabled status, and an unset status ranks below both — it is the
 * absence of a claim, not a claim of officialness.
 */
export function releaseStatusPreferenceRank(status: string | null | undefined): number {
    const normalized = normalizeMusicBrainzType(status);
    if (!normalized) return 0;
    return normalized === "official" ? 2 : 1;
}

export function isReleaseStatusIncluded(
    status: string | null | undefined,
    filteringConfig: FilteringConfig,
): boolean {
    return getReleaseStatusIncludeDecision(status, filteringConfig).include;
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

    return getSecondaryIncludeDecision(
        parseMusicBrainzSecondaryTypes(input.secondary_types),
        filteringConfig,
    );
}

export function isMusicBrainzReleaseGroupIncluded(
    input: ReleaseGroupFilterInput,
    filteringConfig: FilteringConfig,
): boolean {
    return getMusicBrainzReleaseGroupIncludeDecision(input, filteringConfig).include;
}
