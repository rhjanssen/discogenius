import { db } from "../database.js";
import { getConfigSection } from "./config.js";
import type { ProviderReleaseGroupMatch } from "./metadata/provider-release-group-matcher.js";
import { isSpatialAudioQuality, normalizeQualityTag } from "../utils/spatial-audio.js";
import { normalizeComparableText, providerTrackComparableTitle, stringSimilarity } from "./import-matching-utils.js";
import { MusicBrainzReleaseSelectionService } from "./musicbrainz-release-selection-service.js";

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
    album: ProviderAlbumSlotCandidate;
    match: ProviderReleaseGroupMatch;
    score: number;
    tracks: Array<ProviderTrackDetail>;
};

function scoreTrackMatch(target: TargetTrack, pt: ProviderTrackDetail): number {
    if (target.recordingMbid && pt.mbid && target.recordingMbid === pt.mbid) {
        return 1.0;
    }
    if (pt.isrc && target.isrcs.has(pt.isrc)) {
        return 1.0;
    }
    if (!target.title || !pt.title) {
        return 0.0;
    }
    const titleSimilarity = stringSimilarity(
        normalizeComparableText(target.title),
        normalizeComparableText(providerTrackComparableTitle(pt)),
    );
    if (titleSimilarity < 0.72) {
        return 0.0;
    }

    const volumeScore = Number(target.mediumPosition || 1) === Number(pt.volume_number || 1) ? 0.2 : 0;
    const trackScore = Number(target.position || 0) === Number(pt.track_number || 0) ? 0.2 : 0;
    const titleScore = titleSimilarity * 0.5;
    const durationSeconds = Number(target.lengthMs || 0) / 1000;
    const durationDelta = Math.abs(durationSeconds - Number(pt.duration || 0));
    const durationScore = durationSeconds > 0 && Number(pt.duration || 0) > 0
        ? Math.max(0, 1 - (durationDelta / Math.max(8, durationSeconds * 0.08))) * 0.1
        : 0;

    return volumeScore + trackScore + titleScore + durationScore;
}

function isTrackCovered(target: TargetTrack, providerTracks: Array<ProviderTrackDetail>): boolean {
    return providerTracks.some(pt => {
        return scoreTrackMatch(target, pt) >= 0.55;
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

        const targetTrackList: TargetTrack[] = [];
        if (preferredReleaseRow) {
            const targetTracks = db.prepare(`
                SELECT t.recording_mbid, r.isrcs, t.title, t.position, t.medium_position, t.length_ms
                FROM Tracks t
                LEFT JOIN Recordings r ON r.mbid = t.recording_mbid
                WHERE t.release_mbid = ?
                ORDER BY t.medium_position ASC, t.position ASC
            `).all(preferredReleaseRow.mbid) as Array<{
                recording_mbid: string | null;
                isrcs: string | null;
                title: string;
                position: number;
                medium_position: number;
                length_ms: number | null;
            }>;

            for (const track of targetTracks) {
                const isrcs = new Set<string>();
                if (track.isrcs) {
                    try {
                        const parsed = JSON.parse(track.isrcs);
                        if (Array.isArray(parsed)) {
                            for (const isrc of parsed) {
                                const norm = normalizeIsrc(isrc);
                                if (norm) isrcs.add(norm);
                            }
                        }
                    } catch {
                        // Ignore
                    }
                }
                const recordingMbid = track.recording_mbid ? String(track.recording_mbid).trim() : null;
                targetTrackList.push({
                    recordingMbid,
                    isrcs,
                    title: track.title,
                    position: track.position,
                    mediumPosition: track.medium_position,
                    lengthMs: track.length_ms,
                });
            }
        }


        const preferredCompatibleCandidates = preferredReleaseRow
            ? groupCandidates.filter((candidate) => compatibleReleaseMbids(candidate.match).includes(preferredReleaseRow.mbid))
            : [];
        const slotCandidates = targetTrackList.length > 0
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
        if (targetTrackList.length === 0 || !hasTrackDetails) {
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

        // 2. Check if any candidates are "Full covers"
        const fullCovers = candidatesWithTracks.filter(c =>
            targetTrackList.every(target => isTrackCovered(target, c.tracks))
        );

        if (fullCovers.length > 0) {
            // Sort by quality score first, then candidate score descending
            sortCandidatesForSlot(slot, fullCovers);
            const bestFullCover = fullCovers[0];
            const selectedMatch: ProviderReleaseGroupMatch = {
                ...bestFullCover.match,
                releaseMbid: selectReleaseMbidForCandidate(releaseGroupMbid, bestFullCover, preferredReleaseRow?.mbid),
            };
            bestByReleaseGroupAndSlot.set(key, {
                releaseGroupMbid,
                slot,
                provider: bestFullCover.provider,
                album: bestFullCover.album,
                match: selectedMatch,
                score: bestFullCover.score,
            });
            continue;
        }

        // 3. Fallback to combined matching since no single candidate fully covers the target tracks
        sortCandidatesForSlot(slot, candidatesWithTracks);

        const primary = candidatesWithTracks[0];
        const selectedCandidates = [primary];
        const coveredTargets = new Set<number>();

        targetTrackList.forEach((target, index) => {
            if (isTrackCovered(target, primary.tracks)) {
                coveredTargets.add(index);
            }
        });

        for (let i = 1; i < candidatesWithTracks.length; i++) {
            if (coveredTargets.size === targetTrackList.length) {
                break;
            }
            const candidate = candidatesWithTracks[i];
            if (candidate.provider !== primary.provider) {
                continue; // Only combine candidates from the same provider
            }
            let coversNewTrack = false;
            const newlyCovered: number[] = [];

            targetTrackList.forEach((target, index) => {
                if (!coveredTargets.has(index) && isTrackCovered(target, candidate.tracks)) {
                    coversNewTrack = true;
                    newlyCovered.push(index);
                }
            });

            if (coversNewTrack) {
                selectedCandidates.push(candidate);
                newlyCovered.forEach(index => coveredTargets.add(index));
            }
        }

        if (coveredTargets.size < targetTrackList.length) {
            continue;
        }

        // Check: no provider tracks left over across the combined candidate releases (if combined)
        if (selectedCandidates.length > 1) {
            const allProviderTracks = selectedCandidates.flatMap(c => c.tracks);
            const hasLeftover = allProviderTracks.some(pt => {
                return !targetTrackList.some(target => scoreTrackMatch(target, pt) >= 0.55);
            });
            if (hasLeftover) {
                continue;
            }
        }

        selectedCandidates.sort((left, right) => {
            const firstCoveredTarget = (candidate: ProviderAlbumCandidateWithTracks) => {
                const index = targetTrackList.findIndex((target) => isTrackCovered(target, candidate.tracks));
                return index === -1 ? Number.MAX_SAFE_INTEGER : index;
            };
            return firstCoveredTarget(left) - firstCoveredTarget(right);
        });
        const selectedIds = selectedCandidates.map(c => c.album.providerId);
        const mergedAlbum: ProviderAlbumSlotCandidate = {
            ...primary.album,
            providerId: selectedIds.join(";"),
        };

        const selectedMatch: ProviderReleaseGroupMatch = {
            ...primary.match,
            releaseMbid: selectReleaseMbidForCandidate(releaseGroupMbid, primary, preferredReleaseRow?.mbid),
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

    return Array.from(bestByReleaseGroupAndSlot.values())
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
                artist_mbid, release_group_mbid, slot, wanted,
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
                counts[selection.slot] += 1;
            }
        })();

        return counts;
    }
}
