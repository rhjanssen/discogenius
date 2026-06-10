import { normalizeComparableText, stringSimilarity } from "../import-matching-utils.js";

export type ProviderAlbumForReleaseGroupMatching = {
    providerId: string;
    title: string;
    version?: string | null;
    releaseDate?: string | null;
    type?: string | null;
    upc?: string | null;
    isrcs?: string[] | null;
    trackCount?: number | null;
    volumeCount?: number | null;
};

export type MusicBrainzReleaseForMatching = {
    mbid: string;
    title?: string | null;
    barcode?: string | null;
    date?: string | null;
    trackCount?: number | null;
    mediaCount?: number | null;
    isrcs?: string[] | null;
};

export type MusicBrainzReleaseGroupForMatching = {
    mbid: string;
    title: string;
    primaryType?: string | null;
    secondaryTypes?: string[] | null;
    firstReleaseDate?: string | null;
    disambiguation?: string | null;
    releases?: MusicBrainzReleaseForMatching[];
};

export type ProviderReleaseGroupMatchStatus = "verified" | "probable" | "ambiguous" | "unmatched";

export type ProviderReleaseGroupMatch = {
    providerId: string;
    status: ProviderReleaseGroupMatchStatus;
    confidence: number;
    method: string;
    releaseMbid?: string | null;
    releaseGroup?: MusicBrainzReleaseGroupForMatching;
    evidence: {
        providerTitle: string;
        providerVersion?: string | null;
        providerReleaseDate?: string | null;
        providerType?: string | null;
        candidateTitle?: string | null;
        titleScore?: number;
        titleExpansionMatched?: boolean;
        yearMatched?: boolean;
        typeMatched?: boolean;
        upcMatched?: boolean;
        isrcOverlap?: number;
        trackCountMatched?: boolean;
        volumeCountMatched?: boolean;
        providerTrackCount?: number | null;
        targetTrackCount?: number | null;
        providerVolumeCount?: number | null;
        targetVolumeCount?: number | null;
        matchedReleaseMbid?: string | null;
        availableReleaseMbids?: string[];
        ambiguousWith?: string[];
    };
};

function yearOf(value?: string | null): string | null {
    const match = String(value || "").match(/^\d{4}/);
    return match ? match[0] : null;
}

function normalizeType(value?: string | null): string {
    const normalized = String(value || "").trim().toLowerCase();
    if (normalized === "album" || normalized === "ep" || normalized === "single") {
        return normalized;
    }
    return normalized;
}

function normalizeBarcode(value?: string | null): string {
    return String(value || "").replace(/\D+/g, "");
}

function normalizeIsrc(value?: string | null): string {
    return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function addNormalizedCandidate(candidates: string[], value?: string | null): void {
    const normalized = normalizeComparableText(value);
    if (normalized) {
        candidates.push(normalized);
    }
}

function stripEditionSuffixes(value: string): string {
    return value
        .replace(/\b(?:deluxe|expanded|extended|special|complete|anniversary|bonus|remaster(?:ed)?|reissue|clean|explicit|dolby\s+atmos|atmos|spatial|hi-?res|lossless|stereo)\s+(?:edition|version|bonus tracks?|mix)?\b.*$/i, " ")
        .replace(/\b(?:deluxe|expanded|extended|special|complete|anniversary|bonus|remaster(?:ed)?|reissue|clean|explicit|dolby\s+atmos|atmos|spatial|hi-?res|lossless|stereo)\b.*$/i, " ")
        .trim();
}

function splitExpandedTitleParts(value: string): string[] {
    return value
        .split(/\s*(?:\+|\/|\\|\|)\s*/g)
        .map((part) => part.trim())
        .filter(Boolean);
}

function prefixBeforeVersionSeparator(value: string): string | null {
    const match = value.match(/^(.+?)\s+(?:[-:–—])\s+(.+)$/u);
    if (!match?.[1] || !match?.[2]) {
        return null;
    }

    const suffix = match[2].trim();
    if (!/(?:deluxe|expanded|extended|special|complete|anniversary|bonus|remaster(?:ed)?|reissue|clean|explicit|dolby\s+atmos|atmos|spatial|hi-?res|lossless|stereo|dreams?\b|past\b)/i.test(suffix)) {
        return null;
    }

    return match[1].trim();
}

function expandedTitleCandidates(value?: string | null): string[] {
    const text = String(value || "").trim();
    if (!text) {
        return [];
    }

    const candidates: string[] = [];
    addNormalizedCandidate(candidates, text);
    addNormalizedCandidate(candidates, stripEditionSuffixes(text));
    addNormalizedCandidate(candidates, prefixBeforeVersionSeparator(text));

    for (const part of splitExpandedTitleParts(text)) {
        addNormalizedCandidate(candidates, part);
        addNormalizedCandidate(candidates, stripEditionSuffixes(part));
        addNormalizedCandidate(candidates, prefixBeforeVersionSeparator(part));
    }

    return Array.from(new Set(candidates));
}

function providerTitleCandidates(album: ProviderAlbumForReleaseGroupMatching): string[] {
    const candidates = [
        ...expandedTitleCandidates(album.title),
        ...(album.version ? expandedTitleCandidates(`${album.title} ${album.version}`) : []),
        ...(album.version ? expandedTitleCandidates(`${album.title} (${album.version})`) : []),
    ].filter(Boolean);

    return Array.from(new Set(candidates));
}

function titleCandidatesForReleaseGroup(releaseGroup: MusicBrainzReleaseGroupForMatching): string[] {
    const rawTitle = String(releaseGroup.title || "").trim();
    const candidates = [
        ...expandedTitleCandidates(rawTitle),
        ...expandedTitleCandidates(releaseGroup.disambiguation),
        ...(releaseGroup.releases || []).flatMap((release) => expandedTitleCandidates(release.title)),
    ].filter((value): value is string => Boolean(value));

    // MusicBrainz can use symbolic release-group names. Provider APIs often
    // expose the spoken title instead, e.g. MB "&" vs TIDAL "Ampersand".
    if (/^[\s"'“”‘’]*&[\s"'“”‘’]*$/u.test(rawTitle)) {
        candidates.push("ampersand");
    }

    return Array.from(new Set(candidates));
}

function scoreTitle(providerTitle: string, releaseGroupTitle: string): number {
    if (!providerTitle || !releaseGroupTitle) {
        return 0;
    }
    if (providerTitle === releaseGroupTitle) {
        return 1;
    }
    if (providerTitle.startsWith(`${releaseGroupTitle} `)) {
        return 0.9;
    }
    if (releaseGroupTitle.startsWith(`${providerTitle} `)) {
        return 0.82;
    }
    return stringSimilarity(providerTitle, releaseGroupTitle);
}

function nearestNumericMatch(
    value: number | null | undefined,
    candidates: Array<number | null | undefined>,
): { matched: boolean; target: number | null; delta: number | null; ratio: number | null } {
    const normalized = Number(value || 0);
    const validCandidates = candidates
        .map((candidate) => Number(candidate || 0))
        .filter((candidate) => Number.isFinite(candidate) && candidate > 0);

    if (!Number.isFinite(normalized) || normalized <= 0 || validCandidates.length === 0) {
        return { matched: false, target: null, delta: null, ratio: null };
    }

    const best = validCandidates
        .map((candidate) => ({
            target: candidate,
            delta: Math.abs(candidate - normalized),
        }))
        .sort((left, right) => left.delta - right.delta || right.target - left.target)[0];

    return {
        matched: best.delta === 0,
        target: best.target,
        delta: best.delta,
        ratio: best.delta / Math.max(1, best.target),
    };
}

function scoreAlbumAgainstReleaseGroup(
    album: ProviderAlbumForReleaseGroupMatching,
    releaseGroup: MusicBrainzReleaseGroupForMatching,
) {
    const releases = Array.isArray(releaseGroup.releases) ? releaseGroup.releases : [];
    const providerUpc = normalizeBarcode(album.upc);
    const matchedReleaseByUpc = providerUpc
        ? releases.find((release) => normalizeBarcode(release.barcode) === providerUpc)
        : undefined;
    const providerIsrcs = new Set((album.isrcs || []).map(normalizeIsrc).filter(Boolean));
    let bestIsrcRelease: any = undefined;
    let maxIsrcOverlap = 0;
    if (providerIsrcs.size > 0) {
        for (const release of releases) {
            const releaseIsrcsSet = new Set((release.isrcs || []).map(normalizeIsrc).filter(Boolean));
            let overlap = 0;
            for (const isrc of providerIsrcs) {
                if (releaseIsrcsSet.has(isrc)) {
                    overlap++;
                }
            }
            if (overlap > 0) {
                if (overlap > maxIsrcOverlap) {
                    maxIsrcOverlap = overlap;
                    bestIsrcRelease = release;
                } else if (overlap === maxIsrcOverlap && bestIsrcRelease) {
                    const currentDiff = Math.abs((bestIsrcRelease.trackCount || 0) - (album.trackCount || 0));
                    const newDiff = Math.abs((release.trackCount || 0) - (album.trackCount || 0));
                    if (newDiff < currentDiff) {
                        bestIsrcRelease = release;
                    }
                }
            }
        }
    }
    const isrcOverlap = maxIsrcOverlap;
    const trackCountEvidence = nearestNumericMatch(album.trackCount, releases.map((release) => release.trackCount));
    const volumeCountEvidence = nearestNumericMatch(album.volumeCount, releases.map((release) => release.mediaCount));
    const trackCountMatched = trackCountEvidence.matched;
    const volumeCountMatched = volumeCountEvidence.matched;
    const releaseGroupTitleCandidates = titleCandidatesForReleaseGroup(releaseGroup);
    const titleScores = providerTitleCandidates(album)
        .flatMap((candidateTitle) => releaseGroupTitleCandidates.map((releaseGroupTitle) => ({
            candidateTitle,
            titleScore: scoreTitle(candidateTitle, releaseGroupTitle),
        })))
        .sort((left, right) => right.titleScore - left.titleScore);
    const bestTitle = titleScores[0] || { candidateTitle: null, titleScore: 0 };
    const normalizedProviderTitle = normalizeComparableText(album.title);
    const titleExpansionMatched = Boolean(
        bestTitle.titleScore === 1
        && bestTitle.candidateTitle
        && normalizedProviderTitle
        && bestTitle.candidateTitle !== normalizedProviderTitle
        && normalizedProviderTitle.startsWith(`${bestTitle.candidateTitle} `),
    );
    const expandedCompatibleReleases = titleExpansionMatched
        ? releases.filter((release) => {
            const trackCount = Number(release.trackCount || 0);
            const mediaCount = Number(release.mediaCount || 0);
            const providerTrackCount = Number(album.trackCount || 0);
            const providerVolumeCount = Number(album.volumeCount || 0);
            const trackCompatible = !providerTrackCount || !trackCount || providerTrackCount >= trackCount;
            const volumeCompatible = !providerVolumeCount || !mediaCount || providerVolumeCount >= mediaCount;
            const nearestTrackCompatible = !trackCountEvidence.target || !trackCount || trackCount === trackCountEvidence.target;
            const nearestVolumeCompatible = !volumeCountEvidence.target || !mediaCount || mediaCount === volumeCountEvidence.target;
            return trackCompatible && volumeCompatible && nearestTrackCompatible && nearestVolumeCompatible;
        })
        : [];
    const availableReleases = matchedReleaseByUpc
        ? [matchedReleaseByUpc]
        : bestIsrcRelease
            ? [bestIsrcRelease]
            : expandedCompatibleReleases.length > 0
                ? expandedCompatibleReleases
                : releases.filter((release) => {
                    const trackCount = Number(release.trackCount || 0);
                    const mediaCount = Number(release.mediaCount || 0);
                    return (!album.trackCount || !trackCount || trackCount === Number(album.trackCount))
                        && (!album.volumeCount || !mediaCount || mediaCount === Number(album.volumeCount));
                });
    const matchedRelease = matchedReleaseByUpc
        || bestIsrcRelease
        || (availableReleases.length === 1 ? availableReleases[0] : undefined);
    const providerYear = yearOf(album.releaseDate);
    const releaseGroupYear = yearOf(releaseGroup.firstReleaseDate);
    const yearMatched = Boolean(providerYear && releaseGroupYear && providerYear === releaseGroupYear);
    const typeMatched = normalizeType(album.type) !== "" && normalizeType(album.type) === normalizeType(releaseGroup.primaryType);

    let confidence = matchedReleaseByUpc ? 0.995 : bestTitle.titleScore;
    if (bestTitle.titleScore >= 0.78 && yearMatched) {
        confidence += 0.06;
    }
    if (bestTitle.titleScore >= 0.78 && typeMatched) {
        confidence += 0.04;
    }
    if (bestTitle.titleScore >= 0.72 && trackCountMatched) {
        confidence += 0.04;
    }
    if (bestTitle.titleScore >= 0.72 && volumeCountMatched) {
        confidence += 0.03;
    }
    if (isrcOverlap > 0) {
        const providerIsrcsCount = providerIsrcs.size;
        const overlapRatio = providerIsrcsCount > 0 ? isrcOverlap / providerIsrcsCount : 0;
        if (overlapRatio >= 0.5 || isrcOverlap >= 2) {
            confidence = Math.max(confidence, 0.85);
            confidence += Math.min(0.15, isrcOverlap * 0.05);
        } else {
            confidence += Math.min(0.05, isrcOverlap * 0.01);
        }
    }

    if (!matchedReleaseByUpc && bestTitle.titleScore >= 0.72) {
        if (!typeMatched && normalizeType(album.type) && normalizeType(releaseGroup.primaryType)) {
            confidence -= 0.12;
        }
        const providerHasExtraTracks = titleExpansionMatched
            && Number(album.trackCount || 0) > 0
            && Number(trackCountEvidence.target || 0) > 0
            && Number(album.trackCount || 0) >= Number(trackCountEvidence.target || 0);
        const providerHasExtraVolumes = titleExpansionMatched
            && Number(album.volumeCount || 0) > 0
            && Number(volumeCountEvidence.target || 0) > 0
            && Number(album.volumeCount || 0) >= Number(volumeCountEvidence.target || 0);
        if (!providerHasExtraTracks && trackCountEvidence.ratio !== null && trackCountEvidence.ratio > 0) {
            confidence -= Math.min(0.32, 0.08 + trackCountEvidence.ratio * 0.36);
        }
        if (!providerHasExtraVolumes && volumeCountEvidence.ratio !== null && volumeCountEvidence.ratio > 0) {
            confidence -= Math.min(0.12, 0.04 + volumeCountEvidence.ratio * 0.12);
        }
    }

    return {
        releaseGroup,
        confidence: Math.max(0, Math.min(1, Number(confidence.toFixed(3)))),
        titleScore: Number(bestTitle.titleScore.toFixed(3)),
        candidateTitle: bestTitle.candidateTitle,
        yearMatched,
        typeMatched,
        upcMatched: Boolean(matchedReleaseByUpc),
        isrcOverlap,
        trackCountMatched,
        volumeCountMatched,
        titleExpansionMatched,
        providerTrackCount: album.trackCount ?? null,
        targetTrackCount: trackCountEvidence.target,
        providerVolumeCount: album.volumeCount ?? null,
        targetVolumeCount: volumeCountEvidence.target,
        matchedReleaseMbid: matchedRelease?.mbid ?? null,
        availableReleaseMbids: availableReleases.map((release) => release.mbid),
    };
}

export function matchProviderAlbumToReleaseGroup(
    album: ProviderAlbumForReleaseGroupMatching,
    releaseGroups: MusicBrainzReleaseGroupForMatching[],
): ProviderReleaseGroupMatch {
    const scored = releaseGroups
        .map((releaseGroup) => scoreAlbumAgainstReleaseGroup(album, releaseGroup))
        .filter((candidate) => candidate.upcMatched || candidate.isrcOverlap >= 1 || candidate.confidence >= 0.78)
        .sort((left, right) =>
            Number(right.upcMatched) - Number(left.upcMatched)
            || right.isrcOverlap - left.isrcOverlap
            || right.titleScore - left.titleScore
            || right.confidence - left.confidence
        );

    const best = scored[0];
    if (!best) {
        return {
            providerId: album.providerId,
            status: "unmatched",
            confidence: 0,
            method: "musicbrainz-release-group-title",
            releaseMbid: null,
            evidence: {
                providerTitle: album.title,
                providerVersion: album.version ?? null,
                providerReleaseDate: album.releaseDate ?? null,
                providerType: album.type ?? null,
                upcMatched: false,
                isrcOverlap: 0,
            },
        };
    }

    const ambiguousWith = scored
        .slice(1)
        .filter((candidate) =>
            !best.upcMatched
            && !candidate.upcMatched
            && best.isrcOverlap === candidate.isrcOverlap
            && best.titleScore - candidate.titleScore <= 0.04
            && best.confidence - candidate.confidence <= 0.04
        )
        .map((candidate) => candidate.releaseGroup.mbid);
    const exactTitleMatch = best.titleScore === 1;
    const exactProviderTitleMatch = exactTitleMatch && !best.titleExpansionMatched;
    const strongIdentityMatch = best.upcMatched || best.isrcOverlap >= 2 || (best.isrcOverlap >= 1 && best.providerTrackCount === 1);
    const status: ProviderReleaseGroupMatchStatus = ambiguousWith.length > 0
        ? "ambiguous"
        : (strongIdentityMatch || (exactProviderTitleMatch && best.confidence >= 0.96))
            ? "verified"
            : "probable";
    const method = best.upcMatched
        ? "musicbrainz-release-upc"
        : best.isrcOverlap >= 1
            ? "musicbrainz-recording-isrc"
            : "musicbrainz-release-group-title-year-type-track-count";

    return {
        providerId: album.providerId,
        status,
        confidence: best.confidence,
        method,
        releaseMbid: best.matchedReleaseMbid,
        releaseGroup: best.releaseGroup,
        evidence: {
            providerTitle: album.title,
            providerVersion: album.version ?? null,
            providerReleaseDate: album.releaseDate ?? null,
            providerType: album.type ?? null,
            candidateTitle: best.candidateTitle,
            titleScore: best.titleScore,
            titleExpansionMatched: best.titleExpansionMatched,
            yearMatched: best.yearMatched,
            typeMatched: best.typeMatched,
            upcMatched: best.upcMatched,
            isrcOverlap: best.isrcOverlap,
            trackCountMatched: best.trackCountMatched,
            volumeCountMatched: best.volumeCountMatched,
            providerTrackCount: best.providerTrackCount,
            targetTrackCount: best.targetTrackCount,
            providerVolumeCount: best.providerVolumeCount,
            targetVolumeCount: best.targetVolumeCount,
            matchedReleaseMbid: best.matchedReleaseMbid,
            availableReleaseMbids: best.availableReleaseMbids,
            ambiguousWith: ambiguousWith.length > 0 ? ambiguousWith : undefined,
        },
    };
}

export function matchProviderAlbumsToReleaseGroups(
    albums: ProviderAlbumForReleaseGroupMatching[],
    releaseGroups: MusicBrainzReleaseGroupForMatching[],
): Map<string, ProviderReleaseGroupMatch> {
    const matches = new Map<string, ProviderReleaseGroupMatch>();
    for (const album of albums) {
        matches.set(album.providerId, matchProviderAlbumToReleaseGroup(album, releaseGroups));
    }
    return matches;
}
