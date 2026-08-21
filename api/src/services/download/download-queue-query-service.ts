import { db } from "../../database.js";
import { planHeadlineQualitySql, variantDisplayQualitySql, variantTierRankSql } from "../../utils/display-quality-sql.js";
import type {
  DownloadProgressContract,
  QueueItemContract,
  QueueListResponseContract,
  QueueStatusContract,
} from "../../contracts/status.js";
import { downloadProcessor } from "./download-processor.js";
import { downloadEvents } from "./download-events.js";
import { DownloadWaitQueue } from "./download-wait-queue.js";
import {DOWNLOAD_COMMAND_NAMES, DOWNLOAD_OR_IMPORT_COMMAND_NAMES, CommandNames} from "../commands/command-names.js";
import {CommandQueueManager} from "../commands/command-queue-manager.js";
import { appEvents, AppEvent } from "../commands/app-events.js";
import {
  albumCoverLocalUrl,
  imageContainerFromImagesColumn,
  renderableProviderArtworkUrl,
  videoCoverLocalUrl,
} from "../metadata/media-cover-service.js";
import type {
  QueueHistoryMediaKindFilter,
  QueueHistoryOutcomeFilter,
} from "../../utils/queue-history-query.js";
import { resolveRequestedVideoOffer } from "../music/video-offer-resolver.js";

type QueueJobRow = {
  id: number;
  name: string;
  status: string;
  ref_id?: string | null;
  payload?: Record<string, unknown>;
  progress?: number;
  error?: string | null;
  created_at: string;
  updated_at?: string;
  started_at?: string | null;
  completed_at?: string | null;
};

type QueueDetailsFilters = {
  artistId?: string;
  albumIds?: string[];
  providerIds?: string[];
};

type NormalizedQueueDetailsFilters = {
  artistId?: string;
  albumIds: string[];
  providerIds: string[];
};

type QueueMetadata = {
  title?: string | null;
  artist?: string | null;
  cover?: string | null;
  albumId?: string | null;
  albumTitle?: string | null;
  quality?: string | null;
};

type QueueTrackProgress = NonNullable<QueueItemContract["tracks"]>[number];

/** Live Active queue: in-flight work only. Failed jobs belong in History. */
const LIVE_QUEUE_STATUSES: Array<"queued" | "started"> = ["queued", "started"];
const QUEUE_HISTORY_STATUSES: Array<"completed" | "failed" | "cancelled"> = ["completed", "failed", "cancelled"];

function placeholders(values: readonly unknown[]): string {
  return values.map(() => "?").join(",");
}

function getOptionalString(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  return null;
}

function normalizeDistinctIdentifiers(values?: readonly string[] | null): string[] {
  if (!values || values.length === 0) {
    return [];
  }

  return Array.from(
    new Set(
      values
        .map((value) => getOptionalString(value))
        .filter((value): value is string => value !== null),
    ),
  );
}

function resolveQueueItemContentType(job: QueueJobRow): QueueItemContract["type"] {
  if (job.name === CommandNames.DownloadVideo) {
    return "video";
  }

  if (job.name === CommandNames.DownloadAlbum) {
    return "album";
  }

  if (job.name === CommandNames.ImportDownload) {
    const payloadType = getOptionalString(job.payload?.type);
    if (payloadType === "video" || payloadType === "album") {
      return payloadType;
    }
  }

  return "track";
}

function getJobProviderId(job: QueueJobRow): string | null {
  return getOptionalString(job.payload?.providerId)
    ?? getOptionalString(job.ref_id);
}

function getJobProvider(job: QueueJobRow): string | null {
  return getOptionalString(job.payload?.provider);
}

function getJobAlbumId(job: QueueJobRow): string | null {
  const payloadAlbumId = getOptionalString(
    job.payload?.album_id
    ?? job.payload?.albumId
    ?? job.payload?.releaseGroupMbid
    ?? (job.payload?.resolved as Record<string, unknown> | undefined)?.albumId,
  );
  if (payloadAlbumId) {
    return payloadAlbumId;
  }

  const contentType = resolveQueueItemContentType(job);
  const providerId = getJobProviderId(job);

  if (!providerId) {
    return null;
  }

  const provider = getJobProvider(job);
  if (!provider) {
    return null;
  }

  const providerItemAlbumId = getProviderItemAlbumId(contentType, provider, providerId);
  if (providerItemAlbumId) {
    return providerItemAlbumId;
  }

  return null;
}

function getJobArtistId(job: QueueJobRow): string | null {
  const payloadArtistId = getOptionalString(
    job.payload?.artist_id
    ?? job.payload?.artistId
    ?? (job.payload?.resolved as Record<string, unknown> | undefined)?.artistId,
  );
  if (payloadArtistId) {
    return payloadArtistId;
  }

  const contentType = resolveQueueItemContentType(job);
  const providerId = getJobProviderId(job);

  if (!providerId) {
    return null;
  }

  const provider = getJobProvider(job);
  if (!provider) {
    return null;
  }

  const providerItemArtistId = getProviderItemArtistId(contentType, provider, providerId);
  if (providerItemArtistId) {
    return providerItemArtistId;
  }

  return null;
}

function getProviderItemEntityTypes(contentType: QueueItemContract["type"]): string[] {
  if (contentType === "album") return ["release"];
  if (contentType === "video") return ["video"];
  return ["track"];
}

function getProviderItemAlbumId(
  contentType: QueueItemContract["type"],
  provider: string,
  providerId: string,
): string | null {
  const rows = contentType === "album"
    ? db.prepare(`
        SELECT DISTINCT release_group.mbid AS release_group_mbid
        FROM ProviderItems provider_item
        JOIN ProviderEditionMatches release_match
          ON release_match.provider_edition_item_id = provider_item.id
         AND release_match.match_state = 'accepted'
        JOIN AlbumEditions release ON release.id = release_match.edition_id
        JOIN Albums release_group ON release_group.id = release.release_group_id
        WHERE provider_item.provider = ?
          AND provider_item.provider_id = ?
          AND provider_item.entity_type = 'release'
      `).all(provider, providerId)
    : contentType === "track"
      ? db.prepare(`
          SELECT DISTINCT release_group.mbid AS release_group_mbid
          FROM ProviderItems provider_item
          JOIN ProviderTrackMatches track_match
            ON track_match.provider_track_item_id = provider_item.id
           AND track_match.match_state = 'accepted'
          JOIN Tracks track ON track.id = track_match.track_id
          JOIN AlbumEditions release ON release.id = track.album_edition_id
          JOIN Albums release_group ON release_group.id = release.release_group_id
          WHERE provider_item.provider = ?
            AND provider_item.provider_id = ?
            AND provider_item.entity_type = 'track'
        `).all(provider, providerId)
      : db.prepare(`
          SELECT DISTINCT release_group.mbid AS release_group_mbid
          FROM ProviderItems provider_item
          JOIN ProviderVideoMatches video_match
            ON video_match.provider_video_item_id = provider_item.id
           AND video_match.match_state = 'accepted'
          JOIN RecordingRelations relation
            ON relation.source_recording_id = video_match.recording_id
           AND relation.relation_type IN ('provider_video_for', 'music_video_for')
          JOIN Tracks track ON track.recording_id = relation.target_recording_id
          JOIN AlbumEditions release ON release.id = track.album_edition_id
          JOIN Albums release_group ON release_group.id = release.release_group_id
          WHERE provider_item.provider = ?
            AND provider_item.provider_id = ?
            AND provider_item.entity_type = 'video'
        `).all(provider, providerId);
  const albumIds = new Set(
    (rows as Array<{ release_group_mbid?: string | null }>)
      .map((row) => getOptionalString(row.release_group_mbid))
      .filter((value): value is string => value !== null),
  );

  return albumIds.size === 1 ? [...albumIds][0] : null;
}

function getProviderItemArtistId(
  contentType: QueueItemContract["type"],
  provider: string,
  providerId: string,
): string | null {
  const entityType = getProviderItemEntityTypes(contentType)[0];
  const rows = db.prepare(`
    SELECT DISTINCT artist.mbid AS artist_mbid
    FROM ProviderItems provider_item
    LEFT JOIN ProviderEditionMatches release_match
      ON provider_item.entity_type = 'release'
     AND release_match.provider_edition_item_id = provider_item.id
     AND release_match.match_state = 'accepted'
    LEFT JOIN AlbumEditions direct_release ON direct_release.id = release_match.edition_id
    LEFT JOIN Albums direct_group ON direct_group.id = direct_release.release_group_id
    LEFT JOIN ProviderEditionMembers member
      ON provider_item.entity_type = 'track'
     AND member.member_item_id = provider_item.id
    LEFT JOIN ProviderTrackMatches track_match
      ON track_match.provider_edition_member_id = member.id
     AND track_match.match_state = 'accepted'
    LEFT JOIN Tracks track ON track.id = track_match.track_id
    LEFT JOIN AlbumEditions track_release ON track_release.id = track.album_edition_id
    LEFT JOIN Albums track_group ON track_group.id = track_release.release_group_id
    LEFT JOIN ProviderVideoMatches video_match
      ON provider_item.entity_type = 'video'
     AND video_match.provider_video_item_id = provider_item.id
     AND video_match.match_state = 'accepted'
    LEFT JOIN Recordings recording
      ON recording.id = COALESCE(video_match.recording_id, track_match.recording_id)
    LEFT JOIN ArtistMetadata artist
      ON artist.id = COALESCE(
        direct_group.artist_metadata_id,
        track_group.artist_metadata_id,
        recording.artist_metadata_id
      )
    WHERE provider_item.provider = ?
      AND provider_item.provider_id = ?
      AND provider_item.entity_type = ?
      AND artist.mbid IS NOT NULL
  `).all(provider, providerId, entityType) as Array<{ artist_mbid?: string | null }>;
  const artistIds = new Set(
    rows
      .map((row) => getOptionalString(row.artist_mbid))
      .filter((value): value is string => value !== null),
  );

  return artistIds.size === 1 ? [...artistIds][0] : null;
}

function parseProviderData(value: unknown): Record<string, unknown> {
  if (!value) {
    return {};
  }

  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  if (typeof value !== "string") {
    return {};
  }

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function pickNestedString(record: Record<string, unknown>, key: string): string | null {
  return getOptionalString(record[key]);
}

function getOptionalNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeTrackStatus(value: unknown): QueueTrackProgress["status"] {
  return value === "downloading"
    || value === "completed"
    || value === "error"
    || value === "skipped"
    ? value
    : "queued";
}

function parseDownloadStateTracks(value: unknown): QueueItemContract["tracks"] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const tracks = value
    .map((track): QueueTrackProgress | null => {
      if (!track || typeof track !== "object") {
        return null;
      }
      const record = track as Record<string, unknown>;
      const title = getOptionalString(record.title);
      if (!title) {
        return null;
      }
      const trackNum = getOptionalNumber(record.trackNum);
      const volumeNum = getOptionalNumber(record.volumeNum);
      const providerTrackId = getOptionalString(record.providerTrackId);
      return {
        title,
        trackNum: trackNum ?? undefined,
        volumeNum: volumeNum ?? undefined,
        status: normalizeTrackStatus(record.status),
        ...(providerTrackId ? { providerTrackId } : {}),
      };
    })
    .filter((track): track is QueueTrackProgress => track !== null);

  return tracks.length > 0 ? tracks : undefined;
}

function resetTracksForImport(tracks?: QueueItemContract["tracks"]): QueueItemContract["tracks"] | undefined {
  return tracks?.map((track) => ({
    ...track,
    status: track.status === "skipped" ? "skipped" : "queued",
  }));
}

function resolveCanonicalAlbumMetadata(input: {
  releaseGroupMbid?: string | null;
  providerId?: string | null;
  provider?: string | null;
  acquisitionPlanId?: number | null;
}): QueueMetadata | null {
  const releaseGroupMbid = getOptionalString(input.releaseGroupMbid);
  const providerId = getOptionalString(input.providerId);
  const provider = getOptionalString(input.provider);
  const acquisitionPlanId = getOptionalNumber(input.acquisitionPlanId);
  if (!releaseGroupMbid && !providerId && !acquisitionPlanId) {
    return null;
  }

  const row = db.prepare(`
    SELECT
      release_group.mbid AS release_group_mbid,
      release_group.title AS release_group_title,
      release_group.images AS release_group_images,
      COALESCE(canonical_credit.credited_name, artist.name) AS artist_name,
      provider_item.provider AS selected_provider,
      provider_item.provider_id AS selected_provider_id,
      -- The queue badge is the same badge the album page shows, so it has to be
      -- the same expression. Reading provider_quality_label raw is what put
      -- "dolby-atmos,lossless,lossy-stereo,LOSSLESS" on a queued Atmos album:
      -- a provider's advertised trait list is not a quality tag, and the shared
      -- display SQL is the thing that knows to render Atmos as DOLBY_ATMOS.
      COALESCE(
        ${planHeadlineQualitySql("?")},
        (
          SELECT ${variantDisplayQualitySql("variant")}
          FROM ProviderItemAudioVariants variant
          WHERE variant.provider_item_id = provider_item.id
            AND LOWER(CAST(variant.availability AS TEXT))
                NOT IN ('0', 'false', 'unavailable', 'no', '')
          ORDER BY
            ${variantTierRankSql("variant")},
            variant.id
          LIMIT 1
        )
      ) AS selected_quality,
      provider_artist.title AS provider_artist_name,
      provider_item.title AS provider_title,
      COALESCE(provider_item.artwork_url, provider_item.cover_id) AS provider_cover,
      provider_item.cover_id AS provider_asset_id
    FROM ProviderEditionMatches release_match
    JOIN ProviderItems provider_item
      ON provider_item.id = release_match.provider_edition_item_id
    JOIN AlbumEditions release
      ON release.id = release_match.edition_id
    JOIN Albums release_group
      ON release_group.id = release.release_group_id
    LEFT JOIN AcquisitionPlanSources plan_source
      ON plan_source.provider_edition_match_id = release_match.id
     AND plan_source.plan_id = ?
    LEFT JOIN ReleaseGroupArtistCredits canonical_credit
      ON canonical_credit.release_group_id = release_group.id
     AND canonical_credit.ordinal = 0
    LEFT JOIN ArtistMetadata artist
      ON artist.id = release_group.artist_metadata_id
    LEFT JOIN ProviderItemCredits provider_credit
      ON provider_credit.item_id = provider_item.id
     AND provider_credit.ordinal = 0
    LEFT JOIN ProviderItems provider_artist
      ON provider_artist.id = provider_credit.artist_item_id
    WHERE release_match.match_state = 'accepted'
      AND (
        (? IS NOT NULL AND plan_source.id IS NOT NULL)
        OR (
          ? IS NOT NULL
          AND provider_item.provider_id = ?
          AND (? IS NULL OR provider_item.provider = ?)
        )
        OR (? IS NOT NULL AND release_group.mbid = ?)
      )
    ORDER BY
      CASE WHEN plan_source.id IS NOT NULL THEN 0 ELSE 1 END,
      CASE WHEN provider_item.provider_id = ? THEN 0 ELSE 1 END,
      CASE WHEN release_match.decision_source = 'manual' THEN 0 ELSE 1 END,
      release_match.confidence DESC,
      release_match.id
    LIMIT 1
  `).get(
    // 1 = the headline-quality expression, 2 = plan_source.plan_id,
    // 3 = the "was this row reached through the plan" guard.
    acquisitionPlanId,
    acquisitionPlanId,
    acquisitionPlanId,
    providerId,
    providerId,
    provider,
    provider,
    releaseGroupMbid,
    releaseGroupMbid,
    providerId,
  ) as {
    release_group_mbid?: string | null;
    release_group_title?: string | null;
    release_group_images?: string | null;
    artist_name?: string | null;
    selected_provider?: string | null;
    selected_provider_id?: string | null;
    selected_quality?: string | null;
    provider_title?: string | null;
    provider_quality?: string | null;
    provider_cover?: string | null;
    provider_artist_name?: string | null;
    provider_asset_id?: string | null;
  } | undefined;

  if (!row) {
    return null;
  }

  const cover = albumCoverLocalUrl({
    albumMbid: row.release_group_mbid,
    images: imageContainerFromImagesColumn(row.release_group_images),
  });

  return {
    title: row.release_group_title ?? row.provider_title,
    artist: row.artist_name ?? row.provider_artist_name,
    cover: cover ?? row.provider_cover ?? row.provider_asset_id,
    albumId: row.release_group_mbid ?? null,
    albumTitle: row.release_group_title ?? null,
    quality: row.selected_quality,
  };
}

function resolveProviderItemMetadata(input: {
  contentType: QueueItemContract["type"];
  providerId?: string | null;
  provider?: string | null;
}): QueueMetadata | null {
  const providerId = getOptionalString(input.providerId);
  if (!providerId) {
    return null;
  }

  const entityTypes = getProviderItemEntityTypes(input.contentType);
  const row = db.prepare(`
    SELECT
      provider_item.entity_type,
      provider_item.provider,
      provider_item.title,
      provider_artist.title AS provider_artist_name,
      COALESCE(
        provider_item.video_quality,
        ${variantDisplayQualitySql("provider_variant")}
      ) AS quality,
      provider_item.cover_id AS asset_id,
      COALESCE(provider_item.artwork_url, provider_item.cover_id) AS cover,
      COALESCE(direct_group.mbid, track_group.mbid) AS release_group_mbid,
      COALESCE(direct_release.mbid, track_release.mbid) AS release_mbid,
      COALESCE(direct_group.title, track_group.title) AS release_group_title,
      COALESCE(direct_group.images, track_group.images) AS release_group_images,
      artist.name AS artist_name,
      recording.id AS recording_id,
      track.title AS track_title,
      recording.title AS recording_title
    FROM ProviderItems provider_item
    LEFT JOIN ProviderEditionMatches release_match
      ON provider_item.entity_type = 'release'
     AND release_match.provider_edition_item_id = provider_item.id
     AND release_match.match_state = 'accepted'
    LEFT JOIN AlbumEditions direct_release ON direct_release.id = release_match.edition_id
    LEFT JOIN Albums direct_group ON direct_group.id = direct_release.release_group_id
    LEFT JOIN ProviderTrackMatches track_match
      ON provider_item.entity_type = 'track'
     AND track_match.provider_track_item_id = provider_item.id
     AND track_match.match_state = 'accepted'
    LEFT JOIN ProviderEditionMembers member
      ON member.id = track_match.provider_edition_member_id
    LEFT JOIN Tracks track ON track.id = track_match.track_id
    LEFT JOIN AlbumEditions track_release ON track_release.id = track.album_edition_id
    LEFT JOIN Albums track_group ON track_group.id = track_release.release_group_id
    LEFT JOIN ProviderVideoMatches video_match
      ON provider_item.entity_type = 'video'
     AND video_match.provider_video_item_id = provider_item.id
     AND video_match.match_state = 'accepted'
    LEFT JOIN Recordings recording
      ON recording.id = COALESCE(video_match.recording_id, track_match.recording_id)
    LEFT JOIN ArtistMetadata artist
      ON artist.id = COALESCE(
        direct_group.artist_metadata_id,
        track_group.artist_metadata_id,
        recording.artist_metadata_id
      )
    LEFT JOIN ProviderItemCredits provider_credit
      ON provider_credit.item_id = provider_item.id
     AND provider_credit.ordinal = 0
    LEFT JOIN ProviderItems provider_artist
      ON provider_artist.id = provider_credit.artist_item_id
    LEFT JOIN ProviderItemAudioVariants provider_variant
      ON provider_variant.id = (
        SELECT candidate.id
        FROM ProviderItemAudioVariants candidate
        WHERE candidate.provider_item_id = provider_item.id
        ORDER BY
          CASE candidate.availability WHEN 'available' THEN 0 ELSE 1 END,
          candidate.id
        LIMIT 1
      )
    WHERE provider_item.provider_id = ?
      AND provider_item.entity_type IN (${placeholders(entityTypes)})
      AND (? IS NULL OR provider_item.provider = ?)
      AND (
        track_match.id IS NULL
        OR NOT EXISTS (
          SELECT 1
          FROM ProviderTrackMatches conflicting_match
          WHERE conflicting_match.provider_track_item_id = provider_item.id
            AND conflicting_match.match_state = 'accepted'
            AND conflicting_match.recording_id != track_match.recording_id
        )
      )
    ORDER BY
      CASE WHEN COALESCE(
        release_match.decision_source,
        track_match.decision_source,
        video_match.decision_source
      ) = 'manual' THEN 0 ELSE 1 END,
      COALESCE(
        release_match.confidence,
        track_match.confidence,
        video_match.confidence,
        0
      ) DESC,
      provider_item.updated_at DESC
    LIMIT 1
  `).get(
    providerId,
    ...entityTypes,
    input.provider || null,
    input.provider || null,
  ) as {
    entity_type?: string | null;
    provider?: string | null;
    title?: string | null;
    provider_artist_name?: string | null;
    quality?: string | null;
    asset_id?: string | null;
    cover?: string | null;
    release_group_mbid?: string | null;
    release_mbid?: string | null;
    release_group_title?: string | null;
    release_group_images?: string | null;
    artist_name?: string | null;
    recording_id?: string | number | null;
    track_title?: string | null;
    recording_title?: string | null;
  } | undefined;

  if (!row) {
    return null;
  }

  const canonicalTitle = input.contentType === "album"
    ? row.release_group_title
    : row.track_title ?? row.recording_title;
  // Videos with a stamped release_group_mbid must still use the video poster —
  // album Cover is cropped art and is wrong for DownloadVideo queue/history rows.
  const cover = input.contentType === "video"
    ? videoCoverLocalUrl(row.recording_id)
    : row.release_group_mbid
      ? albumCoverLocalUrl({
          albumMbid: row.release_group_mbid,
          images: imageContainerFromImagesColumn(row.release_group_images),
        })
      : null;

  return {
    title: canonicalTitle ?? row.title,
    artist: row.artist_name ?? row.provider_artist_name,
    cover: cover ?? row.cover ?? row.asset_id,
    albumId: row.release_group_mbid ?? row.release_mbid ?? null,
    albumTitle: row.release_group_title ?? null,
    quality: row.quality,
  };
}

function resolveCanonicalAlbumTracks(input: {
  releaseGroupMbid?: string | null;
  releaseMbid?: string | null;
  acquisitionPlanId?: number | null;
  libraryId?: number | null;
}): QueueItemContract["tracks"] | undefined {
  const releaseMbid = getOptionalString(input.releaseMbid);
  const releaseGroupMbid = getOptionalString(input.releaseGroupMbid);
  const acquisitionPlanId = getOptionalNumber(input.acquisitionPlanId);
  const libraryId = getOptionalNumber(input.libraryId);
  if (!releaseMbid && !releaseGroupMbid && !acquisitionPlanId) {
    return undefined;
  }

  const rows = acquisitionPlanId != null
    ? db.prepare(`
        SELECT track.title, track.position, track.medium_position
        FROM AcquisitionPlanTracks plan_track
        JOIN Tracks track ON track.id = plan_track.track_id
        WHERE plan_track.plan_id = ?
        ORDER BY track.medium_position, track.position, track.id
      `).all(acquisitionPlanId) as Array<{
        title?: string | null;
        position?: number | null;
        medium_position?: number | null;
      }>
    : releaseMbid
    ? db.prepare(`
        SELECT title, position, medium_position
        FROM Tracks
        WHERE release_mbid = ?
        ORDER BY medium_position ASC, position ASC, id ASC
      `).all(releaseMbid) as Array<{
        title?: string | null;
        position?: number | null;
        medium_position?: number | null;
      }>
    : db.prepare(`
        SELECT track.title, track.position, track.medium_position
        FROM Albums release_group
        JOIN AlbumEditions release
          ON release.release_group_id = release_group.id
        JOIN LibraryEditions library_release
          ON library_release.edition_id = release.id
         AND (? IS NULL OR library_release.library_id = ?)
        JOIN Tracks track
          ON track.album_edition_id = release.id
        WHERE release_group.mbid = ?
        ORDER BY
          library_release.updated_at DESC,
          track.medium_position,
          track.position,
          track.id
      `).all(
        libraryId,
        libraryId,
        releaseGroupMbid,
      ) as Array<{
        title?: string | null;
        position?: number | null;
        medium_position?: number | null;
      }>;

  const tracks = rows
    .map((row, index): QueueTrackProgress | null => {
      const title = getOptionalString(row.title);
      return title ? {
        title,
        trackNum: getOptionalNumber(row.position) ?? index + 1,
        volumeNum: getOptionalNumber(row.medium_position) ?? undefined,
        status: "queued",
      } : null;
    })
    .filter((track): track is QueueTrackProgress => track !== null);

  return tracks.length > 0 ? tracks : undefined;
}

function resolveQueueItemTracks(
  job: QueueJobRow,
  downloadState: Record<string, unknown>,
  contentType: QueueItemContract["type"],
): QueueItemContract["tracks"] | undefined {
  const directTracks = parseDownloadStateTracks(downloadState.tracks);
  if (directTracks) {
    return directTracks;
  }

  if (job.name === CommandNames.ImportDownload) {
    const originalJobId = getOptionalNumber(job.payload?.originalJobId);
    const originalJob = originalJobId ? CommandQueueManager.get(originalJobId) as unknown as QueueJobRow | null : null;
    const originalDownloadState = (originalJob?.payload?.downloadState as Record<string, unknown> | undefined) ?? {};
    const originalTracks = resetTracksForImport(parseDownloadStateTracks(originalDownloadState.tracks));
    if (originalTracks?.length) {
      return originalTracks;
    }

    if (contentType === "album") {
      return resolveCanonicalAlbumTracks({
        releaseGroupMbid: getOptionalString(job.payload?.releaseGroupMbid),
        releaseMbid: getOptionalString(job.payload?.releaseMbid),
        acquisitionPlanId: getOptionalNumber(job.payload?.acquisitionPlanId),
        libraryId: getOptionalNumber(job.payload?.libraryId),
      });
    }
  }

  return undefined;
}

function normalizeQueueDetailsFilters(filters: QueueDetailsFilters): NormalizedQueueDetailsFilters {
  return {
    artistId: getOptionalString(filters.artistId) ?? undefined,
    albumIds: normalizeDistinctIdentifiers(filters.albumIds),
    providerIds: normalizeDistinctIdentifiers(filters.providerIds),
  };
}

function matchesQueueDetails(job: QueueJobRow, filters: NormalizedQueueDetailsFilters): boolean {
  if (filters.artistId && getJobArtistId(job) !== filters.artistId) {
    return false;
  }

  if (filters.albumIds.length > 0) {
    const albumId = getJobAlbumId(job);
    if (!albumId || !filters.albumIds.includes(albumId)) {
      return false;
    }
  }

  if (filters.providerIds.length > 0) {
    const providerId = getJobProviderId(job);
    if (!providerId || !filters.providerIds.includes(providerId)) {
      return false;
    }
  }

  return true;
}

function buildWaitQueuePositionById(): Map<number, number> {
  const rows = db.prepare(`
    SELECT
      id,
      ROW_NUMBER() OVER (
        ORDER BY queue_order ASC, id ASC
      ) AS queuePosition
    FROM DownloadQueue
    WHERE command_id IS NULL
  `).all() as Array<{ id: number; queuePosition: number }>;

  return new Map<number, number>(rows.map((row) => [Number(row.id), Number(row.queuePosition)]));
}

function buildQueuePositionById(): Map<number, number> {
  if (DownloadWaitQueue.count() > 0) {
    return buildWaitQueuePositionById();
  }
  const typePlaceholders = DOWNLOAD_COMMAND_NAMES.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT
      id,
      ROW_NUMBER() OVER (
        ORDER BY COALESCE(queue_order, 2147483647), created_at, id
      ) AS queuePosition
    FROM commands
    WHERE status = 'queued'
      AND name IN (${typePlaceholders})
  `).all(...DOWNLOAD_COMMAND_NAMES) as Array<{ id: number; queuePosition: number }>;

  return new Map<number, number>(rows.map((row) => [Number(row.id), Number(row.queuePosition)]));
}

function getPendingDownloadQueuePositionsForWaitIds(waitIds: readonly number[]): Map<number, number> {
  const queuePositionById = new Map<number, number>();
  if (waitIds.length === 0) {
    return queuePositionById;
  }

  const idPlaceholders = waitIds.map(() => "?").join(",");
  const rows = db.prepare(`
    WITH ranked AS (
      SELECT
        id,
        ROW_NUMBER() OVER (
          ORDER BY queue_order ASC, id ASC
        ) AS queuePosition
      FROM DownloadQueue
      WHERE command_id IS NULL
    )
    SELECT id, queuePosition
    FROM ranked
    WHERE id IN (${idPlaceholders})
  `).all(...waitIds) as Array<{ id: number; queuePosition: number }>;

  for (const row of rows) {
    queuePositionById.set(Number(row.id), Number(row.queuePosition));
  }

  return queuePositionById;
}

type WaitQueueJoinedRow = {
  id: number;
  ref_key: string;
  media_kind: string;
  command_name: string;
  plan_id: number | null;
  provider: string | null;
  provider_id: string | null;
  artist_id: string | null;
  album_id: string | null;
  title: string | null;
  artist: string | null;
  cover: string | null;
  quality: string | null;
  slot: string | null;
  wait_payload: unknown;
  queue_order: number;
  command_id: number | null;
  created_at: string;
  updated_at: string;
  command_status: string | null;
  command_payload: unknown;
  command_progress: number | null;
  command_error: string | null;
  started_at: string | null;
  completed_at: string | null;
  command_updated_at: string | null;
};

function parsePayloadValue(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function waitRowToQueueJob(row: WaitQueueJoinedRow): QueueJobRow {
  const waitPayload = parsePayloadValue(row.wait_payload);
  const commandPayload = parsePayloadValue(row.command_payload);
  const payload = {
    ...waitPayload,
    ...commandPayload,
    provider: row.provider ?? commandPayload.provider ?? waitPayload.provider,
    providerId: row.provider_id ?? commandPayload.providerId ?? waitPayload.providerId,
    title: row.title ?? commandPayload.title ?? waitPayload.title,
    artist: row.artist ?? commandPayload.artist ?? waitPayload.artist,
    cover: row.cover ?? commandPayload.cover ?? waitPayload.cover,
    quality: row.quality ?? commandPayload.quality ?? waitPayload.quality,
    slot: row.slot ?? commandPayload.slot ?? waitPayload.slot,
    album_id: row.album_id ?? commandPayload.album_id ?? waitPayload.album_id,
    albumId: row.album_id ?? commandPayload.albumId ?? waitPayload.albumId,
    artist_id: row.artist_id ?? commandPayload.artist_id ?? waitPayload.artist_id,
    artistId: row.artist_id ?? commandPayload.artistId ?? waitPayload.artistId,
  };
  const status = row.command_status === "started" || row.command_status === "failed"
    ? row.command_status
    : "queued";

  return {
    id: Number(row.id),
    name: row.command_name,
    status,
    ref_id: row.ref_key,
    payload,
    progress: typeof row.command_progress === "number" ? row.command_progress : 0,
    error: row.command_error,
    created_at: row.created_at,
    updated_at: row.command_updated_at ?? row.updated_at,
    started_at: row.started_at,
    completed_at: row.completed_at,
  };
}

const WAIT_QUEUE_ACTIVE_PREDICATE = `(dq.command_id IS NULL OR c.status IN ('queued', 'started'))`;

const WAIT_QUEUE_LIST_SQL = `
  SELECT
    dq.id,
    dq.ref_key,
    dq.media_kind,
    dq.command_name,
    dq.plan_id,
    dq.provider,
    dq.provider_id,
    dq.artist_id,
    dq.album_id,
    dq.title,
    dq.artist,
    dq.cover,
    dq.quality,
    dq.slot,
    dq.payload AS wait_payload,
    dq.queue_order,
    dq.command_id,
    dq.created_at,
    dq.updated_at,
    c.status AS command_status,
    c.payload AS command_payload,
    c.progress AS command_progress,
    c.error AS command_error,
    c.started_at,
    c.completed_at,
    c.updated_at AS command_updated_at
  FROM DownloadQueue dq
  LEFT JOIN commands c ON c.id = dq.command_id
`;

const WAIT_QUEUE_ORDER_SQL = `
  ORDER BY
    CASE
      WHEN c.status = 'started' THEN 0
      ELSE 1
    END,
    dq.queue_order ASC,
    dq.id ASC
`;

function countActiveWaitRows(): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM DownloadQueue dq
    LEFT JOIN commands c ON c.id = dq.command_id
    WHERE ${WAIT_QUEUE_ACTIVE_PREDICATE}
  `).get() as { count?: number };
  return Number(row.count || 0);
}

function getPendingDownloadQueuePositionsForIds(commandIds: readonly number[]): Map<number, number> {
  const queuePositionById = new Map<number, number>();
  if (commandIds.length === 0) {
    return queuePositionById;
  }

  const typePlaceholders = DOWNLOAD_COMMAND_NAMES.map(() => "?").join(",");
  const idPlaceholders = commandIds.map(() => "?").join(",");
  // One ranked pass over the pending queue. The previous correlated COUNT
  // subquery re-scanned the whole queued set per requested row, which cost
  // seconds per page once the backlog reached tens of thousands of commands.
  const rows = db.prepare(`
    WITH ranked AS (
      SELECT
        id,
        ROW_NUMBER() OVER (
          ORDER BY COALESCE(queue_order, 2147483647), created_at, id
        ) AS queuePosition
      FROM commands
      WHERE status = 'queued'
        AND name IN (${typePlaceholders})
    )
    SELECT id, queuePosition
    FROM ranked
    WHERE id IN (${idPlaceholders})
  `).all(...DOWNLOAD_COMMAND_NAMES, ...commandIds) as Array<{ id: number; queuePosition: number }>;

  for (const row of rows) {
    queuePositionById.set(Number(row.id), Number(row.queuePosition));
  }

  return queuePositionById;
}

type QueueHistoryQueryFilters = {
  outcomes?: readonly QueueHistoryOutcomeFilter[];
  mediaKinds?: readonly QueueHistoryMediaKindFilter[];
};

/** Outcome bucket used by history filters (matches app queueHistoryFilters). */
function queueHistoryOutcomeBucketSql(): string {
  return `
    CASE
      WHEN jq.status = 'failed' THEN 'failed'
      WHEN jq.status = 'completed'
        AND json_extract(jq.payload, '$.downloadState.outcome') = 'completedWithWarning'
        THEN 'warning'
      WHEN jq.status = 'completed' THEN 'completed'
      ELSE 'other'
    END
  `;
}

/**
 * Media-kind / library-slot bucket for history filters.
 * Videos win over slot; unset album/track slot defaults to stereo.
 */
function queueHistoryMediaKindSql(): string {
  return `
    CASE
      WHEN jq.name = '${CommandNames.DownloadVideo}' THEN 'video'
      WHEN jq.name = '${CommandNames.ImportDownload}'
        AND lower(coalesce(json_extract(jq.payload, '$.type'), '')) = 'video'
        THEN 'video'
      WHEN lower(coalesce(
        json_extract(jq.payload, '$.slot'),
        json_extract(jq.payload, '$.librarySlot'),
        'stereo'
      )) = 'spatial' THEN 'spatial'
      WHEN lower(coalesce(
        json_extract(jq.payload, '$.slot'),
        json_extract(jq.payload, '$.librarySlot'),
        'stereo'
      )) = 'video' THEN 'video'
      ELSE 'stereo'
    END
  `;
}

function buildLogicalHistoryQuery(
  filters: QueueHistoryQueryFilters = {},
): { whereSql: string; params: unknown[] } {
  const typeSql = placeholders(DOWNLOAD_OR_IMPORT_COMMAND_NAMES);
  const statusSql = placeholders(QUEUE_HISTORY_STATUSES);
  const clauses: string[] = [
    `jq.name IN (${typeSql})`,
    `jq.status IN (${statusSql})`,
  ];
  const params: unknown[] = [
    ...DOWNLOAD_OR_IMPORT_COMMAND_NAMES,
    ...QUEUE_HISTORY_STATUSES,
  ];
  // The current single-command download→import lifecycle creates no separate
  // ImportDownload rows. Avoid 100k redundant anti-join probes in that common
  // case; when legacy/test rows do exist, the generated original_job_id index
  // makes the exact collapse link cheap.
  const hasSeparateImportRows = db.prepare(`
    SELECT 1
    FROM commands
    WHERE name = ?
    LIMIT 1
  `).get(CommandNames.ImportDownload) != null;
  if (hasSeparateImportRows) {
    const downloadTypeSql = placeholders(DOWNLOAD_COMMAND_NAMES);
    clauses.push(`NOT (
      jq.name IN (${downloadTypeSql})
      AND EXISTS (
        SELECT 1
        FROM commands import_job
        WHERE import_job.name = ?
          AND import_job.original_job_id = jq.id
      )
    )`);
    params.push(...DOWNLOAD_COMMAND_NAMES, CommandNames.ImportDownload);
  }

  const outcomes = filters.outcomes ?? [];
  if (outcomes.length > 0) {
    clauses.push(`(${queueHistoryOutcomeBucketSql()}) IN (${placeholders(outcomes)})`);
    params.push(...outcomes);
  }

  const mediaKinds = filters.mediaKinds ?? [];
  if (mediaKinds.length > 0) {
    clauses.push(`(${queueHistoryMediaKindSql()}) IN (${placeholders(mediaKinds)})`);
    params.push(...mediaKinds);
  }

  return {
    whereSql: clauses.join("\n      AND "),
    params,
  };
}

function buildProgressFromQueueItem(item: QueueItemContract): DownloadProgressContract | null {
  const derivedState = item.state
    ?? (item.status === "failed"
      ? (item.stage === "import" ? "importFailed" : "failed")
      : item.stage === "import"
        ? (item.status === "started" || item.status === "downloading" ? "importing" : "importPending")
        : item.status === "completed"
          ? "completed"
          : item.status === "started" || item.status === "downloading"
            ? "downloading"
            : "queued");

  const hasPersistedState =
    item.currentFileNum !== undefined ||
    item.totalFiles !== undefined ||
    item.currentTrack !== undefined ||
    item.currentProviderTrackId !== undefined ||
    item.currentTrackNum !== undefined ||
    item.currentVolumeNum !== undefined ||
    item.trackProgress !== undefined ||
    item.trackStatus !== undefined ||
    item.statusMessage !== undefined ||
    item.state !== undefined ||
    (Array.isArray(item.tracks) && item.tracks.length > 0);

  if (!hasPersistedState && item.progress <= 0 && item.status === "queued" && item.stage !== "import") {
    return null;
  }

  const providerId = item.providerId ?? "";
  if (!providerId) {
    return null;
  }

  return {
    jobId: item.id,
    providerId,
    type: item.type,
    quality: item.quality ?? null,
    title: item.title,
    artist: item.artist,
    cover: item.cover ?? null,
    progress: item.progress ?? 0,
    speed: item.speed,
    eta: item.eta,
    totalFiles: item.totalFiles,
    currentFileNum: item.currentFileNum,
    currentTrack: item.currentTrack,
    currentProviderTrackId: item.currentProviderTrackId,
    currentTrackNum: item.currentTrackNum,
    currentVolumeNum: item.currentVolumeNum,
    trackProgress: item.trackProgress,
    trackStatus: item.trackStatus,
    statusMessage: item.statusMessage ?? (item.stage === "import" && derivedState === "importPending" ? "Waiting to import" : undefined),
    state: derivedState,
    tracks: item.tracks,
    size: item.size,
    sizeleft: item.sizeleft,
  };
}

export class DownloadQueueQueryService {
  // The dashboard polls queue/history/status every few seconds per client, and
  // each rebuild parses command payloads and runs several queries. Serving a
  // short-lived snapshot collapses concurrent pollers into at most one DB pass
  // per TTL. Structural changes (add/terminal-status/delete/clear/pause) burst
  // the cache; per-second progress ticks intentionally ride the TTL because
  // the SSE progress stream already delivers those live.
  private static readonly SNAPSHOT_TTL_MS = 1_500;
  private static snapshotCache = new Map<string, { value: unknown; at: number }>();
  private static snapshotEventsSubscribed = false;

  static invalidateSnapshots(): void {
    this.snapshotCache.clear();
  }

  private static getSnapshot<T>(key: string, build: () => T): T {
    this.ensureSnapshotInvalidation();

    const now = Date.now();
    const hit = this.snapshotCache.get(key);
    if (hit && now - hit.at < this.SNAPSHOT_TTL_MS) {
      return hit.value as T;
    }

    const value = build();
    if (this.snapshotCache.size > 32) {
      // Pages are keyed by limit/offset; anything beyond a handful of keys is
      // a scripted client. Reset rather than grow unbounded.
      this.snapshotCache.clear();
    }
    this.snapshotCache.set(key, { value, at: now });
    return value;
  }

  private static ensureSnapshotInvalidation(): void {
    if (this.snapshotEventsSubscribed) {
      return;
    }
    this.snapshotEventsSubscribed = true;

    const invalidate = () => this.invalidateSnapshots();

    appEvents.on(AppEvent.COMMAND_ADDED, invalidate);
    appEvents.on(AppEvent.COMMAND_DELETED, invalidate);
    appEvents.on(AppEvent.QUEUE_CLEARED, invalidate);
    appEvents.on(AppEvent.COMMAND_UPDATED, (event) => {
      // Progress ticks arrive as status "started" once per job per second;
      // only genuine transitions need an immediate rebuild.
      if (event.status !== 'started') {
        invalidate();
      }
    });
    downloadEvents.on('queue-status', invalidate);
    downloadEvents.on('started', invalidate);
  }

  static getQueueStatus(): QueueStatusContract {
    const status = downloadProcessor.getStatus();
    const stats = this.getSnapshot('status-stats', () => {
      const commandStats = ((CommandQueueManager.getStats() as Array<{
        name?: string;
        type?: string;
        status: string;
        count: number;
      }>) ?? []).map((row) => ({
        type: row.type ?? row.name ?? "",
        status: row.status,
        count: row.count,
      }));
      const waiting = DownloadWaitQueue.countUnclaimedByCommandName();
      const merged = commandStats.map((row) => ({ ...row }));
      for (const [name, count] of waiting) {
        const existing = merged.find((row) => row.type === name && row.status === "queued");
        if (existing) {
          existing.count = count;
        } else {
          merged.push({ type: name, status: "queued", count });
        }
      }
      return merged;
    });

    return {
      ...status,
      stats,
    };
  }

  static getQueue(params: { limit: number; offset: number }): QueueListResponseContract {
    return this.getSnapshot(`queue:${params.limit}:${params.offset}`, () => this.buildQueue(params));
  }

  private static buildQueue(params: { limit: number; offset: number }): QueueListResponseContract {
    if (DownloadWaitQueue.count() === 0) {
      const total = CommandQueueManager.countJobsByTypesAndStatuses(
        DOWNLOAD_OR_IMPORT_COMMAND_NAMES,
        LIVE_QUEUE_STATUSES,
      );
      const jobs = CommandQueueManager.listJobsByTypesAndStatuses(
        DOWNLOAD_OR_IMPORT_COMMAND_NAMES,
        LIVE_QUEUE_STATUSES,
        params.limit,
        params.offset,
        { orderBy: "download_activity" },
      ) as unknown as QueueJobRow[];
      const queuePositionById = getPendingDownloadQueuePositionsForIds(
        jobs
          .filter((job) => job.status === "queued" && DOWNLOAD_COMMAND_NAMES.includes(job.name as typeof DOWNLOAD_COMMAND_NAMES[number]))
          .map((job) => job.id),
      );
      const items = jobs.map((job) => this.mapDownloadQueueJob(job, queuePositionById.get(job.id)));
      return {
        items,
        total,
        limit: params.limit,
        offset: params.offset,
        hasMore: params.offset + jobs.length < total,
      };
    }

    const total = countActiveWaitRows();
    const rows = db.prepare(`
      ${WAIT_QUEUE_LIST_SQL}
      WHERE ${WAIT_QUEUE_ACTIVE_PREDICATE}
      ${WAIT_QUEUE_ORDER_SQL}
      LIMIT ? OFFSET ?
    `).all(params.limit, params.offset) as WaitQueueJoinedRow[];
    const jobs = rows.map((row) => waitRowToQueueJob(row));
    const queuePositionById = getPendingDownloadQueuePositionsForWaitIds(
      jobs.filter((job) => job.status === "queued").map((job) => job.id),
    );
    const items = jobs.map((job) => this.mapDownloadQueueJob(job, queuePositionById.get(job.id)));

    return {
      items,
      total,
      limit: params.limit,
      offset: params.offset,
      hasMore: params.offset + jobs.length < total,
    };
  }

  static getQueueHistory(params: {
    limit: number;
    offset: number;
    outcomes?: readonly QueueHistoryOutcomeFilter[];
    mediaKinds?: readonly QueueHistoryMediaKindFilter[];
  }): QueueListResponseContract {
    const outcomesKey = (params.outcomes ?? []).slice().sort().join(",");
    const mediaKindsKey = (params.mediaKinds ?? []).slice().sort().join(",");
    return this.getSnapshot(
      `history:${params.limit}:${params.offset}:${outcomesKey}:${mediaKindsKey}`,
      () => this.buildQueueHistory(params),
    );
  }

  private static buildQueueHistory(params: {
    limit: number;
    offset: number;
    outcomes?: readonly QueueHistoryOutcomeFilter[];
    mediaKinds?: readonly QueueHistoryMediaKindFilter[];
  }): QueueListResponseContract {
    const logicalHistory = buildLogicalHistoryQuery({
      outcomes: params.outcomes,
      mediaKinds: params.mediaKinds,
    });
    const totalRow = db.prepare(`
      SELECT COUNT(*) AS count
      FROM commands jq
      WHERE ${logicalHistory.whereSql}
    `).get(...logicalHistory.params) as { count?: number } | undefined;
    const total = Number(totalRow?.count || 0);

    const rows = db.prepare(`
      SELECT jq.id
      FROM commands jq
      WHERE ${logicalHistory.whereSql}
      ORDER BY
        jq.completed_at DESC,
        jq.updated_at DESC,
        jq.started_at DESC,
        jq.created_at DESC,
        jq.id DESC
      LIMIT ? OFFSET ?
    `).all(...logicalHistory.params, params.limit, params.offset) as Array<{ id: number }>;
    const jobs = rows
      .map((row) => CommandQueueManager.get(row.id))
      .filter((job) => job !== null) as unknown as QueueJobRow[];

    return {
      items: jobs.map((job) => this.mapDownloadQueueJob(job)),
      total,
      limit: params.limit,
      offset: params.offset,
      hasMore: params.offset + jobs.length < total,
    };
  }

  static getQueueDetails(filters: QueueDetailsFilters): QueueItemContract[] {
    const normalizedFilters = normalizeQueueDetailsFilters(filters);
    // With a few thousand queued albums the raw listing alone costs ~1.5s of
    // synchronous payload parsing, so repeat polls must share one snapshot.
    const cacheKey = `details:${normalizedFilters.artistId ?? ""}:${normalizedFilters.albumIds.join(",")}:${normalizedFilters.providerIds.join(",")}`;
    return this.getSnapshot(cacheKey, () => {
      const queuePositionById = buildQueuePositionById();
      if (DownloadWaitQueue.count() === 0) {
        const jobs = CommandQueueManager.listJobsByTypesAndStatuses(
          DOWNLOAD_OR_IMPORT_COMMAND_NAMES,
          LIVE_QUEUE_STATUSES,
          5000,
          0,
          { orderBy: "queue_order" },
        ) as unknown as QueueJobRow[];
        return jobs
          .filter((job) => matchesQueueDetails(job, normalizedFilters))
          .map((job) => this.mapDownloadQueueJob(job, queuePositionById.get(job.id)));
      }
      const clauses: string[] = [WAIT_QUEUE_ACTIVE_PREDICATE];
      const sqlParams: unknown[] = [];
      if (normalizedFilters.artistId) {
        clauses.push(`(
          dq.artist_id = ?
          OR dq.album_id IN (
            SELECT release_group.mbid
            FROM Albums release_group
            LEFT JOIN ArtistMetadata artist ON artist.id = release_group.artist_metadata_id
            LEFT JOIN Artists managed ON managed.mbid = artist.mbid
            WHERE managed.id = ? OR artist.mbid = ? OR managed.mbid = ?
          )
        )`);
        sqlParams.push(
          normalizedFilters.artistId,
          normalizedFilters.artistId,
          normalizedFilters.artistId,
          normalizedFilters.artistId,
        );
      }
      if (normalizedFilters.albumIds.length > 0) {
        clauses.push(`dq.album_id IN (${placeholders(normalizedFilters.albumIds)})`);
        sqlParams.push(...normalizedFilters.albumIds);
      }
      if (normalizedFilters.providerIds.length > 0) {
        clauses.push(`dq.provider_id IN (${placeholders(normalizedFilters.providerIds)})`);
        sqlParams.push(...normalizedFilters.providerIds);
      }
      const whereSql = `WHERE ${clauses.join(" AND ")}`;
      const rows = db.prepare(`
        ${WAIT_QUEUE_LIST_SQL}
        ${whereSql}
        ${WAIT_QUEUE_ORDER_SQL}
        LIMIT 5000
      `).all(...sqlParams) as WaitQueueJoinedRow[];

      return rows
        .map((row) => waitRowToQueueJob(row))
        .map((job) => this.mapDownloadQueueJob(job, queuePositionById.get(job.id)));
    });
  }

  static getActiveProgressSnapshots(): DownloadProgressContract[] {
    // Initial payload for the SSE progress stream. Only jobs that are actually
    // running belong here — the queue/history endpoints carry everything else.
    // Mapping the whole backlog (mapDownloadQueueJob does per-row lookups) took
    // ~30s of synchronous main-thread work per connection with a few thousand
    // queued albums, which is what made the app unreachable under load.
    return this.getSnapshot('active-progress', () => {
      if (DownloadWaitQueue.count() === 0) {
        const jobs = CommandQueueManager.listJobsByTypesAndStatuses(
          DOWNLOAD_OR_IMPORT_COMMAND_NAMES,
          ["started"],
          50,
          0,
          { orderBy: "queue_order" },
        ) as unknown as QueueJobRow[];
        return jobs
          .map((job) => this.mapDownloadQueueJob(job))
          .map((item) => buildProgressFromQueueItem(item))
          .filter((item): item is DownloadProgressContract => item !== null);
      }
      const rows = db.prepare(`
        ${WAIT_QUEUE_LIST_SQL}
        WHERE c.status = 'started'
        ${WAIT_QUEUE_ORDER_SQL}
        LIMIT 50
      `).all() as WaitQueueJoinedRow[];

      return rows
        .map((row) => waitRowToQueueJob(row))
        .map((job) => this.mapDownloadQueueJob(job))
        .map((item) => buildProgressFromQueueItem(item))
        .filter((item): item is DownloadProgressContract => item !== null);
    });
  }

  static mapDownloadQueueJob(job: QueueJobRow, queuePosition?: number): QueueItemContract {
    const downloadState = (job.payload?.downloadState as Record<string, unknown> | undefined) ?? {};
    const contentType = resolveQueueItemContentType(job);
    const providerId = getJobProviderId(job);

    let title = getOptionalString(job.payload?.title)
      ?? getOptionalString((job.payload?.resolved as Record<string, unknown> | undefined)?.title)
      ?? undefined;
    let artist = getOptionalString(job.payload?.artist)
      ?? getOptionalString((job.payload?.resolved as Record<string, unknown> | undefined)?.artist)
      ?? undefined;
    let cover = getOptionalString(job.payload?.cover)
      ?? getOptionalString((job.payload?.resolved as Record<string, unknown> | undefined)?.cover);
    let albumId = getOptionalString(
      job.payload?.album_id
      ?? job.payload?.albumId
      ?? job.payload?.releaseGroupMbid
      ?? (job.payload?.resolved as Record<string, unknown> | undefined)?.albumId,
    );
    let albumTitle = getOptionalString(
      job.payload?.album_title
      ?? job.payload?.albumTitle
      ?? (job.payload?.resolved as Record<string, unknown> | undefined)?.albumTitle,
    );
    let quality = getOptionalString(job.payload?.quality);
    const slot = getOptionalString(job.payload?.slot)
      ?? getOptionalString(job.payload?.librarySlot)
      ?? null;
    const tracks = resolveQueueItemTracks(job, downloadState, contentType);

    // The two resolvers below are heavy per-item joins. They only fill gaps, and
    // queued downloads already carry title/artist/cover in their payload (set at
    // enqueue time). When a full queue is polled, running them for every item is
    // what starves the synchronous event loop under download load — so skip them
    // when the display basics are present and resolve only the cover, cheaply,
    // through the indexed local-cover mapper.
    const hasDisplayBasics = Boolean(title && artist);
    const canonicalMetadata = hasDisplayBasics ? null : resolveCanonicalAlbumMetadata({
      releaseGroupMbid: albumId,
      providerId,
      provider: getOptionalString(job.payload?.provider),
      acquisitionPlanId: getOptionalNumber(job.payload?.acquisitionPlanId),
    });
    const providerItemMetadata = (!hasDisplayBasics || !cover) ? resolveProviderItemMetadata({
      contentType,
      providerId,
      provider: getOptionalString(job.payload?.provider),
    }) : null;
    // Point album items at the internal media-cover proxy — the same source the
    // library grid, artist page and album page use — instead of the raw provider
    // asset id from the payload. This keeps artwork handling in one place (the
    // backend proxy fetches/caches/resizes) and gives the queue the resized UI
    // image rather than a bare id the frontend can't render.
    if (albumId && contentType === "album") {
      cover = albumCoverLocalUrl({ albumMbid: albumId }) ?? cover;
    }
    const offerMetadata = canonicalMetadata ?? providerItemMetadata;
    if (offerMetadata) {
      title ||= offerMetadata.title ?? undefined;
      artist ||= offerMetadata.artist ?? undefined;
      cover ||= offerMetadata.cover ?? null;
      albumId ||= offerMetadata.albumId ?? null;
      albumTitle ||= offerMetadata.albumTitle ?? null;
      quality ||= offerMetadata.quality ?? null;
    }
    // Prefer the video poster over any album art gap-fill or stale payload cover.
    let mediaId: string | null = null;
    if (contentType === "video") {
      mediaId = getOptionalString(job.payload?.canonicalRecordingId)
        ?? getOptionalString(
          (job.payload?.resolved as Record<string, unknown> | undefined)?.canonicalRecordingId,
        )
        ?? resolveRequestedVideoOffer(
          getOptionalString(job.payload?.provider),
          providerId,
        )?.recordingId
        ?? null;
      cover = videoCoverLocalUrl(mediaId) ?? cover;
    }

    return {
      id: job.id,
      provider: getOptionalString(job.payload?.provider) ?? null,
      providerId,
      type: contentType,
      status: job.status as QueueItemContract["status"],
      // One command spans download → import; the phase comes from the persisted
      // lifecycle state, not a separate ImportDownload row.
      stage: (job.name === CommandNames.ImportDownload
        || downloadState.state === "importPending"
        || downloadState.state === "importing"
        || downloadState.state === "importFailed")
        ? "import"
        : "download",
      progress: (typeof downloadState.progress === "number" && Number.isFinite(downloadState.progress))
        ? downloadState.progress
        : (typeof job.progress === "number" && Number.isFinite(job.progress) ? job.progress : 0),
      error: getOptionalString(job.error) ?? null,
      created_at: job.created_at || new Date().toISOString(),
      updated_at: job.updated_at || job.created_at || new Date().toISOString(),
      started_at: job.started_at ?? null,
      completed_at: job.completed_at ?? null,
      url: getOptionalString(job.payload?.url) ?? null,
      path: getOptionalString(job.payload?.path) ?? null,
      title: title || "Unknown",
      artist: artist || "Unknown",
      cover: renderableProviderArtworkUrl(cover, getOptionalString(job.payload?.provider)),
      quality: quality ?? null,
      album_id: albumId ?? null,
      album_title: albumTitle ?? null,
      media_id: mediaId,
      currentFileNum: typeof downloadState.currentFileNum === "number" ? downloadState.currentFileNum : undefined,
      totalFiles: typeof downloadState.totalFiles === "number" ? downloadState.totalFiles : undefined,
      currentTrack: getOptionalString(downloadState.currentTrack) ?? undefined,
      currentProviderTrackId: getOptionalString(downloadState.currentProviderTrackId) ?? undefined,
      currentTrackNum: typeof downloadState.currentTrackNum === "number"
        ? downloadState.currentTrackNum
        : getOptionalNumber(job.payload?.trackNumber) ?? undefined,
      currentVolumeNum: typeof downloadState.currentVolumeNum === "number"
        ? downloadState.currentVolumeNum
        : getOptionalNumber(job.payload?.volumeNumber) ?? undefined,
      trackProgress: typeof downloadState.trackProgress === "number" ? downloadState.trackProgress : undefined,
      trackStatus: getOptionalString(downloadState.trackStatus) as QueueItemContract["trackStatus"] | undefined,
      statusMessage: getOptionalString(downloadState.statusMessage) ?? undefined,
      state: getOptionalString(downloadState.state) as QueueItemContract["state"] | undefined,
      outcome: (() => {
        const outcome = getOptionalString(downloadState.outcome);
        return outcome === "ok" || outcome === "completedWithWarning"
          ? outcome
          : undefined;
      })(),
      warningMessage: getOptionalString(downloadState.warningMessage) ?? null,
      speed: getOptionalString(downloadState.speed) ?? undefined,
      eta: getOptionalString(downloadState.eta) ?? undefined,
      size: typeof downloadState.size === "number" ? downloadState.size : undefined,
      sizeleft: typeof downloadState.sizeleft === "number" ? downloadState.sizeleft : undefined,
      tracks,
      queuePosition,
      slot,
    };
  }
}
