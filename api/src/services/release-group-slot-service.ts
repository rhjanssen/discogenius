import { db } from "../database.js";
import { getConfigSection } from "./config.js";
import type { ProviderReleaseGroupMatch } from "./metadata/provider-release-group-matcher.js";
import { isSpatialAudioQuality, normalizeQualityTag } from "../utils/spatial-audio.js";

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
    raw?: unknown;
};

export type ReleaseGroupSlotSelection = {
    releaseGroupMbid: string;
    slot: ReleaseGroupLibrarySlot;
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
    const trackShapeBonus = evidence.trackCountMatched
        ? 160
        : targetTrackCount > 0 && tracks > 0
            ? -Math.min(240, Math.max(1, Math.abs(targetTrackCount - tracks)) * 36)
            : 0;
    const volumeShapeBonus = evidence.volumeCountMatched
        ? 32
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
};

type ProviderAlbumCandidateWithTracks = {
    album: ProviderAlbumSlotCandidate;
    match: ProviderReleaseGroupMatch;
    score: number;
    tracks: Array<{ mbid: string | null; isrc: string | null }>;
};

function isTrackCovered(target: TargetTrack, providerTracks: Array<{ mbid: string | null; isrc: string | null }>): boolean {
    return providerTracks.some(pt => {
        if (target.recordingMbid && pt.mbid && target.recordingMbid === pt.mbid) {
            return true;
        }
        if (pt.isrc && target.isrcs.has(pt.isrc)) {
            return true;
        }
        return false;
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

export function selectReleaseGroupSlotAlbums(
    albums: ProviderAlbumSlotCandidate[],
    matches: Map<string, ProviderReleaseGroupMatch>,
    options: { includeSpatial?: boolean; preferExplicit?: boolean } = {},
): ReleaseGroupSlotSelection[] {
    const includeSpatial = options.includeSpatial === true;
    const preferExplicit = options.preferExplicit !== false;
    const bestByReleaseGroupAndSlot = new Map<string, ReleaseGroupSlotSelection>();

    // Group candidates by releaseGroupMbid:slot
    const candidatesByGroupAndSlot = new Map<string, Array<{ album: ProviderAlbumSlotCandidate; match: ProviderReleaseGroupMatch; score: number }>>();

    for (const album of albums) {
        const match = matches.get(album.providerId);
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
        list.push({ album, match, score });
    }

    for (const [key, groupCandidates] of candidatesByGroupAndSlot.entries()) {
        if (groupCandidates.length === 0) continue;

        const colonIndex = key.lastIndexOf(":");
        const releaseGroupMbid = key.substring(0, colonIndex);
        const slot = key.substring(colonIndex + 1) as ReleaseGroupLibrarySlot;

        // Query database for preferred MusicBrainz release
        const preferredReleaseRow = db.prepare(`
            SELECT r.mbid FROM AlbumReleases r
            WHERE r.release_group_mbid = ?
            ORDER BY
                (EXISTS (
                    SELECT 1 FROM AlbumReleaseMedia m
                    WHERE m.release_mbid = r.mbid
                      AND LOWER(COALESCE(m.format, '')) LIKE '%digital%'
                )) DESC,
                CASE LOWER(COALESCE(r.status, '')) WHEN 'official' THEN 0 ELSE 1 END ASC,
                COALESCE(r.track_count, 0) DESC,
                (r.date IS NULL) ASC,
                r.date DESC,
                r.mbid ASC
            LIMIT 1
        `).get(releaseGroupMbid) as { mbid: string } | undefined;

        let targetTrackList: TargetTrack[] = [];
        if (preferredReleaseRow) {
            const targetTracks = db.prepare(`
                SELECT t.recording_mbid, r.isrcs
                FROM Tracks t
                LEFT JOIN Recordings r ON r.mbid = t.recording_mbid
                WHERE t.release_mbid = ?
            `).all(preferredReleaseRow.mbid) as Array<{ recording_mbid: string | null; isrcs: string | null }>;

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
                targetTrackList.push({
                    recordingMbid: track.recording_mbid ? String(track.recording_mbid).trim() : null,
                    isrcs,
                });
            }
        }

        // Fetch tracks for all candidates in this group
        const candidatesWithTracks: ProviderAlbumCandidateWithTracks[] = groupCandidates.map(c => {
            const rows = db.prepare(`
                SELECT mbid, isrc FROM ProviderMedia
                WHERE album_id = ?
            `).all(c.album.providerId) as Array<{ mbid: string | null; isrc: string | null }>;

            const tracks = rows.map(r => ({
                mbid: r.mbid ? String(r.mbid).trim() : null,
                isrc: r.isrc ? normalizeIsrc(r.isrc) : null,
            }));

            return { ...c, tracks };
        });

        // 1. Fallback to legacy single candidate selection if there are no target tracks
        if (targetTrackList.length === 0) {
            candidatesWithTracks.sort((a, b) => b.score - a.score);
            const best = candidatesWithTracks[0];
            bestByReleaseGroupAndSlot.set(key, {
                releaseGroupMbid,
                slot,
                album: best.album,
                match: best.match,
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
            bestByReleaseGroupAndSlot.set(key, {
                releaseGroupMbid,
                slot,
                album: bestFullCover.album,
                match: bestFullCover.match,
                score: bestFullCover.score,
            });
            continue;
        }

        // 3. Fallback to combined matching since no single candidate fully covers the target tracks
        sortCandidatesForSlot(slot, candidatesWithTracks);

        const primary = candidatesWithTracks[0];
        const selectedIds = [primary.album.providerId];
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
            let coversNewTrack = false;
            const newlyCovered: number[] = [];

            targetTrackList.forEach((target, index) => {
                if (!coveredTargets.has(index) && isTrackCovered(target, candidate.tracks)) {
                    coversNewTrack = true;
                    newlyCovered.push(index);
                }
            });

            if (coversNewTrack) {
                selectedIds.push(candidate.album.providerId);
                newlyCovered.forEach(index => coveredTargets.add(index));
            }
        }

        if (coveredTargets.size < targetTrackList.length) {
            continue;
        }

        const mergedAlbum: ProviderAlbumSlotCandidate = {
            ...primary.album,
            providerId: selectedIds.join(";"),
        };

        bestByReleaseGroupAndSlot.set(key, {
            releaseGroupMbid,
            slot,
            album: mergedAlbum,
            match: primary.match,
            score: primary.score,
        });
    }

    return Array.from(bestByReleaseGroupAndSlot.values())
        .sort((left, right) => left.releaseGroupMbid.localeCompare(right.releaseGroupMbid) || left.slot.localeCompare(right.slot));
}

export class ReleaseGroupSlotService {
    static syncProviderAlbumSelections(input: {
        provider: string;
        artistMbid: string | null;
        albums: ProviderAlbumSlotCandidate[];
        matches: Map<string, ProviderReleaseGroupMatch>;
    }): { stereo: number; spatial: number } {
        if (!input.artistMbid) {
            return { stereo: 0, spatial: 0 };
        }

        const filteringConfig = getConfigSection("filtering");
        const selections = selectReleaseGroupSlotAlbums(input.albums, input.matches, {
            includeSpatial: filteringConfig.include_spatial === true,
            preferExplicit: filteringConfig.prefer_explicit !== false,
        });

        const selectionKeys = new Set(selections.map((selection) => `${selection.releaseGroupMbid}:${selection.slot}`));
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
            SELECT id, release_group_mbid, slot
            FROM ReleaseGroupSlots
            WHERE artist_mbid = ?
              AND selected_provider = ?
        `).all(input.artistMbid, input.provider) as Array<{ id: number; release_group_mbid: string; slot: string }>;

        const upsert = db.prepare(`
            INSERT INTO ReleaseGroupSlots (
                artist_mbid, release_group_mbid, slot, wanted,
                selected_provider, selected_provider_id, selected_release_mbid, quality,
                match_status, match_confidence, match_method, match_evidence,
                provider_data, checked_at, updated_at
            )
            VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            ON CONFLICT(release_group_mbid, slot) DO UPDATE SET
                artist_mbid = excluded.artist_mbid,
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
        db.transaction(() => {
            for (const existing of existingSlots) {
                const key = `${existing.release_group_mbid}:${existing.slot}`;
                if (!selectionKeys.has(key)) {
                    clearStaleSelection.run(existing.id);
                }
            }

            for (const selection of selections) {
                upsert.run(
                    input.artistMbid,
                    selection.releaseGroupMbid,
                    selection.slot,
                    input.provider,
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
