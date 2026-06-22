import { db } from "../../database.js";
import { getConfigSection } from "../config/config.js";
import type { ProviderReleaseGroupMatch } from "../metadata/provider-release-group-matcher.js";
import { isSpatialAudioQuality, normalizeQualityTag } from "../../utils/spatial-audio.js";
import { scoreTrackMatch as sharedScoreTrackMatch, TRACK_MATCH_THRESHOLD } from "./provider-track-matcher.js";
import { MusicBrainzReleaseSelectionService } from "../metadata/musicbrainz-release-selection-service.js";
import {
    upsertProviderReleaseMatch,
    getReleaseGroupAvailability,
    setSlotSelection,
    type ReleaseAvailabilityProvider,
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

    return Number((
        qualityScore(slot, album.quality)
        + matchBonus
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
    recordingMbid: string | null;
    isrcs: Set<string>;
    title: string;
    position: number;
    mediumPosition: number;
    lengthMs: number | null;
};

export type ProviderTrackDetail = {
    mbid: string | null;
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

function getMatchedTargets1to1(targetTracks: TargetTrack[], providerTracks: ProviderTrackDetail[]): Set<number> {
    const usedProviderIndices = new Set<number>();
    const matchedTargetIndices = new Set<number>();
    
    for (let targetIdx = 0; targetIdx < targetTracks.length; targetIdx++) {
        const target = targetTracks[targetIdx];
        let bestScore = -1;
        let bestIdx = -1;
        for (let i = 0; i < providerTracks.length; i++) {
            if (usedProviderIndices.has(i)) continue;
            const score = scoreTrackMatch(target, providerTracks[i]);
            if (score >= TRACK_MATCH_THRESHOLD && score > bestScore) {
                bestScore = score;
                bestIdx = i;
            }
        }
        if (bestIdx !== -1) {
            matchedTargetIndices.add(targetIdx);
            usedProviderIndices.add(bestIdx);
        }
    }
    return matchedTargetIndices;
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

function candidateCanRepresentRelease(candidate: ProviderAlbumCandidateWithTracks, releaseMbid: string): boolean {
    const compatibleMbids = compatibleReleaseMbids(candidate.match);
    return compatibleMbids.length === 0 || compatibleMbids.includes(releaseMbid);
}

type ReleaseTrackTargets = {
    releaseMbid: string;
    tracks: TargetTrack[];
};

/**
 * Load the audio tracklist of every release in a release group, so provider
 * albums can be validated against the edition they actually correspond to
 * instead of only the single "representative" release.
 */
function loadReleaseTrackTargets(releaseGroupMbid: string): ReleaseTrackTargets[] {
    const rows = db.prepare(`
        SELECT t.release_mbid, t.recording_mbid, rec.isrcs, t.title, t.position, t.medium_position, t.length_ms
        FROM Tracks t
        JOIN AlbumReleases r ON r.mbid = t.release_mbid
        LEFT JOIN Recordings rec ON rec.mbid = t.recording_mbid
        WHERE r.release_group_mbid = ?
          AND COALESCE(rec.is_video, 0) = 0
        ORDER BY t.release_mbid ASC, t.medium_position ASC, t.position ASC
    `).all(releaseGroupMbid) as Array<{
        release_mbid: string;
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
        if (!match?.releaseGroup || (match.status !== "verified" && match.status !== "probable")) {
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
            candidatesWithTracks.sort((a, b) => b.score - a.score);
            const best = candidatesWithTracks[0];
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

        // 2. Single candidate fully covering a release, most complete edition first.
        let selectedSingle: { candidate: ProviderAlbumCandidateWithTracks; releaseMbid: string } | null = null;
        for (const target of releaseTargets) {
            const releaseCompatibleCandidates = candidatesWithTracks.filter(candidate =>
                candidateCanRepresentRelease(candidate, target.releaseMbid)
            );
            const fullCovers = releaseCompatibleCandidates.filter(c =>
                getMatchedTargets1to1(target.tracks, c.tracks).size === target.tracks.length
            );
            if (fullCovers.length > 0) {
                sortCandidatesForSlot(slot, fullCovers);
                selectedSingle = { candidate: fullCovers[0], releaseMbid: target.releaseMbid };
                break;
            }
        }

        if (selectedSingle) {
            const selectedMatch: ProviderReleaseGroupMatch = {
                ...selectedSingle.candidate.match,
                releaseMbid: selectedSingle.releaseMbid,
            };
            bestByReleaseGroupAndSlot.set(key, {
                releaseGroupMbid,
                slot,
                provider: selectedSingle.candidate.provider,
                album: selectedSingle.candidate.album,
                match: selectedMatch,
                score: selectedSingle.candidate.score,
            });
            continue;
        }

        // 3. Combined matching: no single candidate covers any release, so try to
        // assemble full coverage from multiple same-provider albums, again
        // preferring the most complete edition.
        sortCandidatesForSlot(slot, candidatesWithTracks);

        let selectedCombination: {
            candidates: ProviderAlbumCandidateWithTracks[];
            targetTracks: TargetTrack[];
            releaseMbid: string;
        } | null = null;

        for (const target of releaseTargets) {
            const releaseCompatibleCandidates = candidatesWithTracks.filter(candidate =>
                candidateCanRepresentRelease(candidate, target.releaseMbid)
            );
            if (releaseCompatibleCandidates.length === 0) {
                continue;
            }

            const primary = releaseCompatibleCandidates[0];
            const selectedCandidates = [primary];
            let currentCovered = getMatchedTargets1to1(target.tracks, primary.tracks);

            for (let i = 1; i < releaseCompatibleCandidates.length; i++) {
                if (currentCovered.size === target.tracks.length) {
                    break;
                }
                const candidate = releaseCompatibleCandidates[i];
                if (candidate.provider !== primary.provider) {
                    continue; // Only combine candidates from the same provider
                }

                // Check if combining this candidate covers new target tracks 1-to-1
                const combinedTracks = selectedCandidates.concat(candidate).flatMap(c => c.tracks);
                const combinedCovered = getMatchedTargets1to1(target.tracks, combinedTracks);

                if (combinedCovered.size > currentCovered.size) {
                    selectedCandidates.push(candidate);
                    currentCovered = combinedCovered;
                }
            }

            if (currentCovered.size < target.tracks.length) {
                continue;
            }

            // Reject combinations whose provider tracks don't all map back onto the
            // target release — leftovers indicate the albums describe something else.
            if (selectedCandidates.length > 1) {
                const allProviderTracks = selectedCandidates.flatMap(c => c.tracks);
                const hasLeftover = allProviderTracks.some(pt => {
                    return !target.tracks.some(targetTrack => scoreTrackMatch(targetTrack, pt) >= TRACK_MATCH_THRESHOLD);
                });
                if (hasLeftover) {
                    continue;
                }
            }

            selectedCombination = {
                candidates: selectedCandidates,
                targetTracks: target.tracks,
                releaseMbid: target.releaseMbid,
            };
            break;
        }

        if (!selectedCombination) {
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

        const { candidates: combinedCandidates, targetTracks: combinedTargets } = selectedCombination;
        const primary = combinedCandidates[0];
        combinedCandidates.sort((left, right) => {
            const firstCoveredTarget = (candidate: ProviderAlbumCandidateWithTracks) => {
                const covered = getMatchedTargets1to1(combinedTargets, candidate.tracks);
                if (covered.size === 0) return Number.MAX_SAFE_INTEGER;
                return Math.min(...covered);
            };
            return firstCoveredTarget(left) - firstCoveredTarget(right);
        });
        const selectedIds = combinedCandidates.map(c => c.album.providerId);
        const mergedAlbum: ProviderAlbumSlotCandidate = {
            ...primary.album,
            providerId: selectedIds.join(";"),
        };

        const selectedMatch: ProviderReleaseGroupMatch = {
            ...primary.match,
            releaseMbid: selectedCombination.releaseMbid,
        };

        bestByReleaseGroupAndSlot.set(key, {
            releaseGroupMbid,
            slot,
            provider: primary.provider,
            album: mergedAlbum,
            match: selectedMatch,
            score: primary.score,
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
                provider_data = NULL,
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
                provider_data, checked_at, updated_at
            )
            VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            ON CONFLICT(release_group_mbid, slot) DO UPDATE SET
                selected_provider = excluded.selected_provider,
                selected_provider_id = excluded.selected_provider_id,
                selected_release_mbid = excluded.selected_release_mbid,
                quality = excluded.quality,
                match_status = excluded.match_status,
                match_confidence = excluded.match_confidence,
                match_method = excluded.match_method,
                match_evidence = excluded.match_evidence,
                provider_data = excluded.provider_data,
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
                    JSON.stringify(buildProviderOfferSnapshot(selection.album)),
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

        // The per-group selection above can only assemble offers the matcher
        // attached to that one release group. Re-pick each touched slot's release
        // from the whole-artist availability graph (direct + composite coverage),
        // so a larger MB release whose tracks span provider albums matched to
        // *different* groups wins. Composite coverage is only knowable once every
        // album is matched, so this is where selection first sees the full graph —
        // it reads the release graph rather than the per-group candidate buckets.
        this.selectLargestCoveredReleasePerSlot(selections);

        return counts;
    }

    private static selectLargestCoveredReleasePerSlot(
        selections: ReleaseGroupSlotSelection[],
    ): void {
        const slotsByGroup = new Map<string, Set<string>>();
        for (const selection of selections) {
            let slots = slotsByGroup.get(selection.releaseGroupMbid);
            if (!slots) {
                slots = new Set();
                slotsByGroup.set(selection.releaseGroupMbid, slots);
            }
            slots.add(selection.slot);
        }

        const qualityRank = (quality: string | null | undefined): number => {
            const q = String(quality || "").toUpperCase();
            if (q.includes("ATMOS") || q.includes("SPATIAL")) return 4;
            if (q.includes("HIRES")) return 3;
            if (q.includes("LOSSLESS")) return 2;
            if (q.includes("HIGH")) return 1;
            return 0;
        };

        for (const [releaseGroupMbid, slots] of slotsByGroup) {
            const availability = getReleaseGroupAvailability(releaseGroupMbid);
            const trackCountByRelease = new Map(
                availability.releases.map((release) => [release.releaseMbid, release.trackCount ?? 0]),
            );

            for (const slot of slots) {
                const currentReleaseMbid = availability.selectedReleaseBySlot[slot] ?? null;
                const currentTracks = currentReleaseMbid ? (trackCountByRelease.get(currentReleaseMbid) ?? 0) : 0;

                let best: { releaseMbid: string; tracks: number; offer: ReleaseAvailabilityProvider } | null = null;
                for (const release of availability.releases) {
                    const tracks = release.trackCount ?? 0;
                    const offer = release.availability
                        .filter((candidate) => (candidate.librarySlot ?? "stereo") === slot)
                        .sort((a, b) => qualityRank(b.quality) - qualityRank(a.quality))[0];
                    if (!offer) continue;
                    if (!best || tracks > best.tracks) {
                        best = { releaseMbid: release.releaseMbid, tracks, offer };
                    }
                }

                if (!best || best.tracks <= currentTracks || best.releaseMbid === currentReleaseMbid) {
                    continue;
                }

                const providerAlbumId = best.offer.providerAlbumIds?.length
                    ? best.offer.providerAlbumIds.join(";")
                    : best.offer.providerAlbumId;
                try {
                    setSlotSelection({
                        releaseGroupMbid,
                        slot,
                        releaseMbid: best.releaseMbid,
                        provider: best.offer.provider,
                        providerAlbumId,
                    });
                } catch (error) {
                    console.warn(
                        `[Slots] Could not select larger covered release ${best.releaseMbid} for ${releaseGroupMbid}:${slot}:`,
                        (error as Error)?.message,
                    );
                }
            }
        }
    }
}
