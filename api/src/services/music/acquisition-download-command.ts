import type Database from "better-sqlite3";
import { CommandNames } from "../commands/command-names.js";
import {
  type DownloadAlbumAcquisitionMode,
  type DownloadAlbumCommand,
  type DownloadTrackOffer,
  type DownloadTrackStateEntry,
} from "../commands/command-bodies.js";
import { buildStreamingMediaUrl } from "../download/download-routing.js";
import { formatTrackDisplayTitle } from "../../utils/display-title.js";

interface PlanHeader {
  plan_id: number;
  provider: string;
  composition: "single_source" | "composite";
  download_mode: "album" | "tracks";
  library_id: number;
  library_name: string;
  root_path: string;
  edition_id: number;
  release_mbid: string;
  release_group_mbid: string;
  album_title: string;
  artist_name: string;
}

interface PlanSource {
  source_id: number;
  role: "primary" | "supplement";
  sort_order: number;
  provider_release_id: string;
}

interface PlanTrack {
  track_id: number;
  track_mbid: string;
  recording_mbid: string;
  title: string;
  recording_disambiguation: string | null;
  provider_version: string | null;
  medium_position: number;
  position: number;
  provider_track_id: string;
  provider_track_item_id: number;
  provider_release_id: string;
  provider_edition_item_id: number;
  provider_audio_variant_id: number;
  acquisition_plan_source_id: number;
  source_quality_snapshot: string | null;
  complete: number;
}

export interface AcquisitionDownloadCommand {
  name: typeof CommandNames.DownloadAlbum;
  body: DownloadAlbumCommand;
  refId: string;
}

function sourceQuality(snapshot: string | null): string | null {
  try {
    const parsed = JSON.parse(String(snapshot || "{}")) as { quality?: unknown };
    const quality = String(parsed.quality || "").trim();
    return quality || null;
  } catch {
    return null;
  }
}

function displaySlot(libraryName: string): "stereo" | "spatial" {
  return /spatial|atmos/i.test(libraryName) ? "spatial" : "stereo";
}

export function buildAcquisitionDownloadCommand(
  db: Database.Database,
  planId: number,
  options: { trackIds?: readonly number[] } = {},
): AcquisitionDownloadCommand | null {
  const header = db.prepare(`
    SELECT
      plan.id AS plan_id,
      plan.provider,
      plan.composition,
      plan.download_mode,
      library.id AS library_id,
      library.name AS library_name,
      library.root_path,
      release.id AS edition_id,
      release.mbid AS release_mbid,
      release_group.mbid AS release_group_mbid,
      release_group.title AS album_title,
      COALESCE(primary_credit.credited_name, primary_artist.name, 'Unknown Artist') AS artist_name
    FROM SelectedAcquisitionPlans plan
    JOIN LibraryEditions library_release ON library_release.id = plan.library_edition_id
    JOIN Libraries library ON library.id = library_release.library_id
    JOIN AlbumEditions release ON release.id = library_release.edition_id
    JOIN Albums release_group ON release_group.id = release.release_group_id
    LEFT JOIN ReleaseGroupArtistCredits primary_credit
      ON primary_credit.release_group_id = release_group.id AND primary_credit.ordinal = 0
    LEFT JOIN ArtistMetadata primary_artist
      ON primary_artist.id = release_group.artist_metadata_id
    WHERE plan.id = ? AND plan.state = 'current'
  `).get(planId) as PlanHeader | undefined;
  if (!header) return null;

  const sources = db.prepare(`
    SELECT
      source.id AS source_id,
      source.role,
      source.sort_order,
      release_item.provider_id AS provider_release_id
    FROM AcquisitionPlanSources source
    JOIN ProviderEditionMatches release_match
      ON release_match.id = source.provider_edition_match_id
    JOIN ProviderItems release_item
      ON release_item.id = release_match.provider_edition_item_id
    WHERE source.plan_id = ?
    ORDER BY source.sort_order, source.id
  `).all(planId) as PlanSource[];
  const primarySource = sources[0];
  if (!primarySource) return null;

  let tracks = db.prepare(`
    SELECT
      plan_track.track_id,
      track.mbid AS track_mbid,
      recording.mbid AS recording_mbid,
      track.title,
      recording.disambiguation AS recording_disambiguation,
      member_item.version AS provider_version,
      track.medium_position,
      track.position,
      member_item.provider_id AS provider_track_id,
      member_item.id AS provider_track_item_id,
      release_item.provider_id AS provider_release_id,
      release_item.id AS provider_edition_item_id,
      plan_track.provider_audio_variant_id,
      plan_track.source_id AS acquisition_plan_source_id,
      plan_track.source_quality_snapshot,
      CASE WHEN EXISTS (
        SELECT 1
        FROM TrackFiles file
        WHERE file.library_id = ?
          AND file.album_edition_id = ?
          AND file.track_id = plan_track.track_id
          AND file.recording_id = track.recording_id
          AND file.file_class = 'audio'
      ) THEN 1 ELSE 0 END AS complete
    FROM AcquisitionPlanTracks plan_track
    JOIN Tracks track ON track.id = plan_track.track_id
    JOIN Recordings recording ON recording.id = track.recording_id
    JOIN ProviderTrackMatches track_match
      ON track_match.id = plan_track.provider_track_match_id
    JOIN ProviderEditionMembers member
      ON member.id = track_match.provider_edition_member_id
    JOIN ProviderItems member_item ON member_item.id = member.member_item_id
    JOIN AcquisitionPlanSources source ON source.id = plan_track.source_id
    JOIN ProviderEditionMatches release_match
      ON release_match.id = source.provider_edition_match_id
    JOIN ProviderItems release_item
      ON release_item.id = release_match.provider_edition_item_id
    WHERE plan_track.plan_id = ?
    ORDER BY track.medium_position, track.position, track.id
  `).all(header.library_id, header.edition_id, planId) as PlanTrack[];
  const requestedTrackIds = new Set(options.trackIds || []);
  if (requestedTrackIds.size > 0) {
    tracks = tracks.filter((track) => requestedTrackIds.has(track.track_id));
  }
  if (tracks.length === 0 || tracks.every((track) => Boolean(track.complete))) return null;

  const forceTracks = requestedTrackIds.size > 0
    || header.download_mode === "tracks"
    || tracks.some((track) => Boolean(track.complete));
  const acquisitionMode: DownloadAlbumAcquisitionMode = forceTracks ? "trackOffers" : "album";
  const missingTracks = tracks.filter((track) => !track.complete);
  const trackOffers: DownloadTrackOffer[] = missingTracks.map((track) => ({
    provider: header.provider,
    providerTrackId: track.provider_track_id,
    providerTrackItemId: track.provider_track_item_id,
    providerAlbumId: track.provider_release_id,
    providerEditionItemId: track.provider_edition_item_id,
    providerAudioVariantId: track.provider_audio_variant_id,
    acquisitionPlanSourceId: track.acquisition_plan_source_id,
    canonicalTrackMbid: track.track_mbid,
    canonicalRecordingMbid: track.recording_mbid,
    title: formatTrackDisplayTitle(track.title, track.recording_disambiguation, track.provider_version),
    quality: sourceQuality(track.source_quality_snapshot),
    trackNum: track.position,
    volumeNum: track.medium_position,
  }));
  const trackStates: DownloadTrackStateEntry[] = tracks.map((track) => ({
    title: formatTrackDisplayTitle(track.title, track.recording_disambiguation, track.provider_version),
    trackNum: track.position,
    volumeNum: track.medium_position,
    status: track.complete ? "skipped" : "queued",
    providerTrackId: track.provider_track_id,
    provider: header.provider,
    quality: sourceQuality(track.source_quality_snapshot),
    canonicalTrackMbid: track.track_mbid,
    canonicalRecordingMbid: track.recording_mbid,
  }));
  const done = tracks.length - missingTracks.length;
  const slot = displaySlot(header.library_name);

  return {
    name: CommandNames.DownloadAlbum,
    refId: requestedTrackIds.size > 0
      ? `acquisition-plan:${planId}:tracks:${[...requestedTrackIds].sort((a, b) => a - b).join(",")}`
      : `acquisition-plan:${planId}`,
    body: {
      url: acquisitionMode === "album"
        ? buildStreamingMediaUrl("album", primarySource.provider_release_id, header.provider as any)
        : null,
      type: "album",
      provider: header.provider,
      providerId: primarySource.provider_release_id,
      releaseGroupMbid: header.release_group_mbid,
      releaseMbid: header.release_mbid,
      albumId: header.release_group_mbid,
      libraryId: header.library_id,
      acquisitionPlanId: header.plan_id,
      libraryRoot: slot === "spatial" ? "spatial" : "music",
      slot,
      title: header.album_title,
      artist: header.artist_name,
      artists: [header.artist_name],
      description: `${header.album_title} by ${header.artist_name} (${header.library_name})`,
      acquisitionMode,
      // Carry exact per-track authority even for an album-mode backend call.
      // The downloader ignores these unless acquisitionMode=trackOffers, while
      // the importer uses them to persist provenance on the exact file rows.
      trackOffers,
      downloadState: {
        state: "queued",
        currentFileNum: done,
        totalFiles: tracks.length,
        progress: Math.round((done / tracks.length) * 100),
        tracks: trackStates,
      },
    },
  };
}
