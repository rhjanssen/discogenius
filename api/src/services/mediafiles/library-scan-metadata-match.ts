import path from "path";
import { db } from "../../database.js";
import {
    normalizeComparableText,
    sameRecordingTitle,
} from "./import-matching-utils.js";
import type { LibraryRootKey } from "./library-scan-relink.js";

export type MetadataMatchResult = {
    albumId: string | null;
    mediaId: string;
    provider: string;
    fileType: "track";
    quality: string | null;
    librarySlot: string;
    /** True when another on-disk TrackFile already owns this provider offer. */
    duplicateOfExisting: boolean;
    existingFilePath: string | null;
};

export type ParsedAudioTags = {
    title?: string | null;
    album?: string | null;
    artist?: string | null;
    isrc?: string | string[] | null;
    musicbrainzRecordingId?: string | null;
    musicbrainzTrackId?: string | null;
    musicbrainzAlbumId?: string | null;
    durationSeconds?: number | null;
};

type ProviderOfferRow = {
    provider: string;
    provider_id: string;
    title: string;
    provider_album_id: string | null;
    recording_id: number | null;
    recording_mbid: string | null;
    isrc: string | null;
    duration: number | null;
    quality: string | null;
    library_slot: string | null;
};

const DURATION_TOLERANCE_SECONDS = 3;

function librarySlotForRoot(libraryRoot: LibraryRootKey): string {
    if (libraryRoot === "spatial") return "spatial";
    if (libraryRoot === "videos") return "video";
    return "stereo";
}

function firstIsrc(value: string | string[] | null | undefined): string | null {
    if (!value) return null;
    if (Array.isArray(value)) {
        const first = value.map((entry) => String(entry || "").trim().toUpperCase()).find(Boolean);
        return first || null;
    }
    const normalized = String(value).trim().toUpperCase();
    return normalized || null;
}

function durationClose(left: number | null | undefined, right: number | null | undefined): boolean {
    if (!left || !right || left <= 0 || right <= 0) return true;
    return Math.abs(left - right) <= DURATION_TOLERANCE_SECONDS;
}

function scoreOffer(
    offer: ProviderOfferRow,
    tags: ParsedAudioTags,
    preferredAlbumIds: Set<string>,
    preferredSlot: string,
): number {
    let score = 0;
    if (preferredAlbumIds.has(String(offer.provider_album_id || ""))) score += 40;
    if ((offer.library_slot || "stereo") === preferredSlot) score += 10;
    if (tags.durationSeconds && offer.duration && durationClose(tags.durationSeconds, offer.duration)) {
        score += 20;
        score += Math.max(0, 5 - Math.abs(tags.durationSeconds - offer.duration));
    }
    if (sameRecordingTitle(tags.title, offer.title)) score += 30;
    else if (normalizeComparableText(tags.title) === normalizeComparableText(offer.title)) score += 15;
    return score;
}

function pickBestOffer(
    offers: ProviderOfferRow[],
    tags: ParsedAudioTags,
    preferredAlbumIds: Set<string>,
    preferredSlot: string,
): ProviderOfferRow | null {
    if (offers.length === 0) return null;
    if (offers.length === 1) return offers[0];

    const ranked = offers
        .map((offer) => ({ offer, score: scoreOffer(offer, tags, preferredAlbumIds, preferredSlot) }))
        .sort((left, right) => right.score - left.score || String(left.offer.provider_id).localeCompare(String(right.offer.provider_id)));

    const best = ranked[0];
    const second = ranked[1];
    if (!best || best.score < 30) return null;
    if (second && second.score === best.score && second.offer.provider_id !== best.offer.provider_id) {
        // Ambiguous same-score winners — require album affinity or exact duration.
        if (!preferredAlbumIds.has(String(best.offer.provider_album_id || ""))) {
            return null;
        }
    }
    return best.offer;
}

function folderAlbumIds(filePath: string, artistId: string, tags?: ParsedAudioTags): Set<string> {
    const folder = path.dirname(filePath);
    const normalizedFolder = folder.replace(/\\/g, "/");
    const folderName = path.basename(folder).replace(/\s*\(\d{4}\)\s*$/, "").trim();

    const albumIds = new Set<string>();

    const rows = db.prepare(`
        SELECT DISTINCT CAST(pi.provider_album_id AS TEXT) AS album_id
        FROM TrackFiles tf
        JOIN ProviderItems pi
          ON CAST(pi.provider_id AS TEXT) = CAST(tf.provider_id AS TEXT)
         AND pi.entity_type IN ('track', 'video')
         AND (tf.provider IS NULL OR pi.provider = tf.provider)
        WHERE tf.artist_id = ?
          AND tf.provider_id IS NOT NULL
          AND replace(tf.file_path, '\\', '/') LIKE ? || '/%'
          AND pi.provider_album_id IS NOT NULL
    `).all(artistId, normalizedFolder) as Array<{ album_id: string }>;

    for (const row of rows) {
        if (row.album_id) albumIds.add(String(row.album_id));
    }

    // Check tags.musicbrainzAlbumId if present
    const mbid = tags?.musicbrainzAlbumId?.trim() || null;
    if (mbid) {
        const mbidOffers = db.prepare(`
            SELECT DISTINCT CAST(provider_id AS TEXT) AS provider_album_id
            FROM ProviderItems
            WHERE entity_type = 'album'
              AND (release_mbid = ? OR release_group_mbid = ?)
        `).all(mbid, mbid) as Array<{ provider_album_id: string }>;
        for (const row of mbidOffers) {
            if (row.provider_album_id) albumIds.add(String(row.provider_album_id));
        }
    }

    // Match album title from tags or folder name against Albums & ProviderItems
    const albumTitleCandidate = tags?.album?.trim() || folderName;
    if (albumTitleCandidate) {
        const albumRows = db.prepare(`
            SELECT pi.provider_id AS provider_album_id, COALESCE(a.title, pi.title) AS title
            FROM ProviderItems pi
            LEFT JOIN Albums a ON a.mbid = pi.release_group_mbid
            JOIN Artists artist ON artist.mbid = pi.artist_mbid OR CAST(artist.id AS TEXT) = CAST(pi.artist_mbid AS TEXT)
            WHERE pi.entity_type = 'album'
              AND artist.id = ?
        `).all(artistId) as Array<{ provider_album_id: string; title: string }>;

        for (const row of albumRows) {
            if (row.provider_album_id && row.title && sameRecordingTitle(albumTitleCandidate, row.title)) {
                albumIds.add(String(row.provider_album_id));
            }
        }
    }

    return albumIds;
}

function existingTrackFileForOffer(
    artistId: string,
    provider: string,
    providerId: string,
    librarySlot: string,
): { file_path: string } | undefined {
    return db.prepare(`
        SELECT file_path
        FROM TrackFiles
        WHERE artist_id = ?
          AND provider = ?
          AND provider_entity_type = 'track'
          AND CAST(provider_id AS TEXT) = CAST(? AS TEXT)
          AND file_type = 'track'
          AND library_slot = ?
        ORDER BY verified_at DESC, id DESC
        LIMIT 1
    `).get(artistId, provider, providerId, librarySlot) as { file_path: string } | undefined;
}

function offersByRecordingMbid(artistId: string, recordingMbid: string, preferredSlot: string): ProviderOfferRow[] {
    return db.prepare(`
        SELECT pi.provider, pi.provider_id, pi.title, pi.provider_album_id, pi.recording_id,
               pi.recording_mbid, pi.isrc, pi.duration, pi.quality, pi.library_slot
        FROM ProviderItems pi
        JOIN Artists a ON a.mbid = pi.artist_mbid OR CAST(a.id AS TEXT) = CAST(pi.artist_mbid AS TEXT)
        WHERE pi.entity_type = 'track'
          AND a.id = ?
          AND pi.recording_mbid = ?
          AND (pi.library_slot IS NULL OR pi.library_slot = ?)
    `).all(artistId, recordingMbid, preferredSlot) as ProviderOfferRow[];
}

function offersByIsrc(artistId: string, isrc: string, preferredSlot: string): ProviderOfferRow[] {
    return db.prepare(`
        SELECT pi.provider, pi.provider_id, pi.title, pi.provider_album_id, pi.recording_id,
               pi.recording_mbid, pi.isrc, pi.duration, pi.quality, pi.library_slot
        FROM ProviderItems pi
        JOIN Artists a ON a.mbid = pi.artist_mbid OR CAST(a.id AS TEXT) = CAST(pi.artist_mbid AS TEXT)
        WHERE pi.entity_type = 'track'
          AND a.id = ?
          AND upper(pi.isrc) = ?
          AND (pi.library_slot IS NULL OR pi.library_slot = ?)
    `).all(artistId, isrc, preferredSlot) as ProviderOfferRow[];
}

function offersByTitleInAlbums(
    artistId: string,
    title: string,
    albumIds: Set<string>,
    preferredSlot: string,
    durationSeconds: number | null | undefined,
): ProviderOfferRow[] {
    if (albumIds.size === 0) return [];
    const albumList = Array.from(albumIds);
    const placeholders = albumList.map(() => "?").join(", ");
    const rows = db.prepare(`
        SELECT pi.provider, pi.provider_id, pi.title, pi.provider_album_id, pi.recording_id,
               pi.recording_mbid, pi.isrc, pi.duration, pi.quality, pi.library_slot
        FROM ProviderItems pi
        JOIN Artists a ON a.mbid = pi.artist_mbid OR CAST(a.id AS TEXT) = CAST(pi.artist_mbid AS TEXT)
        WHERE pi.entity_type = 'track'
          AND a.id = ?
          AND CAST(pi.provider_album_id AS TEXT) IN (${placeholders})
          AND (pi.library_slot IS NULL OR pi.library_slot = ?)
    `).all(artistId, ...albumList, preferredSlot) as ProviderOfferRow[];

    return rows.filter((offer) =>
        sameRecordingTitle(title, offer.title)
        && durationClose(durationSeconds, offer.duration)
    );
}

function offersByTitleForArtist(
    artistId: string,
    title: string,
    preferredSlot: string,
    durationSeconds: number | null | undefined,
): ProviderOfferRow[] {
    const rows = db.prepare(`
        SELECT pi.provider, pi.provider_id, pi.title, pi.provider_album_id, pi.recording_id,
               pi.recording_mbid, pi.isrc, pi.duration, pi.quality, pi.library_slot
        FROM ProviderItems pi
        JOIN Artists a ON a.mbid = pi.artist_mbid OR CAST(a.id AS TEXT) = CAST(pi.artist_mbid AS TEXT)
        WHERE pi.entity_type = 'track'
          AND a.id = ?
          AND (pi.library_slot IS NULL OR pi.library_slot = ?)
    `).all(artistId, preferredSlot) as ProviderOfferRow[];

    return rows.filter((offer) =>
        sameRecordingTitle(title, offer.title)
        && durationClose(durationSeconds ?? null, offer.duration)
    );
}

function findSameFolderDuplicate(
    filePath: string,
    artistId: string,
    tags: ParsedAudioTags,
): { provider: string; providerId: string; albumId: string | null; quality: string | null; librarySlot: string; existingFilePath: string } | null {
    if (!tags.title) return null;
    const folder = path.dirname(filePath).replace(/\\/g, "/");
    const rows = db.prepare(`
        SELECT tf.file_path, tf.provider, tf.provider_id, tf.library_slot, tf.quality, tf.duration,
               pi.title, pi.provider_album_id, pi.duration AS offer_duration, pi.recording_id
        FROM TrackFiles tf
        LEFT JOIN ProviderItems pi
          ON CAST(pi.provider_id AS TEXT) = CAST(tf.provider_id AS TEXT)
         AND pi.entity_type IN ('track', 'video')
         AND (tf.provider IS NULL OR pi.provider = tf.provider)
        WHERE tf.artist_id = ?
          AND tf.file_type = 'track'
          AND tf.provider_id IS NOT NULL
          AND replace(tf.file_path, '\\', '/') LIKE ? || '/%'
    `).all(artistId, folder) as Array<{
        file_path: string;
        provider: string | null;
        provider_id: string;
        library_slot: string | null;
        quality: string | null;
        duration: number | null;
        title: string | null;
        provider_album_id: string | null;
        offer_duration: number | null;
        recording_id: number | null;
    }>;

    const candidates = rows.filter((row) => {
        if (path.resolve(row.file_path) === path.resolve(filePath)) return false;
        const title = row.title || path.parse(row.file_path).name.replace(/^\d+\s*-\s*/, "");
        if (!sameRecordingTitle(tags.title, title)) return false;
        const duration = row.offer_duration ?? row.duration;
        return durationClose(tags.durationSeconds, duration);
    });

    if (candidates.length !== 1) return null;
    const hit = candidates[0];
    return {
        provider: hit.provider || "tidal",
        providerId: String(hit.provider_id),
        albumId: hit.provider_album_id ? String(hit.provider_album_id) : null,
        quality: hit.quality || null,
        librarySlot: hit.library_slot || "stereo",
        existingFilePath: hit.file_path,
    };
}

/**
 * Rematch an on-disk audio file that lacks an embedded provider id / expected
 * path, using tags + nearby album-folder TrackFiles. Used by library scan so
 * Discogenius-organized files are not stuck in UnmappedFiles when a provider
 * offer already exists.
 */
export function matchAudioFileByMetadata(
    filePath: string,
    artistId: string,
    libraryRoot: LibraryRootKey,
    tags: ParsedAudioTags,
): MetadataMatchResult | null {
    const preferredSlot = librarySlotForRoot(libraryRoot);

    // Prefer same-folder title+duration siblings first. Wild World Complete vs
    // standard share a recording MBID but different provider album ids; linking
    // the leftover 201 file to Complete Edition would create a second TrackFile.
    const folderDuplicate = findSameFolderDuplicate(filePath, artistId, tags);
    if (folderDuplicate) {
        return {
            albumId: folderDuplicate.albumId,
            mediaId: folderDuplicate.providerId,
            provider: folderDuplicate.provider,
            fileType: "track",
            quality: folderDuplicate.quality,
            librarySlot: folderDuplicate.librarySlot || preferredSlot,
            duplicateOfExisting: true,
            existingFilePath: folderDuplicate.existingFilePath,
        };
    }

    const preferredAlbumIds = folderAlbumIds(filePath, artistId, tags);
    const isrc = firstIsrc(tags.isrc);
    const recordingMbid = tags.musicbrainzRecordingId?.trim() || null;

    let offers: ProviderOfferRow[] = [];
    if (recordingMbid) {
        offers = offersByRecordingMbid(artistId, recordingMbid, preferredSlot);
    }
    if (offers.length === 0 && isrc) {
        offers = offersByIsrc(artistId, isrc, preferredSlot);
    }
    if (offers.length === 0 && tags.title) {
        offers = offersByTitleInAlbums(
            artistId,
            tags.title,
            preferredAlbumIds,
            preferredSlot,
            tags.durationSeconds,
        );
    }
    if (offers.length === 0 && tags.title && preferredAlbumIds.size === 0) {
        // No sibling TrackFiles to scope by album — only accept a unique
        // title+duration winner for the artist.
        const artistOffers = offersByTitleForArtist(
            artistId,
            tags.title,
            preferredSlot,
            tags.durationSeconds,
        );
        if (artistOffers.length === 1) {
            offers = artistOffers;
        } else if (artistOffers.length > 1 && tags.durationSeconds) {
            const exactDuration = artistOffers.filter((offer) =>
                offer.duration != null && Math.abs(offer.duration - tags.durationSeconds!) === 0
            );
            if (exactDuration.length === 1) {
                offers = exactDuration;
            }
        }
    }

    const best = pickBestOffer(offers, tags, preferredAlbumIds, preferredSlot);
    if (!best) return null;

    const librarySlot = best.library_slot || preferredSlot;
    const existing = existingTrackFileForOffer(artistId, best.provider, String(best.provider_id), librarySlot);
    const resolvedExisting = existing?.file_path || null;
    const duplicateOfExisting = Boolean(
        resolvedExisting
        && path.resolve(resolvedExisting) !== path.resolve(filePath)
    );

    return {
        albumId: best.provider_album_id ? String(best.provider_album_id) : null,
        mediaId: String(best.provider_id),
        provider: best.provider,
        fileType: "track",
        quality: best.quality || null,
        librarySlot,
        duplicateOfExisting,
        existingFilePath: duplicateOfExisting ? resolvedExisting : null,
    };
}
