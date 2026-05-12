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

export function selectReleaseGroupSlotAlbums(
    albums: ProviderAlbumSlotCandidate[],
    matches: Map<string, ProviderReleaseGroupMatch>,
    options: { includeSpatial?: boolean; preferExplicit?: boolean } = {},
): ReleaseGroupSlotSelection[] {
    const includeSpatial = options.includeSpatial === true;
    const preferExplicit = options.preferExplicit !== false;
    const bestByReleaseGroupAndSlot = new Map<string, ReleaseGroupSlotSelection>();

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
        const current = bestByReleaseGroupAndSlot.get(key);
        if (!current || score > current.score) {
            bestByReleaseGroupAndSlot.set(key, {
                releaseGroupMbid: match.releaseGroup.mbid,
                slot,
                album,
                match,
                score,
            });
        }
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
            UPDATE release_group_slots
            SET
                wanted = 0,
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
            FROM release_group_slots
            WHERE artist_mbid = ?
              AND selected_provider = ?
        `).all(input.artistMbid, input.provider) as Array<{ id: number; release_group_mbid: string; slot: string }>;

        const upsert = db.prepare(`
            INSERT INTO release_group_slots (
                artist_mbid, release_group_mbid, slot, wanted,
                selected_provider, selected_provider_id, selected_release_mbid, quality,
                match_status, match_confidence, match_method, match_evidence,
                provider_data, checked_at, updated_at
            )
            VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            ON CONFLICT(release_group_mbid, slot) DO UPDATE SET
                artist_mbid = excluded.artist_mbid,
                wanted = excluded.wanted,
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
                    JSON.stringify(selection.album.raw ?? selection.album),
                );
                counts[selection.slot] += 1;
            }
        })();

        return counts;
    }
}
