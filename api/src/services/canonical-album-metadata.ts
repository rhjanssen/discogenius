import { db } from "../database.js";

export type CanonicalAlbumMetadata = {
  title: string;
  releaseDate: string | null;
  albumType: string | null;
  albumMbid: string | null;
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
      COALESCE(release.title, release_group.title) AS title,
      release.date AS release_date,
      release_group.primary_type AS album_type,
      release.mbid AS album_mbid
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
  } | undefined;

  if (!row?.title) {
    return null;
  }

  return {
    title: row.title,
    releaseDate: row.release_date || null,
    albumType: row.album_type || null,
    albumMbid: row.album_mbid || null,
  };
}
