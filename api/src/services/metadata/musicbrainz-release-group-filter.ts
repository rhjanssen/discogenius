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
 * Metadata MusicBrainz has not supplied is not a user preference. A Release
 * Group with no primary type, or an Edition with no release status, is not
 * curated automatically and gets no checkbox — the checkboxes name real
 * MusicBrainz values, and a switch for "things we cannot classify" would invite
 * a choice nobody has the information to make. Both stay stored, visible and
 * monitorable by hand.
 *
 * An empty *secondary* set is the opposite case: it is a positive statement
 * that a release is a plain studio record, not absent metadata, so it passes.
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
 * Lidarr needs a synthetic `Studio` facet because its metadata profile exposes
 * the empty set as a configurable category. Discogenius handles the empty set
 * directly and so does not — if profiles later need "Live albums but not
 * ordinary studio albums", the facet can be added then.
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
 * `Other` is one of them — an affirmative classification an editor chose — and
 * is deliberately *not* where untyped Release Groups go. The 99,535 with no
 * type at all, and any value a later MusicBrainz adds, are handled below
 * without a switch.
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
 * MusicBrainz's seven release statuses. The unset case is not one of them.
 *
 * 275,102 Releases carry no status, and 233,267 Release Groups (5.32%) have no
 * Official Edition but do have an unset one — those become manual-only. That is
 * the accepted cost of "only official releases" meaning what it says.
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
    if (!primaryType) {
        return { include: false, reason: "unclassified_primary_type" };
    }
    const configKey = PRIMARY_TYPE_CONFIG_KEYS[primaryType];
    if (!configKey) {
        // A primary type this build does not know. It follows the unclassified
        // policy rather than masquerading as MusicBrainz's `Other`, and the
        // distinct reason is the signal that the vocabulary has moved on.
        return {
            include: false,
            reason: `unrecognized_primary_type_${primaryType.replace(/\W+/g, "_")}`,
        };
    }
    const include = filteringConfig[configKey] === true;
    return { include, reason: include ? null : `${primaryType}_excluded` };
}

/**
 * No secondary types passes; otherwise one enabled type is enough.
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
    // A plain studio record: the primary type has already answered.
    if (secondaryTypes.length === 0) return { include: true, reason: null };

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
        return { include: false, reason: "unclassified_release_status" };
    }

    const configKey = RELEASE_STATUS_CONFIG_KEYS[normalized];
    if (!configKey) {
        return {
            include: false,
            reason: `unrecognized_release_status_${normalized.replace(/\W+/g, "_")}`,
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
