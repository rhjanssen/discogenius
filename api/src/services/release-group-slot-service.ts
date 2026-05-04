import { db } from "../database.js";
import { getConfigSection } from "./config.js";
import type { ProviderReleaseGroupMatch } from "./metadata/provider-release-group-matcher.js";

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

function normalizeQuality(value?: string | null): string {
    return String(value || "").trim().toUpperCase();
}

function slotForQuality(quality?: string | null): ReleaseGroupLibrarySlot {
    const normalized = normalizeQuality(quality);
    return normalized === "DOLBY_ATMOS" || normalized === "SONY_360RA" ? "spatial" : "stereo";
}

function qualityScore(slot: ReleaseGroupLibrarySlot, quality?: string | null): number {
    const normalized = normalizeQuality(quality);
    if (slot === "spatial") {
        if (normalized === "DOLBY_ATMOS") return 1000;
        if (normalized === "SONY_360RA") return 950;
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

    return Number((
        qualityScore(slot, album.quality)
        + matchBonus
        + (match.confidence * 20)
        + (tracks * 8)
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
            includeSpatial: filteringConfig.include_atmos === true,
            preferExplicit: filteringConfig.prefer_explicit !== false,
        });

        if (selections.length === 0) {
            return { stereo: 0, spatial: 0 };
        }

        const upsert = db.prepare(`
            INSERT INTO release_group_slots (
                artist_mbid, release_group_mbid, slot, wanted,
                selected_provider, selected_provider_id, quality,
                match_status, match_confidence, match_method, match_evidence,
                provider_data, checked_at, updated_at
            )
            VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            ON CONFLICT(release_group_mbid, slot) DO UPDATE SET
                artist_mbid = excluded.artist_mbid,
                wanted = excluded.wanted,
                selected_provider = excluded.selected_provider,
                selected_provider_id = excluded.selected_provider_id,
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
            for (const selection of selections) {
                upsert.run(
                    input.artistMbid,
                    selection.releaseGroupMbid,
                    selection.slot,
                    input.provider,
                    selection.album.providerId,
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
