import { db } from "../../database.js";

export type CanonicalAlbumMetadata = {
  title: string;
  releaseDate: string | null;
  albumType: string | null;
  albumMbid: string | null;
  volumeCount: number | null;
  coverImageId: string | null;
  vibrantColor: string | null;
  videoCover: string | null;
  popularity: number | null;
  reviewText: string | null;
  copyright: string | null;
};

export function getCanonicalAlbumMetadata(input: {
  canonicalReleaseMbid?: string | null;
  canonicalReleaseGroupMbid?: string | null;
}): CanonicalAlbumMetadata | null {
  const releaseMbid = String(input.canonicalReleaseMbid || "").trim();
  const releaseGroupMbid = String(input.canonicalReleaseGroupMbid || "").trim();
  if (!releaseMbid && !releaseGroupMbid) {
    return null;
  }

  const row = db.prepare(`
    SELECT
      release_group.title AS title,
      release.date AS release_date,
      release_group.primary_type AS album_type,
      release.mbid AS album_mbid,
      release.media_count AS volume_count,
      release_group.cover_image_id AS cover_image_id,
      release_group.vibrant_color AS vibrant_color,
      release_group.video_cover AS video_cover,
      release_group.popularity AS popularity,
      release_group.review_text AS review_text,
      release.copyright AS copyright
    FROM Albums release_group
    LEFT JOIN AlbumReleases release
      ON release.release_group_mbid = release_group.mbid
     AND release.mbid = ?
    WHERE release_group.mbid = ?
    LIMIT 1
  `).get(releaseMbid, releaseGroupMbid) as {
    title: string | null;
    release_date: string | null;
    album_type: string | null;
    album_mbid: string | null;
    volume_count: number | null;
    cover_image_id: string | null;
    vibrant_color: string | null;
    video_cover: string | null;
    popularity: number | null;
    review_text: string | null;
    copyright: string | null;
  } | undefined;

  if (!row?.title) {
    return null;
  }

  return {
    title: row.title,
    releaseDate: row.release_date || null,
    albumType: row.album_type || null,
    albumMbid: row.album_mbid || null,
    volumeCount: row.volume_count || null,
    coverImageId: row.cover_image_id || null,
    vibrantColor: row.vibrant_color || null,
    videoCover: row.video_cover || null,
    popularity: row.popularity || null,
    reviewText: row.review_text || null,
    copyright: row.copyright || null,
  };
}
