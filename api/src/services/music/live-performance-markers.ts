/**
 * Shared live / performance title markers for video↔audio matching.
 *
 * One vocabulary for TS gates and SQL call sites (Appears On, inline placement,
 * artist-wide matching). Prefer generic tokens over TV/venue show names —
 * do not grow Bastille-shaped deny lists here.
 *
 * Live gate vs duration: duration windows still apply for title/ISRC scoring;
 * a live↔studio mismatch is rejected even when durations are close.
 */

/** Generic tokens — word-bounded in TS; GLOB word-ish in SQL. */
export const LIVE_PERFORMANCE_MARKER_TOKENS = [
  "live",
  "performance",
  "unplugged",
] as const;

/** Covers `live`, `performance`, `unplugged` (incl. MTV Unplugged). */
const LIVE_PERFORMANCE_TITLE_RE = /\blive\b|\bperformance\b|\bunplugged\b/i;

/** True when a title carries a generic live/performance marker. */
export function isLivePerformanceTitle(title: string | null | undefined): boolean {
  return LIVE_PERFORMANCE_TITLE_RE.test(String(title || ""));
}

/** MusicBrainz release-group Live secondary (JSON array text). */
export function albumSecondaryIsLive(secondaryTypes: string | null | undefined): boolean {
  return String(secondaryTypes || "").toLowerCase().includes('"live"');
}

/**
 * Audio side is “live” when the track/recording title, album/RG title, or
 * Live secondary says so.
 */
export function isLivePerformanceAudio(input: {
  trackTitle?: string | null;
  albumTitle?: string | null;
  albumSecondaryTypes?: string | null;
}): boolean {
  return isLivePerformanceTitle(input.trackTitle)
    || isLivePerformanceTitle(input.albumTitle)
    || albumSecondaryIsLive(input.albumSecondaryTypes);
}

/**
 * SQLite predicate: `columnExpr` text contains a live-marker token with
 * word-ish boundaries (avoids `olive` / `alive` false positives from `%live%`).
 */
export function livePerformanceTitleSql(columnExpr: string): string {
  const col = `LOWER(COALESCE(${columnExpr}, ''))`;
  const parts: string[] = [];
  for (const token of LIVE_PERFORMANCE_MARKER_TOKENS) {
    parts.push(
      `${col} = '${token}'`,
      `${col} GLOB '${token}[^a-z0-9]*'`,
      `${col} GLOB '*[^a-z0-9]${token}'`,
      `${col} GLOB '*[^a-z0-9]${token}[^a-z0-9]*'`,
    );
  }
  return `(${parts.join(" OR ")})`;
}

/**
 * SQLite predicate: track and/or album side is live-marked.
 * Pass album columns when the join has them (placement / Appears On rows).
 */
export function livePerformanceAudioSql(input: {
  trackTitleExpr: string;
  albumTitleExpr?: string;
  albumSecondaryExpr?: string;
}): string {
  const parts = [livePerformanceTitleSql(input.trackTitleExpr)];
  if (input.albumTitleExpr) {
    parts.push(livePerformanceTitleSql(input.albumTitleExpr));
  }
  if (input.albumSecondaryExpr) {
    parts.push(`LOWER(COALESCE(${input.albumSecondaryExpr}, '')) LIKE '%"live"%'`);
  }
  return `(${parts.join(" OR ")})`;
}

/**
 * Recording appears on a live-marked album and on no non-live album.
 * Covers TV/session cuts that omit the word "live" but live only on BBC-style sets.
 */
export function liveAlbumOnlyRecordingSql(
  recordingIdExpr: string,
  recordingMbidExpr: string,
): string {
  const onRecording = `(
    _t.recording_id = ${recordingIdExpr}
    OR (${recordingMbidExpr} IS NOT NULL AND _t.recording_mbid = ${recordingMbidExpr})
  )`;
  const liveAlbum = `(
    LOWER(COALESCE(_a.secondary_types, '')) LIKE '%"live"%'
    OR ${livePerformanceTitleSql("_a.title")}
  )`;
  const nonLiveAlbum = `(
    _a.secondary_types IS NULL
    OR TRIM(_a.secondary_types) = ''
    OR _a.secondary_types = '[]'
    OR LOWER(_a.secondary_types) NOT LIKE '%"live"%'
  )`;
  return `(
    EXISTS (
      SELECT 1
      FROM Tracks _t
      JOIN AlbumEditions _ar
        ON _ar.id = _t.album_edition_id
        OR (_t.edition_mbid IS NOT NULL AND _ar.mbid = _t.edition_mbid)
      JOIN Albums _a ON _a.mbid = _ar.release_group_mbid
      WHERE ${onRecording}
        AND ${liveAlbum}
    )
    AND NOT EXISTS (
      SELECT 1
      FROM Tracks _t
      JOIN AlbumEditions _ar
        ON _ar.id = _t.album_edition_id
        OR (_t.edition_mbid IS NOT NULL AND _ar.mbid = _t.edition_mbid)
      JOIN Albums _a ON _a.mbid = _ar.release_group_mbid
      WHERE ${onRecording}
        AND ${nonLiveAlbum}
    )
  )`;
}

/**
 * Relation-level audio is live: track title marker, or live-album-only membership.
 */
export function relatedAudioIsLiveSql(input: {
  trackTitleExpr: string;
  recordingIdExpr: string;
  recordingMbidExpr: string;
}): string {
  return `(
    ${livePerformanceTitleSql(input.trackTitleExpr)}
    OR ${liveAlbumOnlyRecordingSql(input.recordingIdExpr, input.recordingMbidExpr)}
  )`;
}

/**
 * Main/official OMVs must not follow live-marked audio for Appears On / inline.
 * Lyric/live variants may still follow those links.
 *
 * Prefer album-column form when the join has album rows; otherwise use
 * recording-level live-album-only detection.
 */
export function mainVideoMayFollowAudioRelationSql(input: {
  videoVariantExpr: string;
  trackTitleExpr: string;
  albumTitleExpr?: string;
  albumSecondaryExpr?: string;
  recordingIdExpr?: string;
  recordingMbidExpr?: string;
}): string {
  const audioIsLive = input.albumTitleExpr || input.albumSecondaryExpr
    ? livePerformanceAudioSql({
      trackTitleExpr: input.trackTitleExpr,
      albumTitleExpr: input.albumTitleExpr,
      albumSecondaryExpr: input.albumSecondaryExpr,
    })
    : relatedAudioIsLiveSql({
      trackTitleExpr: input.trackTitleExpr,
      recordingIdExpr: input.recordingIdExpr ?? "audio.id",
      recordingMbidExpr: input.recordingMbidExpr ?? "audio.mbid",
    });
  return `(
    COALESCE(NULLIF(TRIM(${input.videoVariantExpr}), ''), 'video') NOT IN ('video', 'official')
    OR NOT ${audioIsLive}
  )`;
}
