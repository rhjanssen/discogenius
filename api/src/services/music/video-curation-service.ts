import type Database from "better-sqlite3";
import { emitLibraryUpdated } from "../commands/app-events.js";
import { getConfigSection } from "../config/config.js";
import { canonicalVideoType } from "./canonical-video-type.js";
import {
  curateLibraryVideos,
  type InlinePlacementCandidate,
  type VideoCandidate,
  type VideoLayout,
} from "./video-curation.js";
import {
  resolveVideoLibraryIds,
  selectLibraryVideo,
} from "./library-video-monitoring.js";
import { isVideoVariantDownloadAllowed } from "./video-type-filter.js";
import { normalizeVideoFolderLayout } from "../mediafiles/video-folder-layout.js";

/**
 * Run video curation for one Video Library: load the candidates, decide, persist.
 *
 * Candidates come from the canonical/provider layer — every video Discogenius
 * knows about, with its accepted relation to an exact audio Recording and the
 * Editions that carry it outright. Selection and placement come from
 * `video-curation.ts`, which is a pure function so the ranking can be argued
 * with in a unit test rather than through a database.
 *
 * Placement is written in the same transaction as the selection, so a video is
 * never briefly monitored with no destination, and the partial unique index
 * rejects two occupants of one Plex slot outright.
 */

interface CandidateRow {
  video_recording_id: number;
  video_variant: string | null;
  audio_recording_id: number | null;
  relation_confidence: number | null;
  relation_source: string | null;
  provider_available: number;
  provider_quality_rank: number | null;
  manually_selected: number;
}

interface PlacementRow {
  track_id: number;
  edition_id: number;
  release_group_id: number;
  audio_recording_id: number;
  placement_library_id: number;
  primary_type: string | null;
  secondary_types: string | null;
  edition_track_count: number | null;
  representative: number;
}

function releaseKind(
  primaryType: string | null,
  secondaryTypes: string | null,
): InlinePlacementCandidate["releaseKind"] {
  const secondary = String(secondaryTypes || "").toLowerCase();
  if (secondary.includes('"live"')) return "live";
  if (secondary.includes('"compilation"')) return "compilation";
  const primary = String(primaryType || "").trim().toLowerCase();
  if (primary === "album" || primary === "ep" || primary === "single") return "studio";
  return "other";
}

/** Provider video quality, coarse and ordered; lower is better. */
const VIDEO_QUALITY_RANK: Record<string, number> = {
  "2160p": 0, "4k": 0, "1440p": 1, "1080p": 2, "720p": 3, "480p": 4, "360p": 5,
};

function qualityRank(label: string | null): number {
  const normalized = String(label || "").trim().toLowerCase();
  return VIDEO_QUALITY_RANK[normalized] ?? 9;
}

function loadAudioRelations(
  db: Database.Database,
  artistMbid: string,
): Map<number, Map<number, { confidence: number; accepted: boolean }>> {
  const relations = new Map<number, Map<number, { confidence: number; accepted: boolean }>>();
  const rows = db.prepare(`
    SELECT
      relation.source_recording_id AS video_recording_id,
      relation.target_recording_id AS audio_recording_id,
      relation.confidence,
      relation.source
    FROM RecordingRelations relation
    JOIN Recordings video
      ON video.id = relation.source_recording_id
     AND video.is_video = 1
    JOIN Recordings audio
      ON audio.id = relation.target_recording_id
     AND audio.is_video = 0
    WHERE video.artist_mbid = ?
      AND relation.relation_type IN ('provider_video_for', 'music_video_for')
    ORDER BY
      relation.source_recording_id,
      CASE relation.source WHEN 'musicbrainz' THEN 0 ELSE 1 END,
      relation.confidence DESC,
      relation.id
  `).all(artistMbid) as Array<{
    video_recording_id: number;
    audio_recording_id: number;
    confidence: number | null;
    source: string | null;
  }>;

  for (const row of rows) {
    let byAudio = relations.get(row.video_recording_id);
    if (!byAudio) {
      byAudio = new Map();
      relations.set(row.video_recording_id, byAudio);
    }
    // The SQL order puts the strongest statement for one exact target first.
    if (!byAudio.has(row.audio_recording_id)) {
      byAudio.set(row.audio_recording_id, {
        confidence: row.confidence == null ? 0 : Number(row.confidence),
        accepted: row.source === "musicbrainz",
      });
    }
  }
  return relations;
}

/** Every canonical video for an artist, with the evidence curation ranks on. */
function loadCandidates(db: Database.Database, artistMbid: string): VideoCandidate[] {
  const rows = db.prepare(`
    SELECT
      video.id AS video_recording_id,
      video.video_variant,
      relation.target_recording_id AS audio_recording_id,
      relation.confidence AS relation_confidence,
      relation.source AS relation_source,
      CASE WHEN EXISTS (
        SELECT 1
        FROM ProviderVideoMatches match
        JOIN ProviderItems item ON item.id = match.provider_video_item_id
        WHERE match.recording_id = video.id
          AND match.match_state = 'accepted'
          AND item.entity_type = 'video'
          AND (
            item.availability IS NULL
            OR LOWER(CAST(item.availability AS TEXT))
               NOT IN ('0', 'false', 'unavailable', 'no', '')
          )
      ) THEN 1 ELSE 0 END AS provider_available,
      (
        SELECT item.video_quality
        FROM ProviderVideoMatches match
        JOIN ProviderItems item ON item.id = match.provider_video_item_id
        WHERE match.recording_id = video.id AND match.match_state = 'accepted'
        ORDER BY match.confidence DESC, match.id
        LIMIT 1
      ) AS provider_quality_label,
      CASE WHEN EXISTS (
        SELECT 1 FROM LibraryVideos selected
        WHERE selected.video_recording_id = video.id
          AND selected.selection_mode = 'manual'
      ) THEN 1 ELSE 0 END AS manually_selected
    FROM Recordings video
    LEFT JOIN RecordingRelations relation
      ON relation.id = (
        SELECT best.id FROM RecordingRelations best
        WHERE best.source_recording_id = video.id
          AND best.relation_type IN ('provider_video_for', 'music_video_for')
          AND best.target_recording_id IS NOT NULL
        ORDER BY best.confidence DESC, best.id
        LIMIT 1
      )
    WHERE video.is_video = 1 AND video.artist_mbid = ?
    ORDER BY video.id
  `).all(artistMbid) as Array<CandidateRow & { provider_quality_label: string | null }>;

  // Editions that carry each video as a canonical Track outright.
  const directEditionIds = new Map<number, Set<number>>();
  for (const row of db.prepare(`
    SELECT track.recording_id, track.album_edition_id
    FROM Tracks track
    JOIN Recordings video ON video.id = track.recording_id
    WHERE video.is_video = 1 AND video.artist_mbid = ?
      AND track.album_edition_id IS NOT NULL
  `).all(artistMbid) as Array<{ recording_id: number; album_edition_id: number }>) {
    const editions = directEditionIds.get(row.recording_id) || new Set<number>();
    editions.add(row.album_edition_id);
    directEditionIds.set(row.recording_id, editions);
  }

  const filtering = getConfigSection("filtering");
  const audioRelations = loadAudioRelations(db, artistMbid);
  return rows
    // A video type the user turned off is not a candidate at all.
    .filter((row) => isVideoVariantDownloadAllowed(row.video_variant, filtering))
    .map((row) => ({
      videoRecordingId: row.video_recording_id,
      canonicalType: canonicalVideoType(row.video_variant),
      audioRecordingId: row.audio_recording_id,
      audioRelations: audioRelations.get(row.video_recording_id),
      relationConfidence: row.relation_confidence == null ? 0 : Number(row.relation_confidence),
      // MusicBrainz states the relation outright; everything else inferred it.
      relationAccepted: row.relation_source === "musicbrainz",
      directEditionIds: directEditionIds.get(row.video_recording_id) ?? new Set<number>(),
      providerAvailable: row.provider_available === 1,
      providerQualityRank: qualityRank(row.provider_quality_label),
      manuallySelected: row.manually_selected === 1,
    }));
}

/**
 * Audio Track occurrences inline placement may use.
 *
 * Only Tracks of Editions currently monitored in an *audio* Library qualify —
 * a video cannot sit beside a track the library does not hold. This is the
 * candidate universe, deliberately narrow.
 */
function loadPlacementCandidates(
  db: Database.Database,
  artistMbid: string,
): InlinePlacementCandidate[] {
  const rows = db.prepare(`
    SELECT
      track.id AS track_id,
      edition.id AS edition_id,
      album.id AS release_group_id,
      track.recording_id AS audio_recording_id,
      monitored_edition.library_id AS placement_library_id,
      album.primary_type,
      album.secondary_types,
      edition.track_count AS edition_track_count,
      monitored_edition.representative
    FROM LibraryEditions monitored_edition
    JOIN Libraries library
      ON library.id = monitored_edition.library_id AND library.enabled = 1
    JOIN quality_profiles quality_profile
      ON quality_profile.id = library.quality_profile_id
    JOIN AlbumEditions edition ON edition.id = monitored_edition.edition_id
    JOIN Albums album ON album.id = edition.release_group_id
    JOIN Tracks track ON track.album_edition_id = edition.id
    JOIN Recordings audio ON audio.id = track.recording_id AND audio.is_video = 0
    WHERE album.artist_mbid = ?
      -- Audio libraries only: the Video Library holds no audio tracks to sit
      -- beside, and a spatial library is not where extras belong either.
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(COALESCE(quality_profile.allowed_source_formats, '[]')) allowed
        WHERE allowed.value IN ('video', 'spatial')
      )
    ORDER BY track.id
  `).all(artistMbid) as PlacementRow[];

  return rows.map((row) => ({
    trackId: row.track_id,
    editionId: row.edition_id,
    releaseGroupId: row.release_group_id,
    audioRecordingId: row.audio_recording_id,
    placementLibraryId: row.placement_library_id,
    releaseKind: releaseKind(row.primary_type, row.secondary_types),
    editionTrackCount: Number(row.edition_track_count || 0),
    representative: row.representative === 1,
  }));
}

export interface VideoCurationSummary {
  libraryId: number;
  layout: VideoLayout;
  selected: number;
  inline: number;
  separated: number;
  unselected: number;
}

/**
 * Curate one artist's videos into every enabled Video Library.
 *
 * Automatic rows are replaced wholesale; manual selections are left exactly as
 * the user set them, in the same way `selection_mode = 'manual'` protects an
 * Edition from curation.
 */
export function curateArtistVideos(
  db: Database.Database,
  artistMbid: string,
): VideoCurationSummary[] {
  const mbid = String(artistMbid || "").trim();
  if (!mbid) return [];

  // Settings → Naming → Video Folder Layout, the same value the organizer reads.
  const layout = normalizeVideoFolderLayout(
    getConfigSection("path")?.video_folder_layout,
  ) as VideoLayout;
  const candidates = loadCandidates(db, mbid);
  const placementCandidates = loadPlacementCandidates(db, mbid);
  const summaries: VideoCurationSummary[] = [];

  for (const libraryId of resolveVideoLibraryIds(db)) {
    const decision = curateLibraryVideos({ layout, candidates, placementCandidates });
    db.transaction(() => {
      // Withdraw the automatic selections this pass is about to replace, so a
      // video that lost its slot does not keep an inline placement that would
      // now collide with the new winner.
      const artistVideoIds = candidates.map((candidate) => candidate.videoRecordingId);
      if (artistVideoIds.length > 0) {
        db.prepare(`
          DELETE FROM LibraryVideos
          WHERE library_id = ?
            AND selection_mode = 'auto'
            AND video_recording_id IN (${artistVideoIds.map(() => "?").join(",")})
        `).run(libraryId, ...artistVideoIds);
      }
      for (const selected of decision.selected) {
        const manual = candidates.find((candidate) =>
          candidate.videoRecordingId === selected.videoRecordingId)?.manuallySelected;
        selectLibraryVideo(db, {
          libraryId,
          videoRecordingId: selected.videoRecordingId,
          placement: selected.placement,
          selectionMode: manual ? "manual" : "auto",
          reason: selected.reason,
        });
      }
    })();

    summaries.push({
      libraryId,
      layout,
      selected: decision.selected.length,
      inline: decision.selected.filter((entry) => entry.placement.mode === "inline").length,
      separated: decision.selected.filter((entry) => entry.placement.mode === "separated").length,
      unselected: decision.unselected.length,
    });
  }
  if (summaries.length > 0) {
    emitLibraryUpdated({
      reason: "videos-curated",
      libraryIds: summaries.map((summary) => summary.libraryId),
    });
  }
  return summaries;
}
