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
 * Defaults are permissive where Lidarr's are restrictive, and that is
 * deliberate. Lidarr's stock profile allows Album + Studio + Official only —
 * an opt-in discography. Discogenius aims at full coverage of an artist's work
 * filtered *down* by preference, so the type toggles ship on. Status is the one
 * place we fail closed, because a bootleg or a pseudo-release is a worse copy
 * of a record the user already gets, not additional coverage.
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
 * MusicBrainz's five primary types. There is no sixth, and a Release Group may
 * also have none at all — 99,535 of them do, which is why "unknown" is its own
 * classification below rather than being folded into `other`.
 */
const PRIMARY_TYPE_CONFIG_KEYS: Record<string, keyof FilteringConfig> = {
    album: "include_album",          // 2,278,381
    single: "include_single",        // 1,355,220
    ep: "include_ep",                //   563,504
    other: "include_other",          //    62,655
    broadcast: "include_broadcast",  //    26,573
};

/**
 * MusicBrainz's twelve secondary types, complete.
 *
 * The five at the bottom had no config key at all, so every Release Group
 * carrying one was rejected with an `_unsupported` reason the user could not
 * see or change. They keep that outcome by default — the switch is what is new,
 * not the behaviour — because an audiobook or an interview is not music.
 */
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
 * not an album we happen not to have labelled; it is a Release Group whose type
 * nobody has set, and calling it an album both admits it under a toggle the
 * user pointed at albums and hides that the metadata is incomplete.
 */
function getPrimaryType(input: ReleaseGroupFilterInput): string {
    return normalizeMusicBrainzType(input.primary_type ?? input.album_type);
}

/**
 * One switch for "MusicBrainz did not say, or said something this build does
 * not know". Both are the same question for the user — do I want things whose
 * classification is unsettled — and neither is MusicBrainz's `Other`, which is
 * a type an editor chose on purpose.
 */
function unknownTypeDecision(reason: string, filteringConfig: FilteringConfig): IncludeDecision {
    const include = filteringConfig.include_unknown_type !== false;
    return { include, reason: include ? null : reason };
}

function getPrimaryIncludeDecision(
    primaryType: string,
    filteringConfig: FilteringConfig,
): IncludeDecision {
    if (!primaryType) {
        return unknownTypeDecision("unset_primary_type_excluded", filteringConfig);
    }

    const configKey = PRIMARY_TYPE_CONFIG_KEYS[primaryType];
    if (!configKey) {
        return unknownTypeDecision(
            `${primaryType.replace(/\W+/g, "_")}_unrecognized_excluded`,
            filteringConfig,
        );
    }

    const include = filteringConfig[configKey] !== false;
    return { include, reason: include ? null : `${primaryType}_excluded` };
}

function getSecondaryIncludeDecision(
    secondaryType: string,
    filteringConfig: FilteringConfig,
): IncludeDecision {
    const configKey = SECONDARY_TYPE_CONFIG_KEYS[secondaryType];
    if (!configKey) {
        // A type MusicBrainz has added since this build. Silently rejecting it
        // deletes content the user never chose to exclude, so it rides the same
        // switch as an unset type.
        return unknownTypeDecision(
            `${secondaryType.replace(/\W+/g, "_") || "secondary_type"}_unrecognized_excluded`,
            filteringConfig,
        );
    }

    const include = filteringConfig[configKey] === true;
    return { include, reason: include ? null : `${secondaryType.replace(/\W+/g, "_")}_excluded` };
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

    // No "studio" / "no secondary type" toggle. When MusicBrainz records no
    // secondary type, the primary type has already answered the question, and a
    // separate switch would let "Album on, Studio off" silently exclude every
    // plain studio album — a state with no legible meaning. Lidarr models it;
    // we deliberately do not.
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
