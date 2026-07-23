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

function folderAlbumIds(filePath: string, artistId: string): Set<string> {
    const folder = path.dirname(filePath);
    const rows = db.prepare(`
        SELECT DISTINCT CAST(pi.provider_album_id AS TEXT) AS album_id
        FROM TrackFiles tf
        JOIN ProviderItems pi
          ON CAST(pi.provider_id AS TEXT) = CAST(tf.provider_id AS TEXT)
         AND pi.entity_type IN ('track', 'video')
         AND (tf.provider IS NULL OR pi.provider = tf.provider)
        WHERE tf.artist_id = ?
          AND tf.provider_id IS NOT NULL
          AND tf.file_path LIKE ? || '/%'
          AND pi.provider_album_id IS NOT NULL
    `).all(artistId, folder.replace(/\\/g, "/")) as Array<{ album_id: string }>;

    // Also accept Windows-style separators stored in older rows.
    const windowsRows = db.prepare(`
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
    `).all(artistId, folder.replace(/\\/g, "/")) as Array<{ album_id: string }>;

    return new Set([...rows, ...windowsRows].map((row) => String(row.album_id)).filter(Boolean));
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
    const preferredAlbumIds = folderAlbumIds(filePath, artistId);
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
