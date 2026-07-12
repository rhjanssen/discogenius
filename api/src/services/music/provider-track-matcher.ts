import {
    baseComparableTitle,
    normalizeComparableText,
    providerTrackComparableTitle,
    stringSimilarity,
    versionQualifierSignature,
    versionsCompatible,
} from "../mediafiles/import-matching-utils.js";

/**
 * The single source of truth for "is this provider track the same recording as
 * this MusicBrainz track?", shared by curation slot selection
 * (release-group-slot-service) and the album-page read service
 * (musicbrainz-release-group-read-service).
 *
 * Two divergent copies of this logic used to disagree: curation counted an
 * album as covered while the UI showed the same tracks as missing. The two
 * call sites store provider tracks in different field shapes (snake_case
 * slot candidates vs camelCase ProviderTrack), so each adapts its data into
 * the normalized shapes below rather than sharing a type.
 *
 * Design mirrors Lidarr's DistanceCalculator.TrackDistance: combine duration
 * (10s grace), position, and a cleaned title — with NO hard title cutoff, so
 * provider title decorations ("(Bastille Vs. …)", "(feat. …)", "(demo)",
 * version suffixes) never produce a false "missing".
 */

export interface MatchTargetTrack {
    /** MusicBrainz recording MBID, when known. */
    recordingMbid: string | null;
    /** Normalized canonical ISRCs for the recording. */
    isrcs: Set<string>;
    title: string;
    /** Position on the medium (1-based). */
    trackNumber: number;
    /** Medium / disc number (1-based). */
    volumeNumber: number;
    durationSec: number | null;
}

export interface MatchProviderTrack {
    mbid: string | null;
    isrc: string | null;
    title: string;
    /** Optional version qualifier (TIDAL exposes a separate `version`). */
    version?: string | null;
    trackNumber: number | null;
    volumeNumber: number | null;
    durationSec: number | null;
}

/** Lidarr uses a 10-second grace before penalizing a duration difference. */
const DURATION_GRACE_SEC = 10;

/** Provider tracks scoring at or above this are treated as the same recording. */
export const TRACK_MATCH_THRESHOLD = 0.55;

function normalizeIsrc(value: string | null | undefined): string {
    return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Score how confidently a provider track is the same recording as a target
 * MusicBrainz track. Range 0..1; >= TRACK_MATCH_THRESHOLD counts as a match.
 */
export function scoreTrackMatch(target: MatchTargetTrack, pt: MatchProviderTrack): number {
    // 1. Deterministic identifiers win outright.
    if (target.recordingMbid && pt.mbid && target.recordingMbid === pt.mbid) {
        return 1.0;
    }
    const providerIsrc = normalizeIsrc(pt.isrc);
    if (providerIsrc && target.isrcs.has(providerIsrc)) {
        return 1.0;
    }

    const positionAligned = Number(target.trackNumber || 0) > 0
        && Number(pt.trackNumber || 0) > 0
        && Number(target.trackNumber) === Number(pt.trackNumber)
        && Number(target.volumeNumber || 1) === Number(pt.volumeNumber || 1);

    const targetDuration = Number(target.durationSec || 0);
    const providerDuration = Number(pt.durationSec || 0);
    const durationKnown = targetDuration > 0 && providerDuration > 0;
    const durationDiff = durationKnown ? Math.abs(targetDuration - providerDuration) : Number.POSITIVE_INFINITY;
    const durationClose = durationKnown && durationDiff <= DURATION_GRACE_SEC;

    const providerComparable = providerTrackComparableTitle(pt);
    const titleSim = stringSimilarity(
        normalizeComparableText(target.title),
        normalizeComparableText(providerComparable),
    );
    const targetBase = baseComparableTitle(target.title);
    const providerBase = baseComparableTitle(providerComparable);
    const baseMatch = Boolean(targetBase) && targetBase === providerBase;
    // A remix/edit/live variant shares the base title and often the track slot,
    // but it is a different recording. When the two carry conflicting significant
    // versions, the structural shortcuts below must not assert a match — this is
    // the only title signal available when the catalog strips UPC/ISRC (Servarr
    // mode), so it also settles offer selection there.
    const versionsOk = versionsCompatible(target.title, providerComparable);
    // Exactly one side names a variant ("Haunt (demo)" vs plain "Haunt"). That
    // happens for the SAME recording (MB qualifies it, the provider doesn't —
    // or vice versa) and for DIFFERENT recordings (a studio track vs its live
    // cut titled "(live at …)"). Structure disambiguates: the same-recording
    // cases occupy the same slot with a close duration; a track combined in
    // from another release does not get to claim a variant title on duration
    // alone, because live/edit cuts routinely share the studio runtime.
    const oneSidedVersion = !versionsOk
        && (versionQualifierSignature(target.title) === "") !== (versionQualifierSignature(providerComparable) === "");
    const oneSidedStructurallyConfirmed = oneSidedVersion && positionAligned && durationClose;

    // 2. Structural-first acceptance. Streaming providers give exact track
    //    positions and durations, so a same-slot match is decisive even when
    //    the displayed title carries extra decoration the canonical title omits.
    //    The `titleSim >= 0.3` guard blocks two genuinely different songs that
    //    merely share a position and a coincidental duration.
    if ((versionsOk || oneSidedStructurallyConfirmed) && positionAligned && baseMatch) {
        return 0.95;
    }
    if (versionsOk && positionAligned && durationClose && titleSim >= 0.3) {
        return 0.95;
    }
    // 3. Title + duration agree but the position differs — the case when a
    //    standalone single is combined into an album to cover a target. A
    //    one-sided version claim is deliberately NOT eligible here: this exact
    //    path assigned a studio track to "… (live at Kalkscheune, Berlin)"
    //    purely on a coincidental runtime.
    if (versionsOk && baseMatch && durationClose) {
        return 0.9;
    }

    // 4. Blended fallback (Lidarr-style: title is the dominant signal, structure
    //    only corroborates). Title is weighted so that position + duration alone
    //    cannot carry a match when the titles actively contradict — that avoids
    //    false coverage when two different songs share a slot and a coincidental
    //    runtime. A strong title with structural agreement still clears the bar.
    const structuralBonus = versionsOk ? (positionAligned ? 0.15 : 0) + (durationClose ? 0.1 : 0) : 0;
    const blended = Math.min(1, titleSim * 0.75 + structuralBonus);
    // Conflicting significant versions can still share enough base-title text to
    // drift over the threshold; hold them just under it so they never count as
    // the same recording on title alone.
    return versionsOk ? blended : Math.min(blended, TRACK_MATCH_THRESHOLD - 0.05);
}

export function isTrackMatch(target: MatchTargetTrack, pt: MatchProviderTrack): boolean {
    return scoreTrackMatch(target, pt) >= TRACK_MATCH_THRESHOLD;
}
