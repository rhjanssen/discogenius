/**
 * Loading the evidence {@link resolveCoverageUnits} reasons over, for an
 * explicit set of Recordings and nothing else.
 *
 * The predecessor rebuilt the equivalence graph for the entire library — on the
 * measured library, 103,362 Recordings and ~2.8s — on every album page load,
 * every availability call and every curation pass, to answer a question about
 * one Album. Scope is therefore part of the contract here, not an optimisation:
 * a caller states which Recordings the question is about, and adding unrelated
 * Recordings to the database cannot change either the answer or the cost.
 */
import type Database from "better-sqlite3";
import {
  resolveCoverageUnits,
  type CoverageRecording,
  type CoverageUnitResolution,
  type ProviderTrackLink,
} from "./coverage-identity.js";
import { parseRecordingIsrcs } from "./recording-coverage-units.js";

interface RecordingRow {
  id: number;
  title: string | null;
  length_ms: number | null;
  isrcs: string | null;
}

interface ProviderIsrcRow {
  recording_id: number;
  isrc: string | null;
}

interface ProviderLinkRow {
  provider: string;
  provider_track_item_id: number;
  recording_id: number;
}

/** SQLite caps bound parameters; chunk so a large scope still runs as one pass. */
const CHUNK = 900;

function chunked<T>(values: readonly T[], size = CHUNK): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

/**
 * Resolve coverage units for exactly `recordingIds`.
 *
 * Provider ISRCs are folded in as catalogue evidence (they are facts about the
 * recording, not a matching decision). Provider *track links* are passed
 * through only so the resolver can quarantine and report the ones whose
 * accepted matches disagree — they never create equivalence.
 */
export function loadCoverageUnitsForRecordings(
  db: Database.Database,
  recordingIds: Iterable<number>,
): CoverageUnitResolution {
  const ids = [...new Set(
    [...recordingIds].map(Number).filter((id) => Number.isFinite(id) && id > 0),
  )].sort((a, b) => a - b);

  if (ids.length === 0) {
    return { unitByRecording: new Map(), rejections: [], quarantinedProviderLinks: [] };
  }

  const recordingRows: RecordingRow[] = [];
  const providerIsrcRows: ProviderIsrcRow[] = [];
  const providerLinkRows: ProviderLinkRow[] = [];

  for (const chunk of chunked(ids)) {
    const placeholders = chunk.map(() => "?").join(",");

    recordingRows.push(...db.prepare(`
      SELECT id, title, length_ms, isrcs
      FROM Recordings
      WHERE id IN (${placeholders})
    `).all(...chunk) as RecordingRow[]);

    providerIsrcRows.push(...db.prepare(`
      SELECT track_match.recording_id, provider_item.isrc
      FROM ProviderTrackMatches track_match
      JOIN ProviderItems provider_item
        ON provider_item.id = track_match.provider_track_item_id
      WHERE track_match.match_state = 'accepted'
        AND track_match.recording_id IN (${placeholders})
        AND provider_item.isrc IS NOT NULL
        AND TRIM(provider_item.isrc) != ''
    `).all(...chunk) as ProviderIsrcRow[]);

    // Only links that touch the scope; a link's members outside the scope are
    // irrelevant to this question and are filtered by the resolver anyway.
    providerLinkRows.push(...db.prepare(`
      SELECT
        provider_item.provider,
        track_match.provider_track_item_id,
        track_match.recording_id
      FROM ProviderTrackMatches track_match
      JOIN ProviderItems provider_item
        ON provider_item.id = track_match.provider_track_item_id
      WHERE track_match.match_state = 'accepted'
        AND track_match.recording_id IS NOT NULL
        AND track_match.provider_track_item_id IN (
          SELECT provider_track_item_id
          FROM ProviderTrackMatches
          WHERE match_state = 'accepted'
            AND recording_id IN (${placeholders})
        )
    `).all(...chunk) as ProviderLinkRow[]);
  }

  const isrcsByRecording = new Map<number, Set<string>>();
  const addIsrc = (recordingId: number, raw: string | null | undefined) => {
    for (const isrc of parseRecordingIsrcs(raw)) {
      const set = isrcsByRecording.get(recordingId) ?? new Set<string>();
      set.add(isrc);
      isrcsByRecording.set(recordingId, set);
    }
  };
  for (const row of recordingRows) addIsrc(row.id, row.isrcs);
  for (const row of providerIsrcRows) addIsrc(row.recording_id, row.isrc);

  const recordings: CoverageRecording[] = recordingRows.map((row) => ({
    recordingId: row.id,
    title: row.title ?? "",
    lengthMs: row.length_ms,
    isrcs: [...(isrcsByRecording.get(row.id) ?? [])],
  }));

  const linksByItem = new Map<number, { provider: string; recordingIds: Set<number> }>();
  for (const row of providerLinkRows) {
    const entry = linksByItem.get(row.provider_track_item_id)
      ?? { provider: row.provider, recordingIds: new Set<number>() };
    entry.recordingIds.add(row.recording_id);
    linksByItem.set(row.provider_track_item_id, entry);
  }
  const providerLinks: ProviderTrackLink[] = [...linksByItem.entries()]
    .filter(([, entry]) => entry.recordingIds.size >= 2)
    .map(([providerTrackItemId, entry]) => ({
      provider: entry.provider,
      providerTrackItemId,
      recordingIds: [...entry.recordingIds],
    }));

  return resolveCoverageUnits(recordings, providerLinks);
}
