import { db } from "../../database.js";
import { getConfigSection } from "../config/config.js";
import type { ProviderReleaseGroupMatch } from "../metadata/provider-release-group-matcher.js";
import { isSpatialAudioQuality, normalizeQualityTag } from "../../utils/spatial-audio.js";
import { scoreTrackMatch as sharedScoreTrackMatch, TRACK_MATCH_THRESHOLD } from "./provider-track-matcher.js";
import { MusicBrainzReleaseSelectionService } from "../metadata/musicbrainz-release-selection-service.js";
import {
    upsertProviderReleaseMatch,
} from "./provider-matches.js";

export type ReleaseGroupLibrarySlot = "stereo" | "spatial";

export type ProviderAlbumSlotCandidate = {
    providerId: string;
    title: string;
    version?: string | null;
    releaseDate?: string | null;
    quality?: string | null;
    explicit?: boolean | number | null;
    trackCount?: number | null;
    volumeCount?: number | null;
    tracks?: ProviderTrackDetail[];
    raw?: unknown;
    providerArtistName?: string | null;
};

export type ReleaseGroupSlotSelection = {
    releaseGroupMbid: string;
    slot: ReleaseGroupLibrarySlot;
    provider: string;
    album: ProviderAlbumSlotCandidate;
    match: ProviderReleaseGroupMatch;
    score: number;
};

function objectRecord(value: unknown): Record<string, any> {
    return value && typeof value === "object" ? value as Record<string, any> : {};
}

function textOrNull(...values: unknown[]): string | null {
    for (const value of values) {
        const text = String(value ?? "").trim();
        if (text) {
            return text;
        }
    }
    return null;
}

function numberOrNull(...values: unknown[]): number | null {
    for (const value of values) {
        const numberValue = Number(value);
        if (Number.isFinite(numberValue) && numberValue > 0) {
            return numberValue;
        }
    }
    return null;
}

function buildProviderOfferSnapshot(album: ProviderAlbumSlotCandidate): Record<string, unknown> {
    const raw = objectRecord(album.raw);
    const rawArtist = objectRecord(raw.artist);
    const rawArtists = Array.isArray(raw.artists) ? raw.artists.map(objectRecord) : [];
    const artistName = textOrNull(
        rawArtist.name,
        raw.artist_name,
        rawArtists[0]?.name,
    );

    return {
        title: textOrNull(album.title, raw.title),
        version: textOrNull(album.version, raw.version),
        cover: textOrNull(raw.cover, raw.image_id, raw.imageId),
        quality: textOrNull(album.quality, raw.quality),
        explicit: album.explicit == null ? (raw.explicit == null ? null : Boolean(raw.explicit)) : Boolean(album.explicit),
        releaseDate: textOrNull(album.releaseDate, raw.release_date, raw.releaseDate),
        trackCount: numberOrNull(album.trackCount, raw.num_tracks, raw.numberOfTracks, raw.trackCount),
        volumeCount: numberOrNull(album.volumeCount, raw.num_volumes, raw.numberOfVolumes, raw.volumeCount),
        artist: artistName ? { name: artistName } : null,
    };
}

export function isSpatialQualityTag(quality?: string | null): boolean {
    return isSpatialAudioQuality(quality);
}

function slotForQuality(quality?: string | null): ReleaseGroupLibrarySlot {
    return isSpatialQualityTag(quality) ? "spatial" : "stereo";
}

function qualityScore(slot: ReleaseGroupLibrarySlot, quality?: string | null): number {
    const normalized = normalizeQualityTag(quality);
    if (slot === "spatial") {
        if (normalized === "DOLBY_ATMOS") return 1000;
        if (isSpatialQualityTag(normalized)) return 920;
        return 0;
    }

    if (normalized === "HIRES_LOSSLESS" || normalized === "HI_RES_LOSSLESS") return 1000;
    if (normalized === "LOSSLESS") return 900;
    if (normalized === "HIGH") return 200;
    if (normalized === "LOW") return 50;
    return 100;
}

function scoreCandidate(
    album: ProviderAlbumSlotCandidate,
    match: ProviderReleaseGroupMatch,
    slot: ReleaseGroupLibrarySlot,
    preferExplicit: boolean,
): number {
    const tracks = Number(album.trackCount || 0);
    const volumes = Number(album.volumeCount || 0);
    const explicit = Boolean(album.explicit);
    const matchBonus = match.status === "verified" ? 40 : match.status === "probable" ? 20 : 0;
    const explicitBonus = explicit === preferExplicit ? 5 : 0;
    const evidence = match.evidence ?? {};
    const targetTrackCount = Number(evidence.targetTrackCount || 0);
    const targetVolumeCount = Number(evidence.targetVolumeCount || 0);
    const expandedTitleCoversTargetTracks = Boolean(
        evidence.titleExpansionMatched
        && targetTrackCount > 0
        && tracks >= targetTrackCount,
    );
    const expandedTitleCoversTargetVolumes = Boolean(
        evidence.titleExpansionMatched
        && targetVolumeCount > 0
        && volumes >= targetVolumeCount,
    );
    const trackShapeBonus = evidence.trackCountMatched
        ? 160
        : expandedTitleCoversTargetTracks
            ? 80
            : targetTrackCount > 0 && tracks > 0
                ? -Math.min(240, Math.max(1, Math.abs(targetTrackCount - tracks)) * 36)
                : 0;
    const volumeShapeBonus = evidence.volumeCountMatched
        ? 32
        : expandedTitleCoversTargetVolumes
            ? 16
            : targetVolumeCount > 0 && volumes > 0
                ? -Math.min(80, Math.max(1, Math.abs(targetVolumeCount - volumes)) * 20)
                : 0;
    const typeBonus = evidence.typeMatched ? 60 : -60;
    // Release-specific identity dominates title/shape evidence: an offer that
    // shares the release URL or barcode is the release, whereas a same-titled
    // remix or alternate version can accrue identical title/type/track bonuses.
    // Without this the wrong edition (e.g. a "… (Remix)" single) could tie and
    // win the slot over the barcode-matched original.
    const identityBonus =
        (evidence.providerUrlMatched ? 400 : 0)
        + (evidence.upcMatched ? 300 : 0)
        + (Number(evidence.isrcOverlap || 0) >= 2 ? 120 : 0);
    // Prefer the closest title. In Servarr Metadata Server mode there is no UPC
    // to lean on, so an exact-title offer ("One Day (Vandaag)") and a
    // remix-suffixed one ("… (Oliver $ Remix)") tie on every other axis; this
    // term deterministically favours the exact match over a prefix expansion.
    const titleQualityBonus = Math.round(Number(evidence.titleScore || 0) * 40);

    return Number((
        qualityScore(slot, album.quality)
        + matchBonus
        + identityBonus
        + titleQualityBonus
        + (match.confidence * 20)
        + trackShapeBonus
        + volumeShapeBonus
        + typeBonus
        + (tracks * 3)
        + (volumes * 2)
        + explicitBonus
    ).toFixed(3));
}

function normalizeIsrc(isrc: string | null | undefined): string {
    return String(isrc || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

type TargetTrack = {
    trackMbid: string;
    recordingMbid: string | null;
    isrcs: Set<string>;
    title: string;
    position: number;
    mediumPosition: number;
    lengthMs: number | null;
};

export type ProviderTrackDetail = {
    mbid: string | null;
    providerId?: string | null;
    provider_id?: string | null;
    isrc: string | null;
    title: string | null;
    version?: string | null;
    raw?: unknown;
    track_number: number | null;
    volume_number: number | null;
    duration: number | null;
};

type ProviderAlbumCandidateWithTracks = {
    provider: string;
    album: ProviderAlbumSlotCandidate;
    match: ProviderReleaseGroupMatch;
    score: number;
    tracks: Array<ProviderTrackDetail>;
};

// Adapter to the shared matcher. The slot path stores provider tracks in
// snake_case (built from provider rows that way in refresh-artist-service), so
// we map into the normalized shape here rather than changing the stored type.
function scoreTrackMatch(target: TargetTrack, pt: ProviderTrackDetail): number {
    return sharedScoreTrackMatch(
        {
            recordingMbid: target.recordingMbid,
            isrcs: target.isrcs,
            title: target.title,
            trackNumber: target.position,
            volumeNumber: target.mediumPosition,
            durationSec: target.lengthMs == null ? null : Number(target.lengthMs) / 1000,
        },
        {
            mbid: pt.mbid,
            isrc: pt.isrc,
            title: pt.title || "",
            version: pt.version ?? null,
            trackNumber: pt.track_number,
            volumeNumber: pt.volume_number,
            durationSec: pt.duration == null ? null : Number(pt.duration),
        },
    );
}

function isTrackCovered(target: TargetTrack, providerTracks: Array<ProviderTrackDetail>): boolean {
    return providerTracks.some(pt => {
        return scoreTrackMatch(target, pt) >= TRACK_MATCH_THRESHOLD;
    });
}

function sortCandidatesForSlot(slot: ReleaseGroupLibrarySlot, candidates: ProviderAlbumCandidateWithTracks[]): void {
    candidates.sort((a, b) => {
        const qA = qualityScore(slot, a.album.quality);
        const qB = qualityScore(slot, b.album.quality);
        if (qA !== qB) {
            return qB - qA;
        }
        return b.score - a.score;
    });
}

function compatibleReleaseMbids(match: ProviderReleaseGroupMatch): string[] {
    return Array.from(new Set([
        ...(match.evidence.availableReleaseMbids || []),
        match.releaseMbid || "",
    ].map((releaseMbid) => String(releaseMbid || "").trim()).filter(Boolean)));
}

type ReleaseTrackTargets = {
    releaseMbid: string;
    tracks: TargetTrack[];
};

type TrackSourceAssignment = {
    targetIndex: number;
    candidate: ProviderAlbumCandidateWithTracks;
    providerTrack: ProviderTrackDetail;
    matchScore: number;
};

type ReleaseCoveragePlan = {
    releaseMbid: string;
    targetTracks: TargetTrack[];
    provider: string;
    assignments: TrackSourceAssignment[];
    candidates: ProviderAlbumCandidateWithTracks[];
    complete: boolean;
    qualityTotal: number;
    identityCompatibleAssignments: number;
    extraProviderTracks: number;
    scoreTotal: number;
};

/**
 * Load the audio tracklist of every release in a release group, so provider
 * albums can be validated against the edition they actually correspond to
 * instead of only the single "representative" release.
 */
function loadReleaseTrackTargets(releaseGroupMbid: string): ReleaseTrackTargets[] {
    const rows = db.prepare(`
        SELECT t.release_mbid, t.mbid AS track_mbid, t.recording_mbid, rec.isrcs, t.title, t.position, t.medium_position, t.length_ms
        FROM Tracks t
        JOIN AlbumReleases r ON r.mbid = t.release_mbid
        LEFT JOIN Recordings rec ON rec.mbid = t.recording_mbid
        WHERE r.release_group_mbid = ?
          AND COALESCE(rec.is_video, 0) = 0
        ORDER BY t.release_mbid ASC, t.medium_position ASC, t.position ASC
    `).all(releaseGroupMbid) as Array<{
        release_mbid: string;
        track_mbid: string;
        recording_mbid: string | null;
        isrcs: string | null;
        title: string;
        position: number;
        medium_position: number;
        length_ms: number | null;
    }>;

    const byRelease = new Map<string, TargetTrack[]>();
    for (const row of rows) {
        const isrcs = new Set<string>();
        if (row.isrcs) {
            try {
                const parsed = JSON.parse(row.isrcs);
                if (Array.isArray(parsed)) {
                    for (const isrc of parsed) {
                        const normalized = normalizeIsrc(isrc);
                        if (normalized) isrcs.add(normalized);
                    }
                }
            } catch {
                // Ignore malformed ISRC payloads.
            }
        }

        const recordingMbid = row.recording_mbid ? String(row.recording_mbid).trim() : null;
        let tracks = byRelease.get(row.release_mbid);
        if (!tracks) {
            tracks = [];
            byRelease.set(row.release_mbid, tracks);
        }
        tracks.push({
            trackMbid: row.track_mbid,
            recordingMbid,
            isrcs,
            title: row.title,
            position: row.position,
            mediumPosition: row.medium_position,
            lengthMs: row.length_ms,
        });
    }

    return Array.from(byRelease.entries()).map(([releaseMbid, tracks]) => ({ releaseMbid, tracks }));
}

function buildCoveragePlanForProvider(
    target: ReleaseTrackTargets,
    provider: string,
    candidates: ProviderAlbumCandidateWithTracks[],
    slot: ReleaseGroupLibrarySlot,
): ReleaseCoveragePlan | null {
    const providerCandidatesByAlbum = new Map<string, ProviderAlbumCandidateWithTracks>();
    for (const candidate of candidates) {
        if (candidate.provider !== provider || candidate.tracks.length === 0) continue;
        const albumId = String(candidate.album.providerId);
        const existing = providerCandidatesByAlbum.get(albumId);
        if (!existing || candidate.score > existing.score) {
            providerCandidatesByAlbum.set(albumId, candidate);
        }
    }
    const providerCandidates = Array.from(providerCandidatesByAlbum.values());
    if (providerCandidates.length === 0 || target.tracks.length === 0) {
        return null;
    }

    const sourcesByKey = new Map<string, {
        key: string;
        candidate: ProviderAlbumCandidateWithTracks;
        providerTrack: ProviderTrackDetail;
        quality: number;
    }>();
    for (const candidate of providerCandidates) {
        candidate.tracks.forEach((providerTrack, trackIndex) => {
            const providerTrackId = String(providerTrack.providerId || providerTrack.provider_id || "").trim();
            const key = providerTrackId
                ? `${candidate.album.providerId}:${providerTrackId}`
                : `${candidate.album.providerId}:${providerTrack.volume_number || 1}:${providerTrack.track_number || trackIndex + 1}:${providerTrack.title || ""}`;
            if (!sourcesByKey.has(key)) {
                sourcesByKey.set(key, {
                    key,
                    candidate,
                    providerTrack,
                    quality: qualityScore(slot, candidate.album.quality),
                });
            }
        });
    }
    const sources = Array.from(sourcesByKey.values());
    const normalizedTitle = (value: string | null | undefined) => String(value || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
    const titleCounts = new Map<string, number>();
    for (const track of target.tracks) {
        const title = normalizedTitle(track.title);
        titleCounts.set(title, (titleCounts.get(title) || 0) + 1);
    }
    const hasStrongTrackIdentity = (targetTrack: TargetTrack, providerTrack: ProviderTrackDetail) => {
        if (targetTrack.recordingMbid && providerTrack.mbid && targetTrack.recordingMbid === providerTrack.mbid) {
            return true;
        }
        const providerIsrc = normalizeIsrc(providerTrack.isrc);
        return Boolean(providerIsrc && targetTrack.isrcs.has(providerIsrc));
    };
    const edges = target.tracks.map((targetTrack, targetIndex) => sources
        .map((source) => ({
            source,
            targetIndex,
            matchScore: scoreTrackMatch(targetTrack, source.providerTrack),
        }))
        .filter((edge) => {
            if (edge.matchScore < TRACK_MATCH_THRESHOLD) return false;
            const duplicateCanonicalTitle = (titleCounts.get(normalizedTitle(targetTrack.title)) || 0) > 1;
            // Editions such as an original album plus an instrumental disc can
            // repeat every displayed title while referring to different MB
            // recordings. Without MBID/ISRC evidence, title/duration cannot say
            // which repeated recording a provider track represents. Treat that
            // ambiguity as uncovered instead of reusing vocal tracks as the
            // instrumental disc (or vice versa).
            return !duplicateCanonicalTitle || hasStrongTrackIdentity(targetTrack, edge.source.providerTrack);
        })
        .sort((left, right) =>
            right.source.quality - left.source.quality
            || right.matchScore - left.matchScore
            || right.source.candidate.score - left.source.candidate.score
            || left.source.candidate.album.providerId.localeCompare(right.source.candidate.album.providerId)
            || left.source.key.localeCompare(right.source.key)
        ));

    const sourceOwner = new Map<string, number>();
    const assignedSource = new Map<number, typeof sources[number]>();
    const assignedScore = new Map<number, number>();
    const tryAssign = (targetIndex: number, visitedSources: Set<string>): boolean => {
        for (const edge of edges[targetIndex]) {
            if (visitedSources.has(edge.source.key)) continue;
            visitedSources.add(edge.source.key);
            const previousTarget = sourceOwner.get(edge.source.key);
            if (previousTarget == null || tryAssign(previousTarget, visitedSources)) {
                sourceOwner.set(edge.source.key, targetIndex);
                assignedSource.set(targetIndex, edge.source);
                assignedScore.set(targetIndex, edge.matchScore);
                return true;
            }
        }
        return false;
    };

    const targetOrder = edges
        .map((targetEdges, targetIndex) => ({ targetIndex, choices: targetEdges.length }))
        .filter((entry) => entry.choices > 0)
        .sort((left, right) => left.choices - right.choices || left.targetIndex - right.targetIndex);
    for (const { targetIndex } of targetOrder) {
        tryAssign(targetIndex, new Set());
    }

    const assignments = Array.from(assignedSource.entries())
        .map(([targetIndex, source]) => ({
            targetIndex,
            candidate: source.candidate,
            providerTrack: source.providerTrack,
            matchScore: assignedScore.get(targetIndex) || 0,
        }))
        .sort((left, right) => left.targetIndex - right.targetIndex);
    if (assignments.length === 0) {
        return null;
    }

    const selectedCandidates = Array.from(new Set(assignments.map((assignment) => assignment.candidate)));
    return {
        releaseMbid: target.releaseMbid,
        targetTracks: target.tracks,
        provider,
        assignments,
        candidates: selectedCandidates,
        complete: assignments.length === target.tracks.length,
        qualityTotal: assignments.reduce((sum, assignment) => sum + qualityScore(slot, assignment.candidate.album.quality), 0),
        identityCompatibleAssignments: assignments.filter((assignment) =>
            compatibleReleaseMbids(assignment.candidate.match).includes(target.releaseMbid),
        ).length,
        extraProviderTracks: Math.max(0, selectedCandidates.reduce((sum, candidate) => sum + candidate.tracks.length, 0) - assignments.length),
        scoreTotal: selectedCandidates.reduce((sum, candidate) => sum + candidate.score, 0),
    };
}

function compareCoveragePlans(left: ReleaseCoveragePlan, right: ReleaseCoveragePlan): number {
    return right.assignments.length - left.assignments.length
        || Number(right.complete) - Number(left.complete)
        || right.qualityTotal - left.qualityTotal
        || right.identityCompatibleAssignments - left.identityCompatibleAssignments
        || left.candidates.length - right.candidates.length
        || left.extraProviderTracks - right.extraProviderTracks
        || right.scoreTotal - left.scoreTotal
        || right.targetTracks.length - left.targetTracks.length
        || left.releaseMbid.localeCompare(right.releaseMbid)
        || left.provider.localeCompare(right.provider);
}

function lowestPlanQuality(plan: ReleaseCoveragePlan, slot: ReleaseGroupLibrarySlot): string | null {
    return [...plan.assignments]
        .sort((left, right) =>
            qualityScore(slot, left.candidate.album.quality) - qualityScore(slot, right.candidate.album.quality),
        )[0]?.candidate.album.quality || null;
}

function coveragePlanEvidence(plan: ReleaseCoveragePlan): Record<string, unknown> {
    const qualityTrackCounts: Record<string, number> = {};
    for (const assignment of plan.assignments) {
        const quality = normalizeQualityTag(assignment.candidate.album.quality) || "UNKNOWN";
        qualityTrackCounts[quality] = (qualityTrackCounts[quality] || 0) + 1;
    }

    return {
        matchKind: plan.candidates.length > 1 ? "composite" : plan.complete ? "direct" : "partial",
        providerAlbumIds: plan.candidates.map((candidate) => candidate.album.providerId),
        coverage: {
            coveredTracks: plan.assignments.length,
            targetTracks: plan.targetTracks.length,
            complete: plan.complete,
            qualityTrackCounts,
            extraProviderTracks: plan.extraProviderTracks,
        },
        trackSources: plan.assignments.map((assignment) => {
            const target = plan.targetTracks[assignment.targetIndex];
            return {
                canonicalTrackMbid: target.trackMbid,
                canonicalRecordingMbid: target.recordingMbid,
                title: target.title,
                providerTrackId: assignment.providerTrack.providerId || assignment.providerTrack.provider_id || null,
                providerAlbumId: assignment.candidate.album.providerId,
                quality: assignment.candidate.album.quality || null,
                matchScore: assignment.matchScore,
            };
        }),
    };
}

function selectReleaseMbidForCandidate(
    releaseGroupMbid: string,
    candidate: ProviderAlbumCandidateWithTracks,
    fallbackReleaseMbid?: string | null,
): string | null {
    const compatibleMbids = compatibleReleaseMbids(candidate.match);
    const selected = compatibleMbids.length > 0
        ? MusicBrainzReleaseSelectionService.selectRepresentativeRelease(releaseGroupMbid, {
            availableReleaseMbids: compatibleMbids,
        })
        : null;

    return selected?.mbid || candidate.match.releaseMbid || fallbackReleaseMbid || null;
}

function hasStrongReleaseShapeEvidence(
    candidate: ProviderAlbumCandidateWithTracks,
    preferredReleaseMbid?: string | null,
): boolean {
    if (candidate.match.confidence < 0.95) {
        return false;
    }

    const evidence = candidate.match.evidence ?? {};
    if (!evidence.trackCountMatched || !evidence.volumeCountMatched) {
        return false;
    }

    const providerTrackCount = Number(evidence.providerTrackCount || candidate.album.trackCount || 0);
    const targetTrackCount = Number(evidence.targetTrackCount || 0);
    if (providerTrackCount <= 0 || targetTrackCount <= 0 || providerTrackCount !== targetTrackCount) {
        return false;
    }

    const providerVolumeCount = Number(evidence.providerVolumeCount || candidate.album.volumeCount || 1);
    const targetVolumeCount = Number(evidence.targetVolumeCount || 1);
    if (providerVolumeCount !== targetVolumeCount) {
        return false;
    }

    if (preferredReleaseMbid && !compatibleReleaseMbids(candidate.match).includes(preferredReleaseMbid)) {
        return false;
    }

    return true;
}

export function selectReleaseGroupSlotAlbums(
    candidatesOrAlbums: Array<{
        provider: string;
        album: ProviderAlbumSlotCandidate;
        match: ProviderReleaseGroupMatch;
    }> | ProviderAlbumSlotCandidate[],
    optionsOrMatches?: { includeSpatial?: boolean; preferExplicit?: boolean } | Map<string, ProviderReleaseGroupMatch>,
    options?: { includeSpatial?: boolean; preferExplicit?: boolean },
): ReleaseGroupSlotSelection[] {
    let candidates: Array<{
        provider: string;
        album: ProviderAlbumSlotCandidate;
        match: ProviderReleaseGroupMatch;
    }> = [];

    let resolvedOptions: { includeSpatial?: boolean; preferExplicit?: boolean } = {};

    if (optionsOrMatches instanceof Map) {
        const albums = candidatesOrAlbums as ProviderAlbumSlotCandidate[];
        const matches = optionsOrMatches;
        resolvedOptions = options || {};
        candidates = albums.map(album => {
            const match = matches.get(album.providerId) || {
                providerId: album.providerId,
                status: "unmatched" as const,
                confidence: 0,
                method: "none",
                evidence: {
                    providerTitle: album.title || "",
                }
            };
            return {
                provider: "tidal",
                album,
                match,
            };
        });
    } else {
        candidates = candidatesOrAlbums as Array<{
            provider: string;
            album: ProviderAlbumSlotCandidate;
            match: ProviderReleaseGroupMatch;
        }>;
        resolvedOptions = optionsOrMatches || {};
    }

    const includeSpatial = resolvedOptions.includeSpatial === true;
    const preferExplicit = resolvedOptions.preferExplicit !== false;
    const bestByReleaseGroupAndSlot = new Map<string, ReleaseGroupSlotSelection>();

    // Group candidates by releaseGroupMbid:slot
    const candidatesByGroupAndSlot = new Map<string, Array<{ provider: string; album: ProviderAlbumSlotCandidate; match: ProviderReleaseGroupMatch; score: number }>>();

    for (const c of candidates) {
        const { provider, album, match } = c;
        if (!match?.releaseGroup || !["verified", "probable", "candidate"].includes(match.status)) {
            continue;
        }

        const slot = slotForQuality(album.quality);
        if (slot === "spatial" && !includeSpatial) {
            continue;
        }

        const score = scoreCandidate(album, match, slot, preferExplicit);
        const key = `${match.releaseGroup.mbid}:${slot}`;
        
        let list = candidatesByGroupAndSlot.get(key);
        if (!list) {
            list = [];
            candidatesByGroupAndSlot.set(key, list);
        }
        list.push({ provider, album, match, score });
    }

    for (const [key, groupCandidates] of candidatesByGroupAndSlot.entries()) {
        if (groupCandidates.length === 0) continue;

        const colonIndex = key.lastIndexOf(":");
        const releaseGroupMbid = key.substring(0, colonIndex);
        const slot = key.substring(colonIndex + 1) as ReleaseGroupLibrarySlot;

        const requireProviderAvailability = getConfigSection("filtering").require_provider_availability === true;
        const providerMatchedReleaseMbids = groupCandidates
            .flatMap((candidate) => candidate.match.evidence.availableReleaseMbids?.length
                ? candidate.match.evidence.availableReleaseMbids
                : [candidate.match.releaseMbid || ""])
            .map((releaseMbid) => String(releaseMbid || "").trim())
            .filter(Boolean);
        const preferredReleaseRow = requireProviderAvailability
            ? MusicBrainzReleaseSelectionService.selectRepresentativeRelease(
                releaseGroupMbid,
                { availableReleaseMbids: providerMatchedReleaseMbids }
              )
            : (MusicBrainzReleaseSelectionService.selectRepresentativeRelease(releaseGroupMbid)
                || MusicBrainzReleaseSelectionService.selectRepresentativeRelease(
                    releaseGroupMbid,
                    { availableReleaseMbids: providerMatchedReleaseMbids }
                ));
        if (requireProviderAvailability && !preferredReleaseRow) {
            continue;
        }

        // Validate provider albums against every release in the group, ordered
        // by tracklist size so the most extensive coverable edition wins (the
        // curation goal: prefer deluxe/anniversary editions over the standard
        // when the provider actually carries them). The slot then records the
        // release that was actually covered, so the selected MusicBrainz
        // edition always describes the provider album that will be downloaded.
        const releaseTargets = loadReleaseTrackTargets(releaseGroupMbid)
            .sort((left, right) =>
                right.tracks.length - left.tracks.length
                || Number(right.releaseMbid === preferredReleaseRow?.mbid) - Number(left.releaseMbid === preferredReleaseRow?.mbid)
                || left.releaseMbid.localeCompare(right.releaseMbid)
            );

        const preferredCompatibleCandidates = preferredReleaseRow
            ? groupCandidates.filter((candidate) => compatibleReleaseMbids(candidate.match).includes(preferredReleaseRow.mbid))
            : [];
        const slotCandidates = releaseTargets.length > 0
            ? groupCandidates
            : preferredCompatibleCandidates.length > 0
                ? preferredCompatibleCandidates
                : groupCandidates;

        const candidatesWithTracks = slotCandidates.map(c => {
            const tracks = (c.album.tracks || []).map(track => ({
                ...track,
                isrc: track.isrc ? normalizeIsrc(track.isrc) : null,
            }));
            return { ...c, tracks };
        });

        // Check: do we have track details for any candidate?
        const hasTrackDetails = candidatesWithTracks.some(c => c.tracks.length > 0);

        // 1. If there are no target tracks or no candidate track details, select the best candidate by score
        if (releaseTargets.length === 0 || !hasTrackDetails) {
            const standaloneCandidates = candidatesWithTracks.filter((candidate) => candidate.match.status !== "candidate");
            standaloneCandidates.sort((a, b) => b.score - a.score);
            if (standaloneCandidates.length === 0) {
                continue;
            }
            const best = standaloneCandidates[0];
            const selectedMatch: ProviderReleaseGroupMatch = {
                ...best.match,
                releaseMbid: selectReleaseMbidForCandidate(releaseGroupMbid, best, preferredReleaseRow?.mbid),
            };
            bestByReleaseGroupAndSlot.set(key, {
                releaseGroupMbid,
                slot,
                provider: best.provider,
                album: best.album,
                match: selectedMatch,
                score: best.score,
            });
            continue;
        }

        // Build a strict per-track acquisition plan for every canonical edition
        // and provider. Recording identity (MBID/ISRC, then the shared structural
        // matcher) decides coverage. Quality is optimized per target track, so a
        // hi-res standard edition can supply disc one while a lossless deluxe
        // offer supplies otherwise-unavailable bonus tracks. No title-specific
        // remix/radio-edit rules are needed.
        const providers = Array.from(new Set(candidatesWithTracks.map((candidate) => candidate.provider)));
        const coveragePlans = releaseTargets.flatMap((target) => providers
            .map((provider) => buildCoveragePlanForProvider(target, provider, candidatesWithTracks, slot))
            .filter((plan): plan is ReleaseCoveragePlan => Boolean(plan)));
        coveragePlans.sort(compareCoveragePlans);
        const selectedPlan = coveragePlans[0] || null;

        if (!selectedPlan) {
            const strongMetadataCandidates = candidatesWithTracks.filter((candidate) =>
                hasStrongReleaseShapeEvidence(candidate, preferredReleaseRow?.mbid)
            );
            if (strongMetadataCandidates.length === 0) {
                continue;
            }

            sortCandidatesForSlot(slot, strongMetadataCandidates);
            const bestMetadataCover = strongMetadataCandidates[0];
            const selectedMatch: ProviderReleaseGroupMatch = {
                ...bestMetadataCover.match,
                releaseMbid: selectReleaseMbidForCandidate(releaseGroupMbid, bestMetadataCover, preferredReleaseRow?.mbid),
            };
            bestByReleaseGroupAndSlot.set(key, {
                releaseGroupMbid,
                slot,
                provider: bestMetadataCover.provider,
                album: bestMetadataCover.album,
                match: selectedMatch,
                score: bestMetadataCover.score,
            });
            continue;
        }

        const firstAssignmentByCandidate = new Map<ProviderAlbumCandidateWithTracks, number>();
        for (const assignment of selectedPlan.assignments) {
            if (!firstAssignmentByCandidate.has(assignment.candidate)) {
                firstAssignmentByCandidate.set(assignment.candidate, assignment.targetIndex);
            }
        }
        const selectedCandidates = [...selectedPlan.candidates].sort((left, right) =>
            (firstAssignmentByCandidate.get(left) ?? Number.MAX_SAFE_INTEGER)
            - (firstAssignmentByCandidate.get(right) ?? Number.MAX_SAFE_INTEGER)
            || left.album.providerId.localeCompare(right.album.providerId));
        const primary = selectedCandidates[0];
        const selectedIds = selectedCandidates.map((candidate) => candidate.album.providerId);
        const evidence = {
            ...primary.match.evidence,
            ...coveragePlanEvidence(selectedPlan),
        };
        const mergedAlbum: ProviderAlbumSlotCandidate = {
            ...primary.album,
            providerId: selectedIds.join(";"),
            quality: lowestPlanQuality(selectedPlan, slot),
        };
        const method = selectedPlan.complete
            ? selectedCandidates.length > 1
                ? "quality_optimized_composite_track_coverage"
                : primary.match.status === "candidate"
                    ? "strict_single_album_track_coverage"
                    : primary.match.method
            : "strict_partial_track_coverage";
        const selectedMatch: ProviderReleaseGroupMatch = {
            ...primary.match,
            releaseMbid: selectedPlan.releaseMbid,
            status: selectedPlan.complete ? "verified" : "probable",
            confidence: selectedPlan.complete
                ? Math.max(0.95, primary.match.confidence)
                : Math.min(0.94, selectedPlan.assignments.length / selectedPlan.targetTracks.length),
            method,
            evidence,
        };

        bestByReleaseGroupAndSlot.set(key, {
            releaseGroupMbid,
            slot,
            provider: selectedPlan.provider,
            album: mergedAlbum,
            match: selectedMatch,
            score: selectedPlan.scoreTotal,
        });
    }

    const finalSelections = Array.from(bestByReleaseGroupAndSlot.values());
    const releaseGroups = Array.from(new Set(finalSelections.map(s => s.releaseGroupMbid)));
    for (const mbid of releaseGroups) {
        const slots = finalSelections.filter(s => s.releaseGroupMbid === mbid);
        const hasStereo = slots.some(s => s.slot === "stereo");
        const spatialSelection = slots.find(s => s.slot === "spatial");

        if (!hasStereo && spatialSelection) {
            finalSelections.push({
                ...spatialSelection,
                slot: "stereo",
            });
        }
    }

    return finalSelections
        .sort((left, right) => left.releaseGroupMbid.localeCompare(right.releaseGroupMbid) || left.slot.localeCompare(right.slot));
}

export class ReleaseGroupSlotService {
    static syncProviderAlbumSelections(input: {
        artistMbid: string | null;
        candidates?: Array<{
            provider: string;
            album: ProviderAlbumSlotCandidate;
            match: ProviderReleaseGroupMatch;
        }>;
        provider?: string;
        albums?: ProviderAlbumSlotCandidate[];
        matches?: Map<string, ProviderReleaseGroupMatch>;
        clearProviders?: string[];
    }): { stereo: number; spatial: number } {
        if (!input.artistMbid) {
            return { stereo: 0, spatial: 0 };
        }

        let candidates: Array<{
            provider: string;
            album: ProviderAlbumSlotCandidate;
            match: ProviderReleaseGroupMatch;
        }> = [];

        if (input.candidates) {
            candidates = input.candidates;
        } else if (input.albums && input.matches) {
            const providerName = input.provider || "tidal";
            candidates = input.albums.map(album => {
                const match = input.matches!.get(album.providerId) || {
                    providerId: album.providerId,
                    status: "unmatched" as const,
                    confidence: 0,
                    method: "none",
                    evidence: {
                        providerTitle: album.title || "",
                    }
                };
                return {
                    provider: providerName,
                    album,
                    match,
                };
            });
        }

        const filteringConfig = getConfigSection("filtering");
        const selections = selectReleaseGroupSlotAlbums(candidates, {
            // Discovery and provider matching remain independent from wanted state.
            // Curation applies the user's spatial toggle after refresh, like Lidarr's
            // metadata hydration followed by monitored-release selection.
            includeSpatial: true,
            preferExplicit: filteringConfig.prefer_explicit !== false,
        });

        const selectionKeys = new Set(selections.map((selection) => `${selection.releaseGroupMbid}:${selection.slot}`));
        const clearProviders = input.clearProviders == null
            ? (input.provider ? new Set([input.provider]) : null)
            : new Set(input.clearProviders);
        const clearStaleSelection = db.prepare(`
            UPDATE ReleaseGroupSlots
            SET
                selected_provider = NULL,
                selected_provider_id = NULL,
                selected_release_mbid = NULL,
                quality = NULL,
                match_status = 'unmatched',
                match_confidence = NULL,
                match_method = NULL,
                match_evidence = NULL,
                provider_artist_name = NULL,
                provider_title = NULL,
                cover = NULL,
                popularity = NULL,
                checked_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `);
        const existingSlots = db.prepare(`
            SELECT DISTINCT slot.id, slot.release_group_mbid, slot.slot, slot.selected_provider
            FROM ReleaseGroupSlots slot
            JOIN Albums rg ON rg.mbid = slot.release_group_mbid
            LEFT JOIN ArtistReleaseGroups scope ON scope.release_group_mbid = rg.mbid
            WHERE (rg.artist_mbid = ? OR scope.artist_mbid = ?)
              AND selected_provider IS NOT NULL
        `).all(input.artistMbid, input.artistMbid) as Array<{ id: number; release_group_mbid: string; slot: string; selected_provider: string }>;

        const upsert = db.prepare(`
            INSERT INTO ReleaseGroupSlots (
                artist_mbid, release_group_mbid, slot, monitored,
                selected_provider, selected_provider_id, selected_release_mbid, quality,
                match_status, match_confidence, match_method, match_evidence,
                provider_artist_name, provider_title, checked_at, updated_at
            )
            VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            ON CONFLICT(release_group_mbid, slot) DO UPDATE SET
                selected_provider = excluded.selected_provider,
                selected_provider_id = excluded.selected_provider_id,
                selected_release_mbid = excluded.selected_release_mbid,
                quality = excluded.quality,
                match_status = excluded.match_status,
                match_confidence = excluded.match_confidence,
                match_method = excluded.match_method,
                match_evidence = excluded.match_evidence,
                provider_artist_name = excluded.provider_artist_name,
                provider_title = excluded.provider_title,
                checked_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
        `);

        const counts = { stereo: 0, spatial: 0 };
        const selectOwner = db.prepare("SELECT artist_mbid FROM Albums WHERE mbid = ?");
        db.transaction(() => {
            for (const existing of existingSlots) {
                if (clearProviders && !clearProviders.has(existing.selected_provider)) {
                    continue;
                }
                const key = `${existing.release_group_mbid}:${existing.slot}`;
                if (!selectionKeys.has(key)) {
                    clearStaleSelection.run(existing.id);
                }
            }

            for (const selection of selections) {
                const owner = selectOwner.get(selection.releaseGroupMbid) as { artist_mbid?: string | null } | undefined;
                upsert.run(
                    owner?.artist_mbid || input.artistMbid,
                    selection.releaseGroupMbid,
                    selection.slot,
                    selection.provider,
                    selection.album.providerId,
                    selection.match.releaseMbid || null,
                    selection.album.quality || null,
                    selection.match.status,
                    selection.match.confidence,
                    selection.match.method,
                    JSON.stringify({ ...selection.match.evidence, score: selection.score }),
                    selection.album.providerArtistName || (selection.album.raw as any)?.artist_name || null,
                    selection.album.title || null,
                );
                if (selection.match.releaseMbid) {
                    upsertProviderReleaseMatch({
                        provider: selection.provider,
                        providerId: selection.album.providerId,
                        providerAlbumId: selection.album.providerId,
                        releaseMbid: selection.match.releaseMbid,
                        status: selection.match.status,
                        confidence: selection.match.confidence,
                        method: selection.match.method,
                        evidence: JSON.stringify({ ...selection.match.evidence, score: selection.score }),
                    });
                }
                counts[selection.slot] += 1;
            }
        })();

        return counts;
    }
}
