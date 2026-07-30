import { normalizeComparableText, stringSimilarity } from "../mediafiles/import-matching-utils.js";
import { providerResourceKey } from "./provider-url-identity.js";

export type ProviderAlbumForReleaseGroupMatching = {
    provider?: string | null;
    providerId: string;
    title: string;
    providerUrl?: string | null;
    providerUrls?: string[] | null;
    version?: string | null;
    releaseDate?: string | null;
    type?: string | null;
    quality?: string | null;
    qualityTags?: string[] | null;
    explicit?: boolean | number | null;
    upc?: string | null;
    isrcs?: string[] | null;
    trackCount?: number | null;
    volumeCount?: number | null;
};

export type MusicBrainzReleaseForMatching = {
    mbid: string;
    title?: string | null;
    disambiguation?: string | null;
    externalUrls?: string[] | null;
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

export type ProviderReleaseGroupMatchStatus = "verified" | "probable" | "candidate" | "ambiguous" | "unmatched";

export type ProviderReleaseGroupMatch = {
    providerId: string;
    status: ProviderReleaseGroupMatchStatus;
    confidence: number;
    method: string;
    editionMbid?: string | null;
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
        providerUrlMatched?: boolean;
        releaseTitleMatched?: boolean;
        isrcOverlap?: number;
        isrcCoverageMatched?: boolean;
        trackCountMatched?: boolean;
        volumeCountMatched?: boolean;
        providerTrackCount?: number | null;
        targetTrackCount?: number | null;
        providerVolumeCount?: number | null;
        targetVolumeCount?: number | null;
        /** SoundCloud: covering tracks Discogenius can download (progressive/plain HLS). */
        downloadableTrackCount?: number | null;
        downloadableRatio?: number | null;
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

function providerAlbumResourceIds(album: ProviderAlbumForReleaseGroupMatching): Set<string> {
    const ids = new Set<string>();
    for (const value of [album.providerId, album.providerUrl, ...(album.providerUrls || [])]) {
        const normalized = providerResourceKey(value, { provider: album.provider || "tidal", type: "album" });
        if (normalized) {
            ids.add(normalized);
        }
    }
    return ids;
}

function normalizeIsrc(value?: string | null): string {
    return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function isSpatialProviderAlbum(album: ProviderAlbumForReleaseGroupMatching): boolean {
    const values = [
        album.quality,
        album.version,
        album.title,
        ...(album.qualityTags || []),
    ];
    return values.some((value) => /(atmos|spatial|360)/i.test(String(value || "")));
}

function releaseSpatialScore(release: MusicBrainzReleaseForMatching): number {
    const text = `${release.title || ""} ${release.disambiguation || ""}`.toLowerCase();
    if (/\bdolby\s+atmos\b/.test(text)) {
        return 3;
    }
    if (/\batmos\b/.test(text)) {
        return 2;
    }
    if (/\bspatial\b|\b360\b/.test(text)) {
        return 1;
    }
    return 0;
}

function releaseExplicitScore(release: MusicBrainzReleaseForMatching): number {
    const text = `${release.title || ""} ${release.disambiguation || ""}`.toLowerCase();
    if (/\bexplicit\b/.test(text)) {
        return 1;
    }
    if (/\bclean\b|\bcensored\b/.test(text)) {
        return -1;
    }
    return 0;
}

function providerExplicitPreference(album: ProviderAlbumForReleaseGroupMatching): boolean | null {
    if (album.explicit === null || album.explicit === undefined) {
        return null;
    }
    return Boolean(album.explicit);
}

function explicitPreferenceRank(release: MusicBrainzReleaseForMatching, preferExplicit: boolean | null): number {
    if (preferExplicit === null) {
        return 0;
    }

    const score = releaseExplicitScore(release);
    if (score === 0) {
        return 1;
    }
    return (score > 0) === preferExplicit ? 2 : 0;
}

function sortByExplicitPreference(
    releases: MusicBrainzReleaseForMatching[],
    preferExplicit: boolean | null,
): MusicBrainzReleaseForMatching[] {
    if (preferExplicit === null) {
        return [...releases];
    }

    return [...releases].sort((left, right) => {
        return explicitPreferenceRank(right, preferExplicit) - explicitPreferenceRank(left, preferExplicit)
            || String(left.mbid).localeCompare(String(right.mbid));
    });
}

function applyExplicitCompatibility(
    releases: MusicBrainzReleaseForMatching[],
    preferExplicit: boolean | null,
): MusicBrainzReleaseForMatching[] {
    if (preferExplicit === null || releases.length === 0) {
        return releases;
    }

    const preferred = releases.filter((release) => {
        const score = releaseExplicitScore(release);
        return score !== 0 && (score > 0) === preferExplicit;
    });
    return preferred.length > 0 ? preferred : releases;
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

    // Only treat the suffix as a version/edition label when it contains an
    // edition keyword. Arbitrary suffixes are part of the actual title.
    const suffix = match[2].trim();
    if (!/(?:deluxe|expanded|extended|special|complete|anniversary|bonus|remaster(?:ed)?|reissue|clean|explicit|dolby\s+atmos|atmos|spatial|hi-?res|lossless|stereo)/i.test(suffix)) {
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

    // MusicBrainz can use symbolic release-group names. provider APIs often
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
    const explicitPreference = providerExplicitPreference(album);
    const providerResourceIds = providerAlbumResourceIds(album);
    const matchedReleaseByUrl = providerResourceIds.size > 0
        ? releases.find((release) =>
            (release.externalUrls || []).some((url) => {
                const normalized = providerResourceKey(url);
                return normalized && providerResourceIds.has(normalized);
            }))
        : undefined;
    const providerUpc = normalizeBarcode(album.upc);
    const matchedReleaseByUpc = providerUpc
        ? releases.find((release) => normalizeBarcode(release.barcode) === providerUpc)
        : undefined;
    const providerIsrcs = new Set((album.isrcs || []).map(normalizeIsrc).filter(Boolean));
    let bestIsrcRelease: MusicBrainzReleaseForMatching | undefined;
    let isrcCompatibleReleases: MusicBrainzReleaseForMatching[] = [];
    let maxIsrcOverlap = 0;
    if (providerIsrcs.size > 0) {
        const isrcMatchedReleases: MusicBrainzReleaseForMatching[] = [];
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
                    isrcMatchedReleases.length = 0;
                    isrcMatchedReleases.push(release);
                } else if (overlap === maxIsrcOverlap) {
                    isrcMatchedReleases.push(release);
                }
            }
        }

        if (isrcMatchedReleases.length > 0) {
            const providerTrackCount = Number(album.trackCount || 0);
            const providerVolumeCount = Number(album.volumeCount || 0);
            bestIsrcRelease = [...isrcMatchedReleases].sort((left, right) => {
                const leftTrackDiff = providerTrackCount > 0
                    ? Math.abs(Number(left.trackCount || 0) - providerTrackCount)
                    : 0;
                const rightTrackDiff = providerTrackCount > 0
                    ? Math.abs(Number(right.trackCount || 0) - providerTrackCount)
                    : 0;
                if (leftTrackDiff !== rightTrackDiff) {
                    return leftTrackDiff - rightTrackDiff;
                }
                const leftVolumeDiff = providerVolumeCount > 0
                    ? Math.abs(Number(left.mediaCount || 0) - providerVolumeCount)
                    : 0;
                const rightVolumeDiff = providerVolumeCount > 0
                    ? Math.abs(Number(right.mediaCount || 0) - providerVolumeCount)
                    : 0;
                if (leftVolumeDiff !== rightVolumeDiff) {
                    return leftVolumeDiff - rightVolumeDiff;
                }
                return String(left.mbid).localeCompare(String(right.mbid));
            })[0];
            const bestTrackDiff = providerTrackCount > 0
                ? Math.abs(Number(bestIsrcRelease.trackCount || 0) - providerTrackCount)
                : 0;
            isrcCompatibleReleases = isrcMatchedReleases.filter((release) => {
                const releaseTrackDiff = providerTrackCount > 0
                    ? Math.abs(Number(release.trackCount || 0) - providerTrackCount)
                    : 0;
                return releaseTrackDiff === bestTrackDiff;
            });
        }
    }
    const isrcOverlap = maxIsrcOverlap;
    const trackCountEvidence = nearestNumericMatch(album.trackCount, releases.map((release) => release.trackCount));
    const volumeCountEvidence = nearestNumericMatch(album.volumeCount, releases.map((release) => release.mediaCount));
    const trackCountMatched = trackCountEvidence.matched;
    // ISRC overlap identifies recordings, not the release as a whole. It is
    // release-level evidence only when the provider and MB edition shapes also
    // agree and at least two recordings overlap (or both are genuinely
    // one-track releases). Without this boundary, one shared recording can
    // attach a short remix/EP—or an unrelated same-length compilation—to an
    // album.
    const isrcCoverageMatched = trackCountMatched
        && (isrcOverlap >= 2 || (isrcOverlap === 1 && Number(album.trackCount) === 1));
    const volumeCountMatched = volumeCountEvidence.matched;
    const providerTitles = providerTitleCandidates(album);
    const releaseTitleMatches = releases
        .map((release) => {
            const candidates = expandedTitleCandidates(release.title);
            const best = providerTitles
                .flatMap((providerTitle) => candidates.map((releaseTitle) => ({
                    release,
                    providerTitle,
                    releaseTitle,
                    titleScore: scoreTitle(providerTitle, releaseTitle),
                })))
                .sort((left, right) =>
                    right.titleScore - left.titleScore
                    || right.providerTitle.length - left.providerTitle.length
                    || right.releaseTitle.length - left.releaseTitle.length
                )[0];
            return best || null;
        })
        .filter((match): match is NonNullable<typeof match> => Boolean(match))
        .sort((left, right) =>
            right.titleScore - left.titleScore
            || explicitPreferenceRank(right.release, explicitPreference) - explicitPreferenceRank(left.release, explicitPreference)
            || right.providerTitle.length - left.providerTitle.length
            || right.releaseTitle.length - left.releaseTitle.length
        );
    const matchedReleaseByTitle = sortByExplicitPreference(
        releaseTitleMatches.map((match) => match.release),
        explicitPreference,
    ).map((release) => releaseTitleMatches.find((match) => match.release === release)!)
        .find((match) => {
        if (match.titleScore < 0.96) {
            return false;
        }
        const releaseTrackCount = Number(match.release.trackCount || 0);
        const releaseMediaCount = Number(match.release.mediaCount || 0);
        const providerTrackCount = Number(album.trackCount || 0);
        const providerVolumeCount = Number(album.volumeCount || 0);
        return (!releaseTrackCount || !providerTrackCount || releaseTrackCount === providerTrackCount)
            && (!releaseMediaCount || !providerVolumeCount || releaseMediaCount === providerVolumeCount);
    })?.release;
    const spatialProviderAlbum = isSpatialProviderAlbum(album);
    const releaseGroupTitleCandidates = titleCandidatesForReleaseGroup(releaseGroup);
    const titleScores = providerTitles
        .flatMap((candidateTitle) => releaseGroupTitleCandidates.map((releaseGroupTitle) => ({
            candidateTitle,
            releaseGroupTitle,
            titleScore: scoreTitle(candidateTitle, releaseGroupTitle),
        })))
        .sort((left, right) =>
            right.titleScore - left.titleScore
            || right.candidateTitle.length - left.candidateTitle.length
            || right.releaseGroupTitle.length - left.releaseGroupTitle.length
        );
    const bestTitle = titleScores[0] || { candidateTitle: null, releaseGroupTitle: null, titleScore: 0 };
    const normalizedProviderTitle = normalizeComparableText(album.title);
    // The provider title expands on the MusicBrainz title when it starts with
    // one of the release group's title candidates plus extra words ("Goosebumps
    // EP" → "Goosebumps", "Bad Blood X" → "Bad Blood"). Check that relationship
    // directly against the RG-side candidates rather than against the winning
    // provider candidate — providerTitleCandidates does not always strip the
    // suffix ("EP"/"X" are not edition keywords), so the base title may only
    // exist on the MB side.
    const titleExpansionMatched = Boolean(
        bestTitle.titleScore >= 0.82
        && normalizedProviderTitle
        && releaseGroupTitleCandidates.some((releaseGroupTitle) =>
            releaseGroupTitle
            && releaseGroupTitle !== normalizedProviderTitle
            && normalizedProviderTitle.startsWith(`${releaseGroupTitle} `),
        ),
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
    const shapeCompatibleReleases = releases.filter((release) => {
        const trackCount = Number(release.trackCount || 0);
        const mediaCount = Number(release.mediaCount || 0);
        return (!album.trackCount || !trackCount || trackCount === Number(album.trackCount))
            && (!album.volumeCount || !mediaCount || mediaCount === Number(album.volumeCount));
    });
    const explicitExpandedCompatibleReleases = applyExplicitCompatibility(expandedCompatibleReleases, explicitPreference);
    const explicitShapeCompatibleReleases = applyExplicitCompatibility(shapeCompatibleReleases, explicitPreference);
    const spatialCompatibleReleases = spatialProviderAlbum
        ? [...(explicitExpandedCompatibleReleases.length > 0 ? explicitExpandedCompatibleReleases : explicitShapeCompatibleReleases)]
            .filter((release) => releaseSpatialScore(release) > 0)
            .sort((left, right) => releaseSpatialScore(right) - releaseSpatialScore(left) || String(left.mbid).localeCompare(String(right.mbid)))
        : [];
    const matchedReleaseBySpatial = spatialCompatibleReleases[0];
    const availableReleases = matchedReleaseByUrl
        ? [matchedReleaseByUrl]
            : matchedReleaseByUpc
                ? [matchedReleaseByUpc]
                : bestIsrcRelease
            ? isrcCompatibleReleases
            : matchedReleaseByTitle
                ? [matchedReleaseByTitle]
            : matchedReleaseBySpatial
                ? [matchedReleaseBySpatial]
            : explicitExpandedCompatibleReleases.length > 0
                ? explicitExpandedCompatibleReleases
                : explicitShapeCompatibleReleases;
    const matchedRelease = matchedReleaseByUrl
        || matchedReleaseByUpc
        || bestIsrcRelease
        || matchedReleaseByTitle
        || matchedReleaseBySpatial
        || (availableReleases.length === 1 ? availableReleases[0] : undefined);
    const providerYear = yearOf(album.releaseDate);
    const releaseGroupYear = yearOf(releaseGroup.firstReleaseDate);
    const yearMatched = Boolean(providerYear && releaseGroupYear && providerYear === releaseGroupYear);
    const typeMatched = normalizeType(album.type) !== "" && normalizeType(album.type) === normalizeType(releaseGroup.primaryType);

    let confidence = matchedReleaseByUrl ? 1 : matchedReleaseByUpc ? 0.995 : bestTitle.titleScore;
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
    if (isrcCoverageMatched) {
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

    // Release URL and UPC are the only release-specific identity signals. Every
    // other path (title, title-expansion, year/type/track corroboration) is
    // shape evidence that a same-titled remix, radio edit, or alternate version
    // satisfies just as well. Keep those strictly below the UPC tier (0.995) so
    // the release that actually shares the barcode always outranks a look-alike
    // in confidence-ordered typed release-match selection.
    if (!matchedReleaseByUrl && !matchedReleaseByUpc) {
        confidence = Math.min(confidence, 0.99);
    }

    return {
        releaseGroup,
        confidence: Math.max(0, Math.min(1, Number(confidence.toFixed(3)))),
        titleScore: Number(bestTitle.titleScore.toFixed(3)),
        titleSpecificity: Number(bestTitle.candidateTitle?.length || 0),
        candidateTitle: bestTitle.candidateTitle,
        yearMatched,
        typeMatched,
        providerUrlMatched: Boolean(matchedReleaseByUrl),
        releaseTitleMatched: Boolean(matchedReleaseByTitle),
        upcMatched: Boolean(matchedReleaseByUpc),
        isrcOverlap,
        isrcCoverageMatched,
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
        .filter((candidate) => candidate.providerUrlMatched || candidate.upcMatched || candidate.isrcOverlap >= 1 || candidate.confidence >= 0.78)
        .sort((left, right) =>
            Number(right.providerUrlMatched) - Number(left.providerUrlMatched)
            || Number(right.upcMatched) - Number(left.upcMatched)
            || Number(right.isrcCoverageMatched) - Number(left.isrcCoverageMatched)
            || Number(right.confidence >= 0.78) - Number(left.confidence >= 0.78)
            || right.titleScore - left.titleScore
            || right.titleSpecificity - left.titleSpecificity
            || right.confidence - left.confidence
            || right.isrcOverlap - left.isrcOverlap
        );

    const best = scored[0];
    if (!best) {
        return {
            providerId: album.providerId,
            status: "unmatched",
            confidence: 0,
            method: "musicbrainz-release-group-title",
            editionMbid: null,
            evidence: {
                providerTitle: album.title,
                providerVersion: album.version ?? null,
                providerReleaseDate: album.releaseDate ?? null,
                providerType: album.type ?? null,
                providerUrlMatched: false,
                releaseTitleMatched: false,
                upcMatched: false,
                isrcOverlap: 0,
            },
        };
    }

    const ambiguousWith = scored
        .slice(1)
        .filter((candidate) =>
            !best.providerUrlMatched
            && !best.upcMatched
            && !candidate.providerUrlMatched
            && !candidate.upcMatched
            && best.isrcOverlap === candidate.isrcOverlap
            && best.titleScore - candidate.titleScore <= 0.04
            && best.titleSpecificity - candidate.titleSpecificity <= 4
            && best.confidence - candidate.confidence <= 0.04
        )
        .map((candidate) => candidate.releaseGroup.mbid);
    const exactTitleMatch = best.titleScore === 1;
    const exactProviderTitleMatch = exactTitleMatch && !best.titleExpansionMatched;
    const strongIdentityMatch = best.providerUrlMatched || best.upcMatched || best.isrcCoverageMatched;
    // A prefix-expansion title ("… EP", "… X") whose track count matches the MB
    // edition is as trustworthy as an exact title — promote it to verified so a
    // fully-covered EP doesn't sit at "probable".
    const verifiedTrackMatch = best.titleExpansionMatched && best.trackCountMatched;
    const verifiedSpatialReleaseMatch = Boolean(isSpatialProviderAlbum(album) && best.matchedReleaseMbid && best.trackCountMatched && best.volumeCountMatched);
    // Exact title alone is not release identity when the provider tracklist is
    // empty/unknown (SoundCloud album stubs). Require a positive matching track
    // count so title-only shells cannot become verified offers with no previews.
    const verifiedExactTitleMatch = exactProviderTitleMatch
        && best.confidence >= 0.96
        && best.trackCountMatched
        && Number(best.providerTrackCount || 0) > 0;
    const weakCoverageCandidate = best.isrcOverlap > 0
        && !best.isrcCoverageMatched
        && !best.providerUrlMatched
        && !best.upcMatched
        && best.confidence < 0.78;
    // Explicit empty provider tracklists (SoundCloud album shells with
    // track_count: 0) must not sit at probable — offer switchers treat
    // probable as a real match while the album header correctly shows no tips.
    // Unknown/null track counts stay probable (title/year shape evidence).
    const emptyProviderTracklist = album.trackCount === 0
      || best.providerTrackCount === 0;
    const status: ProviderReleaseGroupMatchStatus = ambiguousWith.length > 0
        ? "ambiguous"
        : weakCoverageCandidate
            ? "candidate"
        : emptyProviderTracklist
            ? "candidate"
        : (strongIdentityMatch || verifiedTrackMatch || verifiedSpatialReleaseMatch || verifiedExactTitleMatch)
            ? "verified"
            : "probable";
    const method = best.providerUrlMatched
        ? "musicbrainz-release-url"
        : best.upcMatched
        ? "musicbrainz-release-upc"
        : best.isrcOverlap >= 1
            ? "musicbrainz-recording-isrc"
            : best.releaseTitleMatched
                ? "musicbrainz-release-title-year-type-track-count"
                : "musicbrainz-release-group-title-year-type-track-count";

    return {
        providerId: album.providerId,
        status,
        confidence: best.confidence,
        method,
        editionMbid: best.matchedReleaseMbid,
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
            providerUrlMatched: best.providerUrlMatched,
            releaseTitleMatched: best.releaseTitleMatched,
            upcMatched: best.upcMatched,
            isrcOverlap: best.isrcOverlap,
            isrcCoverageMatched: best.isrcCoverageMatched,
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
