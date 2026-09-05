import { db } from "../../database.js";

export type CanonicalAlbumMetadata = {
  /** MusicBrainz release-group (album) title. */
  title: string;
  /**
   * MusicBrainz release (edition) title when a release MBID was resolved;
   * falls back to the release-group title.
   */
  editionTitle: string;
  releaseDate: string | null;
  albumReleaseDate: string | null;
  editionReleaseDate: string | null;
  albumType: string | null;
  albumMbid: string | null;
  volumeCount: number | null;
  coverImageId: string | null;
  vibrantColor: string | null;
  videoCover: string | null;
  popularity: number | null;
  reviewText: string | null;
  copyright: string | null;
  /** Release-group disambiguation. */
  disambiguation: string | null;
  /** Release (edition) disambiguation when known. */
  editionDisambiguation: string | null;
  genres: string | null;
};

export function getCanonicalAlbumMetadata(input: {
  canonicalReleaseMbid?: string | null;
  canonicalReleaseGroupMbid?: string | null;
}): CanonicalAlbumMetadata | null {
  const releaseMbid = String(input.canonicalReleaseMbid || "").trim();
  let releaseGroupMbid = String(input.canonicalReleaseGroupMbid || "").trim();
  if (!releaseMbid && !releaseGroupMbid) {
    return null;
  }

  if (!releaseGroupMbid && releaseMbid) {
    const edition = db.prepare(`SELECT release_group_mbid FROM AlbumEditions WHERE mbid = ? LIMIT 1`).get(releaseMbid) as { release_group_mbid?: string } | undefined;
    releaseGroupMbid = edition?.release_group_mbid || "";
  }

  const row = db.prepare(`
    SELECT
      release_group.title AS title,
      COALESCE(NULLIF(TRIM(release.title), ''), release_group.title) AS edition_title,
      COALESCE(NULLIF(TRIM(release.date), ''), release_group.first_release_date) AS release_date,
      release_group.first_release_date AS album_release_date,
      release.date AS edition_release_date,
      release_group.primary_type AS album_type,
      COALESCE(release.mbid, release_group.mbid) AS album_mbid,
      release.media_count AS volume_count,
      release_group.cover_image_id AS cover_image_id,
      release_group.vibrant_color AS vibrant_color,
      release_group.video_cover AS video_cover,
      release_group.popularity AS popularity,
      release_group.review_text AS review_text,
      release.copyright AS copyright,
      release_group.disambiguation AS disambiguation,
      release.disambiguation AS edition_disambiguation,
      release_group.genres AS genres
    FROM Albums release_group
    LEFT JOIN AlbumEditions release
      ON release.release_group_mbid = release_group.mbid
     AND release.mbid = ?
    WHERE release_group.mbid = ?
    LIMIT 1
  `).get(releaseMbid, releaseGroupMbid) as {
    title: string | null;
    edition_title: string | null;
    release_date: string | null;
    album_release_date: string | null;
    edition_release_date: string | null;
    album_type: string | null;
    album_mbid: string | null;
    volume_count: number | null;
    cover_image_id: string | null;
    vibrant_color: string | null;
    video_cover: string | null;
    popularity: number | null;
    review_text: string | null;
    copyright: string | null;
    disambiguation: string | null;
    edition_disambiguation: string | null;
    genres: string | null;
  } | undefined;

  if (!row?.title) {
    return null;
  }

  return {
    title: row.title,
    editionTitle: row.edition_title || row.title,
    releaseDate: row.release_date || null,
    albumReleaseDate: row.album_release_date || null,
    editionReleaseDate: row.edition_release_date || null,
    albumType: row.album_type || null,
    albumMbid: row.album_mbid || null,
    volumeCount: row.volume_count || null,
    coverImageId: row.cover_image_id || null,
    vibrantColor: row.vibrant_color || null,
    videoCover: row.video_cover || null,
    popularity: row.popularity || null,
    reviewText: row.review_text || null,
    copyright: row.copyright || null,
    disambiguation: row.disambiguation || null,
    editionDisambiguation: row.edition_disambiguation || null,
    genres: row.genres || null,
  };
}
