import { db } from "../../database.js";
import {
  deriveVideoRelationsFromEdition,
  type EditionMember,
} from "./video-edition-membership.js";

/**
 * Persist the `video Recording → exact audio Recording` relations that canonical
 * Edition membership justifies.
 *
 * Runs after canonical metadata refresh, over the Editions that actually carry
 * both video and audio Tracks — which is a small minority of a discography, so
 * the work is proportional to the interesting case rather than the catalogue.
 *
 * MusicBrainz's own `music video` relation is stronger evidence and is written
 * separately with confidence 1; this fills the gap where MB represents the video
 * as a Track of the release but states no relation, which is the common shape
 * for festival and deluxe editions.
 */

const VIDEO_RELATION_SOURCE = "canonical-edition-membership";

interface EditionRow {
  edition_id: number;
  track_id: number;
  recording_id: number;
  is_video: number;
  title: string | null;
  recording_title: string | null;
  length_ms: number | null;
  isrcs: string | null;
  medium_position: number;
  position: number;
  video_variant: string | null;
}

function parseIsrcs(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
  } catch {
    // Older rows stored a bare string; treat it as a single ISRC.
  }
  const trimmed = String(raw).trim();
  return trimmed ? [trimmed] : [];
}

/**
 * Derive and store relations for every Edition of one artist that mixes audio
 * and video Tracks. Returns the number of relations written or refreshed.
 */
export function syncVideoRelationsFromEditionMembership(artistMbid: string): number {
  const mbid = String(artistMbid || "").trim();
  if (!mbid) return 0;

  // Only Editions that carry at least one video Track AND one audio Track can
  // say anything; everything else is skipped before any rows are read.
  const rows = db.prepare(`
    SELECT
      edition.id AS edition_id,
      track.id AS track_id,
      track.recording_id,
      recording.is_video,
      track.title,
      recording.title AS recording_title,
      COALESCE(track.length_ms, recording.length_ms) AS length_ms,
      recording.isrcs,
      track.medium_position,
      track.position,
      recording.video_variant
    FROM AlbumEditions edition
    JOIN Tracks track ON track.album_edition_id = edition.id
    JOIN Recordings recording ON recording.id = track.recording_id
    WHERE edition.artist_mbid = ?
      AND edition.id IN (
        SELECT video_track.album_edition_id
        FROM Tracks video_track
        JOIN Recordings video_recording ON video_recording.id = video_track.recording_id
        WHERE video_recording.is_video = 1
          AND video_track.album_edition_id IS NOT NULL
      )
    ORDER BY edition.id, track.medium_position, track.position
  `).all(mbid) as EditionRow[];
  if (rows.length === 0) return 0;

  const byEdition = new Map<number, EditionMember[]>();
  for (const row of rows) {
    const members = byEdition.get(row.edition_id) || [];
    members.push({
      trackId: row.track_id,
      recordingId: row.recording_id,
      isVideo: row.is_video === 1,
      title: String(row.title || row.recording_title || ""),
      lengthMs: row.length_ms == null ? null : Number(row.length_ms),
      isrcs: parseIsrcs(row.isrcs),
      mediumPosition: Number(row.medium_position || 1),
      position: Number(row.position || 0),
      videoVariant: row.video_variant,
    });
    byEdition.set(row.edition_id, members);
  }

  const upsert = db.prepare(`
    INSERT INTO RecordingRelations (
      source_recording_id, target_recording_id, source_foreign_recording_id,
      target_foreign_recording_id, relation_type, source, confidence, data, updated_at
    )
    SELECT
      @videoRecordingId, @audioRecordingId,
      (SELECT mbid FROM Recordings WHERE id = @videoRecordingId),
      (SELECT mbid FROM Recordings WHERE id = @audioRecordingId),
      'provider_video_for', @source, @confidence, @data, CURRENT_TIMESTAMP
    ON CONFLICT(source_recording_id, target_recording_id, relation_type) DO UPDATE SET
      -- Never downgrade a stronger or manually accepted relation.
      confidence = MAX(RecordingRelations.confidence, excluded.confidence),
      data = CASE WHEN excluded.confidence >= RecordingRelations.confidence
        THEN excluded.data ELSE RecordingRelations.data END,
      updated_at = CURRENT_TIMESTAMP
  `);

  let written = 0;
  db.transaction(() => {
    for (const [editionId, members] of [...byEdition.entries()].sort((a, b) => a[0] - b[0])) {
      for (const relation of deriveVideoRelationsFromEdition(members)) {
        upsert.run({
          videoRecordingId: relation.videoRecordingId,
          audioRecordingId: relation.audioRecordingId,
          source: VIDEO_RELATION_SOURCE,
          confidence: relation.confidence,
          data: JSON.stringify({
            method: relation.method,
            editionId,
            evidence: relation.evidence,
          }),
        });
        written += 1;
      }
    }
  })();
  return written;
}
