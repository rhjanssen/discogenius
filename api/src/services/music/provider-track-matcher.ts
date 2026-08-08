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
 * Design follows the DistanceCalculator.TrackDistance: combine duration
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

export interface TrackMatchOptions {
    /**
     * A provider album that is already strongly bound to this exact canonical
     * release may expose a superset whose relevant edition starts at a later
     * provider position. Some providers also flatten every remix/version title
     * to the base title. Callers must only enable this for that verified
     * same-release superset context; it is intentionally unsafe as a global
     * fallback.
     */
    allowSameReleaseSupersetPositionMismatch?: boolean;
}

export interface RankedTrackMatchEdge<TSource> {
    sourceKey: string;
    source: TSource;
    matchScore: number;
}

/**
 * How a match was established, strongest evidence first. The rank orders
 * *evidence*, not score: a structural match at 0.95 is better evidence than a
 * title/duration coincidence at 0.95, and ambiguity is judged within a tier so
 * a weak title rival can never cast doubt on a proven slot.
 */
export type TrackMatchMethod =
    | "external_id"
    | "medium_position_duration"
    | "title_duration"
    | "none";

const METHOD_RANK: Record<TrackMatchMethod, number> = {
    external_id: 0,
    medium_position_duration: 1,
    title_duration: 2,
    none: 3,
};

export function trackMatchMethodRank(method: TrackMatchMethod): number {
    return METHOD_RANK[method];
}

export interface TrackMatchEvidence {
    score: number;
    method: TrackMatchMethod;
}

/**
 * Deterministic maximum-cardinality, maximum-weight one-to-one assignment.
 *
 * Cardinality dominates: every additional canonical track covered is worth more
 * than any achievable sum of scores, so the solver never trades coverage for a
 * prettier score. Among assignments of equal cardinality it maximises total
 * confidence, which the previous greedy augmenting path could not guarantee —
 * that approach kept full coverage while settling for lower-confidence edges
 * whenever the augmenting order happened to reach a contested source first.
 *
 * Implemented as the O(n^3) Hungarian shortest-augmenting-path assignment.
 * Track lists are small (tens, rarely hundreds), so this is cheap and avoids a
 * dependency.
 *
 * Determinism under input reordering comes from canonicalising the source order
 * by sourceKey before solving: the solver is deterministic given its input, so
 * a stable input order gives a stable result regardless of how the caller
 * happened to collect the edges.
 */
export function assignRankedTrackMatches<TEdge extends RankedTrackMatchEdge<unknown>>(
    edgesByTarget: Array<Array<TEdge>>,
): Map<number, TEdge> {
    const targetCount = edgesByTarget.length;
    if (targetCount === 0) return new Map();

    // Canonical source ordering: sourceKey ascending.
    const bySourceKey = new Map<string, TEdge>();
    for (const edges of edgesByTarget) {
        for (const edge of edges || []) {
            if (!bySourceKey.has(edge.sourceKey)) bySourceKey.set(edge.sourceKey, edge);
        }
    }
    const sourceKeys = [...bySourceKey.keys()].sort((left, right) => left.localeCompare(right));
    const sourceIndexByKey = new Map(sourceKeys.map((key, index) => [key, index]));
    const sourceCount = sourceKeys.length;
    if (sourceCount === 0) return new Map();

    // Best edge per (target, source) pair. COVERAGE_WEIGHT must exceed the
    // largest achievable score sum so one extra assignment always beats any
    // redistribution of confidence.
    const SCORE_SCALE = 1_000_000;
    const COVERAGE_WEIGHT = SCORE_SCALE * (targetCount + 1);
    const edgeAt = new Map<number, TEdge>();
    const key = (targetIndex: number, sourceIndex: number) => targetIndex * sourceCount + sourceIndex;
    for (let targetIndex = 0; targetIndex < targetCount; targetIndex += 1) {
        for (const edge of edgesByTarget[targetIndex] || []) {
            const sourceIndex = sourceIndexByKey.get(edge.sourceKey);
            if (sourceIndex == null) continue;
            const existing = edgeAt.get(key(targetIndex, sourceIndex));
            if (!existing || edge.matchScore > existing.matchScore) {
                edgeAt.set(key(targetIndex, sourceIndex), edge);
            }
        }
    }
    if (edgeAt.size === 0) return new Map();

    // Rectangular Hungarian needs rows <= cols; pad columns with dummies.
    const rows = targetCount;
    const cols = Math.max(sourceCount, targetCount);
    const INF = Number.POSITIVE_INFINITY;
    const cost = (row: number, col: number): number => {
        if (col >= sourceCount) return 0;
        const edge = edgeAt.get(key(row, col));
        // Minimisation: negate, so a real edge is strongly preferred over none.
        return edge ? -(COVERAGE_WEIGHT + Math.round(edge.matchScore * SCORE_SCALE)) : 0;
    };

    const u = new Float64Array(rows + 1);
    const v = new Float64Array(cols + 1);
    const p = new Int32Array(cols + 1); // p[col] = row assigned to col (1-based), 0 = free
    const way = new Int32Array(cols + 1);

    for (let row = 1; row <= rows; row += 1) {
        p[0] = row;
        let j0 = 0;
        const minv = new Float64Array(cols + 1).fill(INF);
        const used = new Uint8Array(cols + 1);
        do {
            used[j0] = 1;
            const i0 = p[j0];
            let delta = INF;
            let j1 = 0;
            for (let j = 1; j <= cols; j += 1) {
                if (used[j]) continue;
                const cur = cost(i0 - 1, j - 1) - u[i0] - v[j];
                if (cur < minv[j]) {
                    minv[j] = cur;
                    way[j] = j0;
                }
                if (minv[j] < delta) {
                    delta = minv[j];
                    j1 = j;
                }
            }
            for (let j = 0; j <= cols; j += 1) {
                if (used[j]) {
                    u[p[j]] += delta;
                    v[j] -= delta;
                } else {
                    minv[j] -= delta;
                }
            }
            j0 = j1;
        } while (p[j0] !== 0);
        do {
            const j1 = way[j0];
            p[j0] = p[j1];
            j0 = j1;
        } while (j0);
    }

    const assignedEdge = new Map<number, TEdge>();
    for (let col = 1; col <= cols; col += 1) {
        const row = p[col];
        if (!row) continue;
        if (col - 1 >= sourceCount) continue; // padded dummy column
        const edge = edgeAt.get(key(row - 1, col - 1));
        if (edge) assignedEdge.set(row - 1, edge);
    }
    return assignedEdge;
}

/** Lidarr uses a 10-second grace before penalizing a duration difference. */
const DURATION_GRACE_SEC = 10;

/**
 * Beyond this, two runtimes describe different content and no amount of title
 * similarity may say otherwise.
 *
 * The grace above is the tolerance for the *same* recording measured twice. This
 * is a far looser bar with a different job: vetoing the weak title-dominant
 * fallback, which scores on title and only awards duration a bonus, so a
 * disagreement of any size could be outvoted by a similar title. On Amy
 * Winehouse's Frank that assigned the Japanese release's "Amy Amy Amy" (4:15) to
 * the canonical "Amy Amy Amy / Outro" (13:17) — position 13 on both sides and
 * the titles nearly identical, nine minutes of content apart.
 *
 * A minute is deliberately generous: radio edits, fade differences and CD index
 * shifts all land well inside it (Frank's own Moody's Mood/Take the Box index
 * shift is 38s), while a track that swallowed a second song does not.
 */
const GROSS_DURATION_MISMATCH_SEC = 60;

/** Provider tracks scoring at or above this are treated as the same recording. */
export const TRACK_MATCH_THRESHOLD = 0.55;

/**
 * The version of the track-matching *decision*, bumped whenever this module's
 * verdicts change.
 *
 * A stored ProviderTrackMatch is a cached decision, and refresh reuses stored
 * tracklists rather than re-fetching them — so without a version to compare
 * against, an improved matcher only ever reaches releases the provider happened
 * to return again. Amy Winehouse's Frank kept a match asserting that a 4:15
 * "Amy Amy Amy" was the canonical 13:17 "Amy Amy Amy / Outro" through a full
 * refresh, matching and curation cycle, because that release was already
 * materialised and nothing asked the question again.
 *
 * Bump this in the same commit as any change to describeTrackMatch or the title
 * helpers it depends on. Matching then replays over stored rows for anything
 * still carrying an older verdict — no provider traffic, just the decision.
 *
 * 2: dash-suffixed version qualifiers ("… - ARTE Live at …") are read as
 *    qualifiers, and a gross duration mismatch vetoes the title-only fallback.
 */
export const PROVIDER_TRACK_MATCHER_VERSION = 2;

function normalizeIsrc(value: string | null | undefined): string {
    return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Score how confidently a provider track is the same recording as a target
 * MusicBrainz track, and report which evidence established it. Range 0..1;
 * >= TRACK_MATCH_THRESHOLD counts as a match.
 *
 * The method matters beyond bookkeeping: ambiguity is judged within an evidence
 * tier, so a proven slot is not talked out of a match by a title coincidence.
 */
export function describeTrackMatch(
    target: MatchTargetTrack,
    pt: MatchProviderTrack,
    options: TrackMatchOptions = {},
): TrackMatchEvidence {
    // 1. Deterministic identifiers win outright.
    if (target.recordingMbid && pt.mbid && target.recordingMbid === pt.mbid) {
        return { score: 1.0, method: "external_id" };
    }
    const providerIsrc = normalizeIsrc(pt.isrc);
    if (providerIsrc && target.isrcs.has(providerIsrc)) {
        return { score: 1.0, method: "external_id" };
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
    //    Require a *strong* title signal here: Levenshtein similarity of ~0.3 is
    //    common for unrelated short titles of similar length (e.g. "World Gone
    //    Mad" vs "Distorted Light Beam"), and that used to promote a false 0.95
    //    cover that beat the barcode-matched single on HIRES quality.
    //
    //    When both sides know duration, always require the 10s grace. Skipping
    //    that accepted Bakermat "The Spirit (commentary)" (47s, pos 1) against
    //    the standard-album song "The Spirit" (136s, pos 1) on a source_subset
    //    match — base titles agree and slots align, but the recording is wrong.
    const durationOk = !durationKnown || durationClose;
    if ((versionsOk || oneSidedStructurallyConfirmed) && positionAligned && baseMatch && durationOk) {
        return { score: 0.95, method: "medium_position_duration" };
    }
    if (versionsOk && positionAligned && durationClose && titleSim >= 0.55) {
        return { score: 0.95, method: "medium_position_duration" };
    }
    // 3. Title + duration agree but the position differs — the case when a
    //    standalone single is combined into an album to cover a target. A
    //    one-sided version claim is deliberately NOT eligible here: this exact
    //    path assigned a studio track to "… (live at Kalkscheune, Berlin)"
    //    purely on a coincidental runtime.
    if (versionsOk && baseMatch && durationClose) {
        return { score: 0.9, method: "title_duration" };
    }
    // A small number of provider releases are supersets containing several
    // editions back-to-back while flattening their displayed titles (for
    // example all "Reality (... remix)" tracks become simply "Reality").
    // Position cannot corroborate those tracks, but an exact/near-exact runtime
    // can once the caller has independently established this is the same
    // release. Preserve a duration gradient so the one-to-one assignment picks
    // the exact later block instead of a merely close track from another block.
    if (
        options.allowSameReleaseSupersetPositionMismatch
        && oneSidedVersion
        && baseMatch
        && durationClose
    ) {
        return {
            score: Number((0.9 + (1 - (durationDiff / DURATION_GRACE_SEC)) * 0.04).toFixed(3)),
            method: "title_duration",
        };
    }

    // 4. Blended fallback (title is the dominant signal, structure
    //    only corroborates). Title is weighted so that position + duration alone
    //    cannot carry a match when the titles actively contradict — that avoids
    //    false coverage when two different songs share a slot and a coincidental
    //    runtime. A strong title with structural agreement still clears the bar.
    // Duration gets a veto here, not just a bonus. Every path above requires
    // runtimes to agree; this one scores on title and lets structure top it up,
    // so without a veto a near-identical title outvotes any disagreement at all.
    if (durationKnown && durationDiff > GROSS_DURATION_MISMATCH_SEC) {
        return { score: 0, method: "none" };
    }
    const structuralBonus = versionsOk ? (positionAligned ? 0.15 : 0) + (durationClose ? 0.1 : 0) : 0;
    const blended = Math.min(1, titleSim * 0.75 + structuralBonus);
    // Conflicting significant versions can still share enough base-title text to
    // drift over the threshold; hold them just under it so they never count as
    // the same recording on title alone.
    const score = versionsOk ? blended : Math.min(blended, TRACK_MATCH_THRESHOLD - 0.05);
    return {
        score,
        method: score >= TRACK_MATCH_THRESHOLD ? "title_duration" : "none",
    };
}

/**
 * Score-only view of {@link describeTrackMatch}, for callers that rank on
 * confidence alone.
 */
export function scoreTrackMatch(
    target: MatchTargetTrack,
    pt: MatchProviderTrack,
    options: TrackMatchOptions = {},
): number {
    return describeTrackMatch(target, pt, options).score;
}

export function isTrackMatch(target: MatchTargetTrack, pt: MatchProviderTrack): boolean {
    return scoreTrackMatch(target, pt) >= TRACK_MATCH_THRESHOLD;
}
