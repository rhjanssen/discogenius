import { db } from "../../database.js";
import { buildArtistCompletionPredicate } from "../music/managed-artists.js";
import { forwardCacheInvalidate } from "../commands/worker/command-worker-protocol.js";
import { getEnabledDownloadLibrarySlots } from "./download-library-slots.js";
import { buildTrackFileCompletionExistsPredicate } from "./track-file-completion.js";

export type DownloadableFileType = "track" | "video";

export interface AlbumDownloadStats {
  albumId: string;
  totalTracks: number;
  downloadedTracks: number;
  downloadedPercent: number;
  isDownloaded: boolean;
}

export interface ArtistDownloadStats {
  artistId: string;
  totalItems: number;
  downloadedItems: number;
  downloadedPercent: number;
  isDownloaded: boolean;
}

function uniqueIds(ids: Array<string | number>) {
  return Array.from(new Set(ids.map((id) => String(id)).filter(Boolean)));
}

function getAudioLibraryClassFlags(
  slot?: "stereo" | "spatial" | null,
): { includeStereo: number; includeSpatial: number } {
  if (slot === "stereo") return { includeStereo: 1, includeSpatial: 0 };
  if (slot === "spatial") return { includeStereo: 0, includeSpatial: 1 };
  const enabled = getEnabledDownloadLibrarySlots();
  return {
    includeStereo: 1,
    includeSpatial: enabled.audio.includes("spatial") ? 1 : 0,
  };
}

function audioLibraryClassPredicate(
  libraryAlias: string,
  qualityProfileAlias: string,
): string {
  return `(
    (? = 1 AND EXISTS (
      SELECT 1
      FROM json_each(COALESCE(${qualityProfileAlias}.allowed_source_formats, '[]')) allowed
      WHERE allowed.value <> 'spatial'
    ))
    OR
    (? = 1 AND EXISTS (
      SELECT 1
      FROM json_each(COALESCE(${qualityProfileAlias}.allowed_source_formats, '[]')) allowed
      WHERE allowed.value = 'spatial'
    ))
  )
  AND ${libraryAlias}.enabled = 1`;
}

function toAlbumStats(albumId: string, totalTracks: number, downloadedTracks: number): AlbumDownloadStats {
  const normalizedTotalTracks = Math.max(0, totalTracks);
  const normalizedDownloadedTracks = Math.max(0, downloadedTracks);
  const downloadedPercent = normalizedTotalTracks > 0
    ? Math.min(100, Math.round((normalizedDownloadedTracks / normalizedTotalTracks) * 100))
    : 0;

  return {
    albumId,
    totalTracks: normalizedTotalTracks,
    downloadedTracks: normalizedDownloadedTracks,
    downloadedPercent,
    isDownloaded: normalizedTotalTracks > 0 && normalizedDownloadedTracks >= normalizedTotalTracks,
  };
}

function toArtistStats(artistId: string, totalItems: number, downloadedItems: number): ArtistDownloadStats {
  const normalizedTotalItems = Math.max(0, totalItems);
  const normalizedDownloadedItems = Math.max(0, downloadedItems);
  const downloadedPercent = normalizedTotalItems > 0
    ? Math.min(100, Math.round((normalizedDownloadedItems / normalizedTotalItems) * 100))
    : 0;

  return {
    artistId,
    totalItems: normalizedTotalItems,
    downloadedItems: normalizedDownloadedItems,
    downloadedPercent,
    isDownloaded: normalizedTotalItems > 0 && normalizedDownloadedItems >= normalizedTotalItems,
  };
}

export function invalidateAlbumDownloadStatus(albumId: string): void {
  if (!albumId) return;
  forwardCacheInvalidate("album", String(albumId));
}

export function invalidateReleaseGroupDownloadStatus(releaseGroupMbid: string): void {
  if (!releaseGroupMbid) return;
  forwardCacheInvalidate("releaseGroup", String(releaseGroupMbid));
}

export function invalidateArtistDownloadStatus(artistId: string): void {
  if (!artistId) return;
  forwardCacheInvalidate("artist", String(artistId));
}

export function invalidateMediaDownloadState(mediaId: string): void {
  if (!mediaId) return;
  forwardCacheInvalidate("media", String(mediaId));
}

export function invalidateAllDownloadState(): void {
  forwardCacheInvalidate("all");
}

export function getMediaDownloadStateMap(
  mediaIds: Array<string | number>,
  fileType: DownloadableFileType,
): Map<string, boolean> {
  const ids = uniqueIds(mediaIds);
  const result = new Map<string, boolean>();
  if (ids.length === 0) return result;

  const values = ids.map(() => "(?)").join(", ");
  const rows = db.prepare(`
    WITH target_ids(id) AS (
      VALUES ${values}
    )
    SELECT
      CAST(target_ids.id AS TEXT) AS id,
      CASE WHEN EXISTS (
        SELECT 1
        FROM TrackFiles lf
        WHERE lf.file_type = ?
          AND (
            CAST(lf.provider_id AS TEXT) = CAST(target_ids.id AS TEXT)
            OR (? = 'track' AND (lf.track_id = CAST(target_ids.id AS INTEGER) OR lf.canonical_track_mbid = CAST(target_ids.id AS TEXT)))
            OR (lf.recording_id = CAST(target_ids.id AS INTEGER) OR lf.canonical_recording_mbid = CAST(target_ids.id AS TEXT))
            OR CAST(lf.canonical_recording_mbid AS TEXT) = (
              SELECT r.mbid
              FROM Recordings r
              WHERE CAST(r.id AS TEXT) = CAST(target_ids.id AS TEXT)
              LIMIT 1
            )
          )
      ) THEN 1 ELSE 0 END AS downloaded
    FROM target_ids
  `).all(...ids, fileType, fileType) as Array<{ id: string; downloaded: number }>;

  const downloadedById = new Map(rows.map((row) => [String(row.id), Boolean(row.downloaded)]));
  for (const id of ids) {
    result.set(id, downloadedById.get(id) ?? false);
  }

  return result;
}

export function isMediaDownloaded(mediaId: string | number, fileType: DownloadableFileType): boolean {
  return getMediaDownloadStateMap([mediaId], fileType).get(String(mediaId)) ?? false;
}

export function getAlbumDownloadStatsMap(albumIds: Array<string | number>): Map<string, AlbumDownloadStats> {
  return getReleaseGroupDownloadStatsMap(albumIds);
}

export function getAlbumDownloadStats(albumId: string | number): AlbumDownloadStats {
  return getAlbumDownloadStatsMap([albumId]).get(String(albumId)) ?? toAlbumStats(String(albumId), 0, 0);
}

export function getReleaseGroupDownloadStatsMap(
  releaseGroupMbids: Array<string | number>,
  slot?: "stereo" | "spatial" | null,
): Map<string, AlbumDownloadStats> {
  const ids = uniqueIds(releaseGroupMbids);
  const result = new Map<string, AlbumDownloadStats>();
  if (ids.length === 0) return result;

  const values = ids.map(() => "(?)").join(", ");
  const libraryClasses = getAudioLibraryClassFlags(slot);
  // The same canonical track selected into two libraries is two independent
  // completion requirements.
  const trackDiscriminator = "CAST(sr.library_id AS TEXT) || ':' || CAST(t.id AS TEXT)";
  const rows = db.prepare(`
    WITH target_release_groups(release_group_mbid) AS (
      VALUES ${values}
    ),
    selected_releases AS (
      SELECT
        release_group.mbid AS release_group_mbid,
        library_group.library_id,
        library_release.edition_id
      FROM target_release_groups trg
      JOIN Albums release_group
        ON release_group.mbid = trg.release_group_mbid
      JOIN LibraryAlbums library_group
        ON library_group.release_group_id = release_group.id
      JOIN Libraries library
        ON library.id = library_group.library_id
      JOIN quality_profiles quality_profile
        ON quality_profile.id = library.quality_profile_id
      JOIN LibraryEditions library_release
        ON library_release.library_id = library_group.library_id
      JOIN AlbumEditions release
        ON release.id = library_release.edition_id
       AND release.release_group_id = release_group.id
      WHERE ${audioLibraryClassPredicate("library", "quality_profile")}
    )
    SELECT
      sr.release_group_mbid,
      COUNT(DISTINCT ${trackDiscriminator}) AS total_tracks,
      COUNT(DISTINCT CASE
        WHEN ${buildTrackFileCompletionExistsPredicate("t", "sr.library_id", "release_group_file")}
        THEN ${trackDiscriminator}
      END) AS downloaded_tracks
    FROM selected_releases sr
    LEFT JOIN Tracks t
      ON t.album_edition_id = sr.edition_id
    LEFT JOIN Recordings recording
      ON recording.id = t.recording_id
    WHERE recording.is_video = 0
    GROUP BY sr.release_group_mbid
  `).all(
    ...ids,
    libraryClasses.includeStereo,
    libraryClasses.includeSpatial,
  ) as Array<{
    release_group_mbid: string;
    total_tracks: number;
    downloaded_tracks: number;
  }>;

  const statsByReleaseGroup = new Map(rows.map((row) => [String(row.release_group_mbid), row]));
  for (const releaseGroupMbid of ids) {
    const row = statsByReleaseGroup.get(releaseGroupMbid);
    result.set(
      releaseGroupMbid,
      toAlbumStats(
        releaseGroupMbid,
        Number(row?.total_tracks || 0),
        Number(row?.downloaded_tracks || 0),
      ),
    );
  }

  return result;
}

export function getArtistDownloadStatsMap(artistIds: Array<string | number>): Map<string, ArtistDownloadStats> {
  const ids = uniqueIds(artistIds);
  const result = new Map<string, ArtistDownloadStats>();
  if (ids.length === 0) return result;

  const resolveArtistRow = db.prepare(
    "SELECT mbid FROM Artists WHERE CAST(id AS TEXT) = ? OR mbid = ? LIMIT 1",
  );
  const resolveMetadataByMbid = db.prepare("SELECT id, mbid FROM ArtistMetadata WHERE mbid = ? LIMIT 1");
  const resolveMetadataById = db.prepare("SELECT id, mbid FROM ArtistMetadata WHERE CAST(id AS TEXT) = ? LIMIT 1");
  const targets = ids.map((inputId) => {
    const artistRow = resolveArtistRow.get(inputId, inputId) as { mbid?: string | null } | undefined;
    let artistMbid = String(artistRow?.mbid || inputId);
    let metadata = resolveMetadataByMbid.get(artistMbid) as { id?: number; mbid?: string } | undefined;
    if (!metadata) {
      metadata = resolveMetadataById.get(inputId) as { id?: number; mbid?: string } | undefined;
      if (!artistRow?.mbid && metadata?.mbid) {
        artistMbid = String(metadata.mbid);
      }
    }
    return { inputId, artistMbid, artistMetadataId: metadata?.id ?? null };
  });

  const mbids = Array.from(new Set(targets.map((target) => target.artistMbid)));
  const metadataIds = Array.from(new Set(
    targets.map((target) => target.artistMetadataId).filter((id): id is number => id != null),
  ));
  const mbidMarks = mbids.map(() => "?").join(", ");
  const enabledLibrarySlots = getEnabledDownloadLibrarySlots();
  const libraryClasses = getAudioLibraryClassFlags();

  // 1. Monitored release-group completeness, once per selected library.
  const libraryRows = mbids.length === 0 ? [] : db.prepare(`
    SELECT
      release_group.artist_mbid,
      COUNT(DISTINCT track.id) AS total_tracks,
      COUNT(DISTINCT CASE
        WHEN ${buildTrackFileCompletionExistsPredicate("track", "library_group.library_id", "artist_file")}
        THEN track.id
      END) AS downloaded_tracks
    FROM Albums release_group
    JOIN LibraryAlbums library_group
      ON library_group.release_group_id = release_group.id
     AND library_group.monitored = 1
    JOIN Libraries library
      ON library.id = library_group.library_id
    JOIN quality_profiles quality_profile
      ON quality_profile.id = library.quality_profile_id
    JOIN LibraryEditions library_release
      ON library_release.library_id = library_group.library_id
    JOIN AlbumEditions release
      ON release.id = library_release.edition_id
     AND release.release_group_id = release_group.id
    LEFT JOIN Tracks track
      ON track.album_edition_id = release.id
    LEFT JOIN Recordings recording
      ON recording.id = track.recording_id
    WHERE release_group.artist_mbid IN (${mbidMarks})
      AND ${audioLibraryClassPredicate("library", "quality_profile")}
      AND recording.is_video = 0
    GROUP BY release_group.artist_mbid, release_group.id, library_group.library_id
  `).all(
    ...mbids,
    libraryClasses.includeStereo,
    libraryClasses.includeSpatial,
  ) as Array<{ artist_mbid: string; total_tracks: number; downloaded_tracks: number }>;

  // 2. Monitored videos — one indexed query per artist-link column instead of
  //    an OR-join that defeats both indexes.
  const monitoredVideoFlag = "(recording.monitored = 1 OR recording.monitored_lock = 1)";
  const videosLinkedByMbid = !enabledLibrarySlots.video || mbids.length === 0 ? [] : db.prepare(`
    SELECT recording.artist_mbid AS link, recording.id AS recording_id
    FROM Recordings recording
    WHERE recording.is_video = 1
      AND recording.artist_mbid IN (${mbidMarks})
      AND ${monitoredVideoFlag}
  `).all(...mbids) as Array<{ link: string; recording_id: number }>;
  const videosLinkedByMetadataId = !enabledLibrarySlots.video || metadataIds.length === 0 ? [] : db.prepare(`
    SELECT recording.artist_metadata_id AS link, recording.id AS recording_id
    FROM Recordings recording
    WHERE recording.is_video = 1
      AND recording.artist_metadata_id IN (${metadataIds.map(() => "?").join(", ")})
      AND ${monitoredVideoFlag}
  `).all(...metadataIds) as Array<{ link: number; recording_id: number }>;

  // 3. Downloaded video recordings, derived once from the (small) set of
  //    downloaded video files; no video files ⇒ nothing is downloaded.
  const downloadedVideoIds = new Set<number>();
  if (enabledLibrarySlots.video && db.prepare("SELECT 1 FROM TrackFiles WHERE file_class = 'video' LIMIT 1").get()) {
    const downloadedRows = db.prepare(`
      SELECT DISTINCT lf.recording_id
      FROM TrackFiles lf
      WHERE lf.file_class = 'video'
        AND lf.recording_id IS NOT NULL
    `).all() as Array<{ recording_id: number }>;
    for (const row of downloadedRows) {
      downloadedVideoIds.add(Number(row.recording_id));
    }
  }

  // Combine per requested artist in JS.
  const librariesByMbid = new Map<string, Array<{ total: number; downloaded: number }>>();
  for (const row of libraryRows) {
    const list = librariesByMbid.get(row.artist_mbid) ?? [];
    list.push({ total: Number(row.total_tracks), downloaded: Number(row.downloaded_tracks) });
    librariesByMbid.set(row.artist_mbid, list);
  }
  const videosByMbid = new Map<string, Set<number>>();
  for (const row of videosLinkedByMbid) {
    const set = videosByMbid.get(String(row.link)) ?? new Set<number>();
    set.add(Number(row.recording_id));
    videosByMbid.set(String(row.link), set);
  }
  const videosByMetadataId = new Map<number, Set<number>>();
  for (const row of videosLinkedByMetadataId) {
    const set = videosByMetadataId.get(Number(row.link)) ?? new Set<number>();
    set.add(Number(row.recording_id));
    videosByMetadataId.set(Number(row.link), set);
  }

  const rows = targets.map((target) => {
    const libraries = librariesByMbid.get(target.artistMbid) ?? [];
    const videoIds = new Set<number>(videosByMbid.get(target.artistMbid) ?? []);
    if (target.artistMetadataId != null) {
      for (const id of videosByMetadataId.get(target.artistMetadataId) ?? []) {
        videoIds.add(id);
      }
    }
    let downloadedVideos = 0;
    for (const id of videoIds) {
      if (downloadedVideoIds.has(id)) downloadedVideos += 1;
    }
    return {
      artist_id: target.inputId,
      total_items: libraries.length + videoIds.size,
      downloaded_items: libraries.filter(
        (library) => library.total > 0 && library.downloaded >= library.total,
      ).length + downloadedVideos,
    };
  });

  const statsByArtistId = new Map(rows.map((row) => [String(row.artist_id), row]));
  for (const artistId of ids) {
    const row = statsByArtistId.get(artistId);
    result.set(
      artistId,
      toArtistStats(
        artistId,
        Number(row?.total_items || 0),
        Number(row?.downloaded_items || 0),
      ),
    );
  }

  return result;
}

export function getArtistDownloadStats(artistId: string | number): ArtistDownloadStats {
  return getArtistDownloadStatsMap([artistId]).get(String(artistId)) ?? toArtistStats(String(artistId), 0, 0);
}

export function countDownloadedAlbums(): number {
  const libraryClasses = getAudioLibraryClassFlags();
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM (
      SELECT
        library_group.release_group_id,
        library_group.library_id,
        COUNT(DISTINCT track.id) AS total_tracks,
        COUNT(DISTINCT CASE
          WHEN ${buildTrackFileCompletionExistsPredicate("track", "library_group.library_id", "album_count_file")}
          THEN track.id
        END) AS downloaded_tracks
      FROM LibraryAlbums library_group
      JOIN Libraries library
        ON library.id = library_group.library_id
      JOIN quality_profiles quality_profile
        ON quality_profile.id = library.quality_profile_id
      JOIN LibraryEditions library_release
        ON library_release.library_id = library_group.library_id
      JOIN AlbumEditions release
        ON release.id = library_release.edition_id
       AND release.release_group_id = library_group.release_group_id
      JOIN Tracks track
        ON track.album_edition_id = release.id
      LEFT JOIN Recordings recording
        ON recording.id = track.recording_id
      WHERE ${audioLibraryClassPredicate("library", "quality_profile")}
        AND recording.is_video = 0
      GROUP BY library_group.release_group_id, library_group.library_id
    ) library_stats
    WHERE total_tracks > 0
      AND downloaded_tracks >= total_tracks
  `).get(
    libraryClasses.includeStereo,
    libraryClasses.includeSpatial,
  ) as { count: number } | undefined;

  return Number(row?.count || 0);
}

export function countDownloadedTracks(): number {
  const libraryClasses = getAudioLibraryClassFlags();
  const row = db.prepare(`
    SELECT COUNT(DISTINCT CAST(library_group.library_id AS TEXT) || ':' || CAST(track.id AS TEXT)) AS count
    FROM LibraryAlbums library_group
    JOIN Libraries library
      ON library.id = library_group.library_id
    JOIN quality_profiles quality_profile
      ON quality_profile.id = library.quality_profile_id
    JOIN LibraryEditions library_release
      ON library_release.library_id = library_group.library_id
    JOIN AlbumEditions release
      ON release.id = library_release.edition_id
     AND release.release_group_id = library_group.release_group_id
    JOIN Tracks track
      ON track.album_edition_id = release.id
    LEFT JOIN Recordings recording
      ON recording.id = track.recording_id
    WHERE ${audioLibraryClassPredicate("library", "quality_profile")}
      AND recording.is_video = 0
      AND ${buildTrackFileCompletionExistsPredicate("track", "library_group.library_id", "track_count_file")}
  `).get(
    libraryClasses.includeStereo,
    libraryClasses.includeSpatial,
  ) as { count: number } | undefined;

  return Number(row?.count || 0);
}

export function countDownloadedVideos(): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM TrackFiles
    WHERE file_class = 'video'
  `).get() as { count: number } | undefined;

  return Number(row?.count || 0);
}

export function countDownloadedManagedArtists(): number {
  const completionPredicate = buildArtistCompletionPredicate("a");
  const rows = db.prepare(`
    SELECT CAST(a.id AS TEXT) AS artist_id
    FROM Artists a
    WHERE ${completionPredicate}
  `).all() as Array<{ artist_id: string }>;
  if (rows.length === 0) {
    return 0;
  }

  const stats = getArtistDownloadStatsMap(rows.map((row) => row.artist_id));
  let count = 0;
  for (const row of rows) {
    if (stats.get(String(row.artist_id))?.isDownloaded) {
      count++;
    }
  }

  return count;
}

export function updateAlbumDownloadStatus(albumId: string): void {
  if (!albumId) return;
  invalidateAlbumDownloadStatus(albumId);
  updateArtistDownloadStatusFromAlbum(albumId);
}

export function updateArtistDownloadStatus(artistId: string): void {
  if (!artistId) return;
  invalidateArtistDownloadStatus(artistId);
}

export function updateArtistDownloadStatusFromAlbum(albumId: string): void {
  if (!albumId) return;

  invalidateAlbumDownloadStatus(albumId);

  const canonicalArtistIds = db.prepare(`
    SELECT DISTINCT CAST(a.id AS TEXT) AS artist_id
    FROM Albums rg
    LEFT JOIN Artists a ON a.mbid = rg.artist_mbid
    WHERE rg.mbid = ?
  `).all(albumId) as Array<{ artist_id: string | null }>;

  for (const row of canonicalArtistIds) {
    if (row.artist_id) {
      invalidateArtistDownloadStatus(String(row.artist_id));
    }
  }
}

export function updateArtistDownloadStatusFromMedia(mediaId: string, provider?: string | null): void {
  if (!mediaId) return;

  invalidateMediaDownloadState(mediaId);

  const canonicalRows = db.prepare(`
    SELECT DISTINCT
      CAST(a.id AS TEXT) AS artist_id,
      rg.mbid AS release_group_mbid
    FROM ProviderItems pi
    JOIN ProviderEditionMembers member ON member.member_item_id = pi.id
    JOIN ProviderTrackMatches track_match
      ON track_match.provider_edition_member_id = member.id
     AND track_match.match_state = 'accepted'
     AND track_match.track_id IS NOT NULL
    JOIN Tracks track ON track.id = track_match.track_id
    JOIN AlbumEditions release ON release.id = track.album_edition_id
    JOIN Albums rg ON rg.id = release.release_group_id
    LEFT JOIN Artists a ON a.mbid = rg.artist_mbid
    WHERE CAST(pi.provider_id AS TEXT) = CAST(? AS TEXT)
      AND pi.entity_type = 'track'
      AND (? IS NULL OR pi.provider = ?)
    UNION
    SELECT DISTINCT
      CAST(a.id AS TEXT) AS artist_id,
      NULL AS release_group_mbid
    FROM ProviderItems pi
    JOIN ProviderVideoMatches video_match
      ON video_match.provider_video_item_id = pi.id
     AND video_match.match_state = 'accepted'
    JOIN Recordings recording ON recording.id = video_match.recording_id
    LEFT JOIN Artists a ON a.mbid = recording.artist_mbid
    WHERE CAST(pi.provider_id AS TEXT) = CAST(? AS TEXT)
      AND pi.entity_type = 'video'
      AND (? IS NULL OR pi.provider = ?)
    UNION
    SELECT DISTINCT
      CAST(a.id AS TEXT) AS artist_id,
      release_group.mbid AS release_group_mbid
    FROM Tracks track
    JOIN AlbumEditions release ON release.mbid = track.release_mbid
    JOIN Albums release_group ON release_group.mbid = release.release_group_mbid
    LEFT JOIN Artists a ON a.mbid = release_group.artist_mbid
    WHERE track.mbid = ?
       OR track.recording_mbid = ?
    UNION
    SELECT DISTINCT
      CAST(a.id AS TEXT) AS artist_id,
      NULL AS release_group_mbid
    FROM Recordings recording
    LEFT JOIN Artists a ON a.mbid = recording.artist_mbid
    WHERE recording.mbid = ?
       OR CAST(recording.id AS TEXT) = CAST(? AS TEXT)
  `).all(
    mediaId,
    provider || null,
    provider || null,
    mediaId,
    provider || null,
    provider || null,
    mediaId,
    mediaId,
    mediaId,
    mediaId,
  ) as Array<{
    artist_id?: string | null;
    release_group_mbid?: string | null;
  }>;

  for (const row of canonicalRows) {
    if (row.release_group_mbid) {
      invalidateReleaseGroupDownloadStatus(String(row.release_group_mbid));
    }
    if (row.artist_id) {
      invalidateArtistDownloadStatus(String(row.artist_id));
    }
  }
}

export function getAlbumLocalQualitiesMap(
  releaseGroupMbids: Array<string | number>,
): Map<string, { majorityQuality: string | null; localQualities: string[] }> {
  const ids = uniqueIds(releaseGroupMbids);
  const result = new Map<string, { majorityQuality: string | null; localQualities: string[] }>();
  if (ids.length === 0) return result;

  const placeholders = ids.map(() => "?").join(", ");
  const rows = db.prepare(`
    SELECT
      tf.canonical_release_group_mbid AS release_group_mbid,
      tf.quality,
      COUNT(*) AS file_count
    FROM TrackFiles tf
    WHERE tf.canonical_release_group_mbid IN (${placeholders})
      AND tf.file_type = 'track'
      AND tf.quality IS NOT NULL
      AND TRIM(tf.quality) != ''
    GROUP BY tf.canonical_release_group_mbid, tf.quality
    ORDER BY tf.canonical_release_group_mbid, file_count DESC
  `).all(...ids) as Array<{ release_group_mbid: string; quality: string; file_count: number }>;

  const grouped = new Map<string, Array<{ quality: string; count: number }>>();
  for (const row of rows) {
    const list = grouped.get(row.release_group_mbid) || [];
    list.push({ quality: row.quality, count: row.file_count });
    grouped.set(row.release_group_mbid, list);
  }

  for (const mbid of ids) {
    const items = grouped.get(mbid) || [];
    const localQualities = Array.from(new Set(items.map((i) => i.quality)));
    const majorityQuality = items.length > 0 ? items[0].quality : null;
    result.set(mbid, { majorityQuality, localQualities });
  }

  return result;
}
