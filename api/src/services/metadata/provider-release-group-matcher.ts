import { normalizeComparableText, stringSimilarity } from "../import-matching-utils.js";

export type ProviderAlbumForReleaseGroupMatching = {
    providerId: string;
    title: string;
    version?: string | null;
    releaseDate?: string | null;
    type?: string | null;
};

export type MusicBrainzReleaseGroupForMatching = {
    mbid: string;
    title: string;
    primaryType?: string | null;
    secondaryTypes?: string[] | null;
    firstReleaseDate?: string | null;
    disambiguation?: string | null;
};

export type ProviderReleaseGroupMatchStatus = "verified" | "probable" | "ambiguous" | "unmatched";

export type ProviderReleaseGroupMatch = {
    providerId: string;
    status: ProviderReleaseGroupMatchStatus;
    confidence: number;
    method: string;
    releaseGroup?: MusicBrainzReleaseGroupForMatching;
    evidence: {
        providerTitle: string;
        providerVersion?: string | null;
        providerReleaseDate?: string | null;
        providerType?: string | null;
        candidateTitle?: string | null;
        titleScore?: number;
        yearMatched?: boolean;
        typeMatched?: boolean;
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

function providerTitleCandidates(album: ProviderAlbumForReleaseGroupMatching): string[] {
    const candidates = [
        album.title,
        album.version ? `${album.title} ${album.version}` : null,
        album.version ? `${album.title} (${album.version})` : null,
    ]
        .map((value) => normalizeComparableText(value))
        .filter((value): value is string => Boolean(value));

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

function scoreAlbumAgainstReleaseGroup(
    album: ProviderAlbumForReleaseGroupMatching,
    releaseGroup: MusicBrainzReleaseGroupForMatching,
) {
    const releaseGroupTitle = normalizeComparableText(releaseGroup.title);
    const titleScores = providerTitleCandidates(album)
        .map((candidateTitle) => ({
            candidateTitle,
            titleScore: scoreTitle(candidateTitle, releaseGroupTitle),
        }))
        .sort((left, right) => right.titleScore - left.titleScore);
    const bestTitle = titleScores[0] || { candidateTitle: null, titleScore: 0 };
    const providerYear = yearOf(album.releaseDate);
    const releaseGroupYear = yearOf(releaseGroup.firstReleaseDate);
    const yearMatched = Boolean(providerYear && releaseGroupYear && providerYear === releaseGroupYear);
    const typeMatched = normalizeType(album.type) !== "" && normalizeType(album.type) === normalizeType(releaseGroup.primaryType);

    let confidence = bestTitle.titleScore;
    if (bestTitle.titleScore >= 0.78 && yearMatched) {
        confidence += 0.06;
    }
    if (bestTitle.titleScore >= 0.78 && typeMatched) {
        confidence += 0.04;
    }

    return {
        releaseGroup,
        confidence: Math.min(1, Number(confidence.toFixed(3))),
        titleScore: Number(bestTitle.titleScore.toFixed(3)),
        candidateTitle: bestTitle.candidateTitle,
        yearMatched,
        typeMatched,
    };
}

export function matchProviderAlbumToReleaseGroup(
    album: ProviderAlbumForReleaseGroupMatching,
    releaseGroups: MusicBrainzReleaseGroupForMatching[],
): ProviderReleaseGroupMatch {
    const scored = releaseGroups
        .map((releaseGroup) => scoreAlbumAgainstReleaseGroup(album, releaseGroup))
        .filter((candidate) => candidate.confidence >= 0.78)
        .sort((left, right) => right.confidence - left.confidence);

    const best = scored[0];
    if (!best) {
        return {
            providerId: album.providerId,
            status: "unmatched",
            confidence: 0,
            method: "lidarr-release-group-title",
            evidence: {
                providerTitle: album.title,
                providerVersion: album.version ?? null,
                providerReleaseDate: album.releaseDate ?? null,
                providerType: album.type ?? null,
            },
        };
    }

    const ambiguousWith = scored
        .slice(1)
        .filter((candidate) => best.confidence - candidate.confidence <= 0.04)
        .map((candidate) => candidate.releaseGroup.mbid);
    const exactTitleMatch = best.titleScore === 1;
    const status: ProviderReleaseGroupMatchStatus = ambiguousWith.length > 0
        ? "ambiguous"
        : exactTitleMatch && best.confidence >= 0.96
            ? "verified"
            : "probable";

    return {
        providerId: album.providerId,
        status,
        confidence: best.confidence,
        method: "lidarr-release-group-title-year-type",
        releaseGroup: best.releaseGroup,
        evidence: {
            providerTitle: album.title,
            providerVersion: album.version ?? null,
            providerReleaseDate: album.releaseDate ?? null,
            providerType: album.type ?? null,
            candidateTitle: best.candidateTitle,
            titleScore: best.titleScore,
            yearMatched: best.yearMatched,
            typeMatched: best.typeMatched,
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
