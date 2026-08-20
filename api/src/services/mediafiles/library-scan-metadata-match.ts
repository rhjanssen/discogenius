import path from "path";
import { db } from "../../database.js";
import {
    normalizeComparableText,
    sameRecordingTitle,
} from "./import-matching-utils.js";
import {
    PROVIDER_RESOLVED_ALBUM_ID_SQL,
    LEGACY_FOLDER_SCAN_MEMBER_ARTIST_SCOPE_SQL,
} from "../providers/provider-item-artist-scope.js";
import { comparablePathColumnSql } from "./path-utils.js";
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
    /**
     * Canonical catalog identity resolved directly from embedded MusicBrainz IDs.
     * Populated when the file carries release-track / recording / release MBIDs so
     * the TrackFile links to the catalog (and counts as downloaded) even when the
     * provider offer's own MBIDs are missing — or no provider offer exists at all.
     */
    canonicalTrackMbid?: string | null;
    canonicalRecordingMbid?: string | null;
    canonicalReleaseMbid?: string | null;
    canonicalReleaseGroupMbid?: string | null;
};

export type CatalogTrackLink = {
    /** Tracks.mbid — the release-track MBID (= canonical_track_mbid). */
    trackMbid: string;
    /** Tracks.recording_mbid (= canonical_recording_mbid). */
    recordingMbid: string;
    /** The release the resolved track belongs to (= canonical_release_mbid). */
    releaseMbid: string;
    /** Owning release group (= canonical_release_group_mbid), when known. */
    releaseGroupMbid: string | null;
};

function releaseGroupForRelease(releaseMbid: string): string | null {
    const row = db.prepare(
        "SELECT release_group_mbid FROM AlbumEditions WHERE mbid = ? LIMIT 1",
    ).get(releaseMbid) as { release_group_mbid: string | null } | undefined;
    return row?.release_group_mbid ? String(row.release_group_mbid) : null;
}

/**
 * Every release of this group that is selected into a library matching the
 * scanned root's class. A library may legitimately select SEVERAL releases of
 * one group, so this returns a set — never one winner.
 */
function selectedReleasesForGroup(releaseGroupMbid: string, preferredSlot: string): Set<string> {
    const preferredClass = preferredSlot === "spatial" ? "spatial" : "stereo";
    const rows = db.prepare(`
        SELECT DISTINCT release.mbid AS selected_release_mbid
        FROM Albums release_group
        JOIN AlbumEditions release
          ON release.release_group_id = release_group.id
        JOIN LibraryEditions library_release
          ON library_release.edition_id = release.id
        JOIN Libraries library
          ON library.id = library_release.library_id
         AND library.enabled = 1
        JOIN quality_profiles quality_profile
          ON quality_profile.id = library.quality_profile_id
        WHERE release_group.mbid = ?
          AND (
            CASE WHEN EXISTS (
              SELECT 1
              FROM json_each(COALESCE(quality_profile.allowed_source_formats, '[]')) allowed
              WHERE allowed.value = 'spatial'
            ) THEN 'spatial' ELSE 'stereo' END
          ) = ?
    `).all(releaseGroupMbid, preferredClass) as Array<{ selected_release_mbid: string | null }>;
    return new Set(
        rows.map((row) => String(row.selected_release_mbid || "")).filter(Boolean),
    );
}

/**
 * Resolve a file's catalog track purely from its embedded MusicBrainz IDs — the
 * Lidarr-style path. The release-track MBID (Tracks.mbid) is globally unique and
 * needs no provider offer; the recording MBID + release MBID pair is the
 * fallback.
 *
 * Re-anchoring is deliberately conservative: the embedded release is preserved
 * whenever it is itself selected in a library of this class (a library may
 * select several releases of one group), and a move only happens when exactly
 * one other release is selected AND it carries exactly one track for the
 * recording. Anything else keeps the file's own embedded identity rather than
 * silently relocating it onto an assumed single release.
 */
export function resolveCatalogTrackFromEmbeddedMbids(
    tags: ParsedAudioTags,
    preferredSlot: string,
): CatalogTrackLink | null {
    const releaseTrackMbid = tags.musicbrainzTrackId?.trim() || null;
    const recordingMbid = tags.musicbrainzRecordingId?.trim() || null;
    const embeddedReleaseMbid = tags.musicbrainzAlbumId?.trim() || null;

    type AnchorRow = { mbid: string; recording_mbid: string; release_mbid: string };
    let anchor: AnchorRow | undefined;

    if (releaseTrackMbid) {
        anchor = db.prepare(
            "SELECT mbid, recording_mbid, release_mbid FROM Tracks WHERE mbid = ? LIMIT 1",
        ).get(releaseTrackMbid) as AnchorRow | undefined;
    }
    if (!anchor && recordingMbid && embeddedReleaseMbid) {
        anchor = db.prepare(`
            SELECT mbid, recording_mbid, release_mbid
            FROM Tracks
            WHERE release_mbid = ? AND recording_mbid = ?
            ORDER BY medium_position, position
            LIMIT 1
        `).get(embeddedReleaseMbid, recordingMbid) as AnchorRow | undefined;
    }
    if (!anchor) return null;

    const releaseGroupMbid = releaseGroupForRelease(anchor.release_mbid);

    // The file's own embedded release wins whenever that release is itself
    // selected in a library of this class — a library may select several
    // releases of a group, so "not the one I picked" is not a reason to move.
    // Only when the embedded release is NOT selected do we re-anchor, and then
    // only onto a single selected release carrying exactly one track for this
    // recording. Anything ambiguous keeps the embedded anchor untouched.
    if (releaseGroupMbid && anchor.recording_mbid) {
        const selectedReleases = selectedReleasesForGroup(releaseGroupMbid, preferredSlot);
        const embeddedIsSelected = selectedReleases.has(anchor.release_mbid);
        if (!embeddedIsSelected && selectedReleases.size === 1) {
            const [selectedRelease] = [...selectedReleases];
            const onSelected = db.prepare(`
                SELECT mbid, recording_mbid, release_mbid
                FROM Tracks
                WHERE release_mbid = ? AND recording_mbid = ?
                ORDER BY medium_position, position
            `).all(selectedRelease, anchor.recording_mbid) as AnchorRow[];
            // A recording appearing twice on the target release (e.g. a reprise)
            // gives no unambiguous mapping — keep the embedded identity.
            if (onSelected.length === 1) {
                return {
                    trackMbid: onSelected[0].mbid,
                    recordingMbid: onSelected[0].recording_mbid,
                    releaseMbid: onSelected[0].release_mbid,
                    releaseGroupMbid,
                };
            }
        }
    }

    return {
        trackMbid: anchor.mbid,
        recordingMbid: anchor.recording_mbid,
        releaseMbid: anchor.release_mbid,
        releaseGroupMbid,
    };
}

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
    /** Internal provider identity; provider_id alone is not unique. */
    provider_item_id: number;
    provider: string;
    entity_type: string;
    provider_id: string;
    title: string;
    provider_album_id: string | null;
    recording_mbid: string | null;
    isrc: string | null;
    /** Seconds (ProviderItems stores duration_ms). */
    duration: number | null;
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

/**
 * Shared SELECT list for provider track offers, resolved entirely through the
 * typed authority: the release context comes from the selected acquisition
 * source (or a single unambiguous membership), and the canonical recording from
 * an accepted ProviderTrackMatches edge.
 *
 * There is deliberately NO quality column here. An offer's audio variants state
 * what the source *could* deliver; they say nothing about the file already on
 * disk, which may be the stereo rendition of an Atmos-capable offer. Imported
 * quality is read from the matched file's own technical facts by the caller.
 */
const OFFER_SELECT = `
    SELECT
      pi.id AS provider_item_id,
      pi.provider,
      pi.entity_type,
      CAST(pi.provider_id AS TEXT) AS provider_id,
      pi.title,
      ${PROVIDER_RESOLVED_ALBUM_ID_SQL} AS provider_album_id,
      (
        SELECT CASE
          WHEN COUNT(DISTINCT track_match.recording_id) = 1
          THEN MAX(recording.mbid)
        END
        FROM ProviderTrackMatches track_match
        JOIN Recordings recording ON recording.id = track_match.recording_id
        WHERE track_match.provider_track_item_id = pi.id
          AND track_match.match_state = 'accepted'
      ) AS recording_mbid,
      pi.isrc,
      pi.duration_ms / 1000.0 AS duration
    FROM ProviderItems pi
`;

const OFFER_ARTIST_SCOPE = LEGACY_FOLDER_SCAN_MEMBER_ARTIST_SCOPE_SQL;

function scoreOffer(
    offer: ProviderOfferRow,
    tags: ParsedAudioTags,
    preferredAlbumIds: Set<string>,
): number {
    let score = 0;
    if (preferredAlbumIds.has(String(offer.provider_album_id || ""))) score += 40;
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
): ProviderOfferRow | null {
    if (offers.length === 0) return null;
    if (offers.length === 1) return offers[0];

    const ranked = offers
        .map((offer) => ({ offer, score: scoreOffer(offer, tags, preferredAlbumIds) }))
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

    // Sibling TrackFiles in the same folder → their offers' parent provider releases.
    const rows = db.prepare(`
        SELECT DISTINCT CAST(release_item.provider_id AS TEXT) AS album_id
        FROM TrackFiles tf
        JOIN ProviderItems pi
          ON CAST(pi.provider_id AS TEXT) = CAST(tf.provider_id AS TEXT)
         AND pi.entity_type IN ('track', 'video')
         AND tf.provider IS NOT NULL
         AND pi.provider = tf.provider
        JOIN ProviderEditionMembers member ON member.member_item_id = pi.id
        JOIN ProviderItems release_item ON release_item.id = member.provider_edition_item_id
        WHERE tf.artist_id = ?
          AND tf.provider_id IS NOT NULL
          AND ${comparablePathColumnSql("tf.file_path")} LIKE ? || '/%'
    `).all(artistId, normalizedFolder) as Array<{ album_id: string }>;

    for (const row of rows) {
        if (row.album_id) albumIds.add(String(row.album_id));
    }

    // Check tags.musicbrainzAlbumId if present — provider releases accepted-matched
    // to that canonical release (or its release group).
    const mbid = tags?.musicbrainzAlbumId?.trim() || null;
    if (mbid) {
        const mbidOffers = db.prepare(`
            SELECT DISTINCT CAST(release_item.provider_id AS TEXT) AS provider_album_id
            FROM ProviderItems release_item
            JOIN ProviderEditionMatches release_match
              ON release_match.provider_edition_item_id = release_item.id
             AND release_match.match_state = 'accepted'
            JOIN AlbumEditions canonical_release ON canonical_release.id = release_match.edition_id
            WHERE release_item.entity_type = 'release'
              AND (canonical_release.mbid = ? OR canonical_release.release_group_mbid = ?)
        `).all(mbid, mbid) as Array<{ provider_album_id: string }>;
        for (const row of mbidOffers) {
            if (row.provider_album_id) albumIds.add(String(row.provider_album_id));
        }
    }

    // Match album title from tags or folder name against the artist's provider
    // releases (canonical release-group title preferred over the provider title).
    const albumTitleCandidate = tags?.album?.trim() || folderName;
    if (albumTitleCandidate) {
        const albumRows = db.prepare(`
            SELECT
              CAST(release_item.provider_id AS TEXT) AS provider_album_id,
              COALESCE(release_group.title, release_item.title) AS title
            FROM ProviderItems release_item
            LEFT JOIN ProviderEditionMatches release_match
              ON release_match.provider_edition_item_id = release_item.id
             AND release_match.match_state = 'accepted'
            LEFT JOIN AlbumEditions canonical_release ON canonical_release.id = release_match.edition_id
            LEFT JOIN Albums release_group ON release_group.id = canonical_release.release_group_id
            WHERE release_item.entity_type = 'release'
              AND (
                release_item.id IN (
                  SELECT credit.item_id
                  FROM ProviderItemCredits credit
                  JOIN ProviderArtistMatches artist_match
                    ON artist_match.provider_artist_item_id = credit.artist_item_id
                   AND artist_match.match_state = 'accepted'
                  JOIN ArtistMetadata artist_meta ON artist_meta.id = artist_match.artist_id
                  JOIN Artists managed_artist ON managed_artist.mbid = artist_meta.mbid
                  WHERE managed_artist.id = @artistId
                )
                OR canonical_release.artist_mbid IN (
                  SELECT managed_artist.mbid
                  FROM Artists managed_artist
                  WHERE managed_artist.id = @artistId
                )
              )
        `).all({ artistId }) as Array<{ provider_album_id: string; title: string }>;

        for (const row of albumRows) {
            if (row.provider_album_id && row.title && sameRecordingTitle(albumTitleCandidate, row.title)) {
                albumIds.add(String(row.provider_album_id));
            }
        }
    }

    return albumIds;
}

/**
 * The imported quality already recorded for this exact path, or null. Provider
 * audio variants are source capabilities and must never stand in for it.
 */
function importedQualityForTrackedFile(filePath: string): string | null {
    const row = db.prepare(`
        SELECT COALESCE(NULLIF(TRIM(imported_quality), ''), NULLIF(TRIM(quality), '')) AS quality
        FROM TrackFiles
        WHERE file_path = ?
        LIMIT 1
    `).get(path.resolve(filePath)) as { quality?: string | null } | undefined;
    return row?.quality ? String(row.quality) : null;
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
        ${OFFER_SELECT}
        WHERE pi.entity_type = 'track'
          AND ${OFFER_ARTIST_SCOPE}
          AND EXISTS (
            SELECT 1
            FROM ProviderEditionMembers member
            JOIN ProviderTrackMatches track_match
              ON track_match.provider_edition_member_id = member.id
             AND track_match.match_state = 'accepted'
            JOIN Recordings recording ON recording.id = track_match.recording_id
            WHERE member.member_item_id = pi.id
              AND recording.mbid = @recordingMbid
          )
    `).all({ artistId, recordingMbid, preferredSlot }) as ProviderOfferRow[];
}

function offersByIsrc(artistId: string, isrc: string, preferredSlot: string): ProviderOfferRow[] {
    return db.prepare(`
        ${OFFER_SELECT}
        WHERE pi.entity_type = 'track'
          AND ${OFFER_ARTIST_SCOPE}
          AND upper(pi.isrc) = @isrc
    `).all({ artistId, isrc, preferredSlot }) as ProviderOfferRow[];
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
    const placeholders = albumList.map((_, index) => `@album${index}`).join(", ");
    const params: Record<string, string> = { artistId, preferredSlot };
    albumList.forEach((albumId, index) => { params[`album${index}`] = albumId; });
    const rows = db.prepare(`
        ${OFFER_SELECT}
        WHERE pi.entity_type = 'track'
          AND ${OFFER_ARTIST_SCOPE}
          AND EXISTS (
            SELECT 1
            FROM ProviderEditionMembers member
            JOIN ProviderItems release_item ON release_item.id = member.provider_edition_item_id
            WHERE member.member_item_id = pi.id
              AND CAST(release_item.provider_id AS TEXT) IN (${placeholders})
          )
    `).all(params) as ProviderOfferRow[];

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
        ${OFFER_SELECT}
        WHERE pi.entity_type = 'track'
          AND ${OFFER_ARTIST_SCOPE}
    `).all({ artistId, preferredSlot }) as ProviderOfferRow[];

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
               pi.title,
               ${PROVIDER_RESOLVED_ALBUM_ID_SQL} AS provider_album_id,
               pi.duration_ms / 1000.0 AS offer_duration
        FROM TrackFiles tf
        LEFT JOIN ProviderItems pi
          ON CAST(pi.provider_id AS TEXT) = CAST(tf.provider_id AS TEXT)
         AND pi.entity_type IN ('track', 'video')
         AND tf.provider IS NOT NULL
         AND pi.provider = tf.provider
        WHERE tf.artist_id = ?
          AND tf.file_type = 'track'
          AND tf.provider_id IS NOT NULL
          AND ${comparablePathColumnSql("tf.file_path")} LIKE ? || '/%'
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
    const releaseMbid = tags.musicbrainzAlbumId?.trim() || null;

    // Authoritative catalog identity from the file's own embedded MB IDs. This is
    // independent of whether a provider offer still exists, so it both fills the
    // canonical linkage on any offer match below and enables a provider-free
    // (Lidarr-style) match when no offer is found.
    const catalogLink = resolveCatalogTrackFromEmbeddedMbids(tags, preferredSlot);
    const canonical = catalogLink
        ? {
            canonicalTrackMbid: catalogLink.trackMbid,
            canonicalRecordingMbid: catalogLink.recordingMbid,
            canonicalReleaseMbid: catalogLink.releaseMbid,
            canonicalReleaseGroupMbid: catalogLink.releaseGroupMbid,
        }
        : {};

    // Fast-path: when both release MBID and recording MBID are embedded (i.e.
    // Discogenius-tagged files), resolve directly against the catalog via
    // TrackFiles rather than walking ProviderItems. This makes rescans O(1) for
    // already-tagged content.
    if (recordingMbid && releaseMbid) {
        // TrackFiles has no album_id column (dropped in the schema-split
        // migration) — the release-group MBID is the album key here.
        const directHit = db.prepare(`
            SELECT tf.provider, CAST(tf.provider_id AS TEXT) AS provider_id,
                   tf.canonical_release_group_mbid AS album_id,
                   tf.quality, tf.library_slot, tf.file_path
            FROM TrackFiles tf
            WHERE tf.artist_id = ?
              AND tf.file_type = 'track'
              AND tf.canonical_recording_mbid = ?
              AND tf.canonical_release_mbid = ?
              AND (tf.library_slot IS NULL OR tf.library_slot = ?)
            ORDER BY tf.verified_at DESC, tf.id DESC
            LIMIT 1
        `).get(artistId, recordingMbid, releaseMbid, preferredSlot) as {
            provider: string; provider_id: string; album_id: string | null;
            quality: string | null; library_slot: string | null; file_path: string;
        } | undefined;

        if (directHit) {
            const isDuplicate = Boolean(
                directHit.file_path
                && path.resolve(directHit.file_path) !== path.resolve(filePath),
            );
            return {
                albumId: directHit.album_id,
                mediaId: directHit.provider_id,
                provider: directHit.provider,
                fileType: "track",
                quality: directHit.quality,
                librarySlot: directHit.library_slot || preferredSlot,
                duplicateOfExisting: isDuplicate,
                existingFilePath: isDuplicate ? directHit.file_path : null,
                ...canonical,
            };
        }
    }

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

    const best = pickBestOffer(offers, tags, preferredAlbumIds);
    if (!best) {
        // No provider offer, but the embedded MB IDs resolve to a catalog track:
        // link the file directly (Lidarr-style). The TrackFile carries no
        // provider identity, only canonical MBIDs, which is enough to count as
        // downloaded and to render on the album page.
        if (catalogLink) {
            return {
                albumId: catalogLink.releaseGroupMbid,
                mediaId: "",
                provider: "",
                fileType: "track",
                quality: null,
                librarySlot: preferredSlot,
                duplicateOfExisting: false,
                existingFilePath: null,
                ...canonical,
            };
        }
        return null;
    }

    // Provider items are slot-agnostic in schema 41 (renditions live on
    // ProviderItemAudioVariants), so the scanned root decides the slot.
    const librarySlot = preferredSlot;
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
        // Imported quality belongs to the file, not the offer. If this exact
        // path is already tracked, reuse its recorded quality; otherwise leave
        // it null so the import/probe path establishes it from the file itself.
        quality: importedQualityForTrackedFile(filePath),
        librarySlot,
        duplicateOfExisting,
        existingFilePath: duplicateOfExisting ? resolvedExisting : null,
        ...canonical,
    };
}
