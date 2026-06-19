import { db } from "../../database.js";
import { getMusicBrainzHeaders, scheduleMusicBrainzRequest } from "../mediafiles/fingerprint.js";

type MusicBrainzRecording = {
  id?: string;
  title?: string;
  length?: number | null;
  video?: boolean | string | null;
  isrcs?: string[] | null;
  "artist-credit"?: Array<{ name?: string; artist?: { id?: string; name?: string } }>;
  relations?: Array<{
    type?: string;
    "type-id"?: string;
    direction?: string;
    recording?: MusicBrainzRecording;
  }>;
};

type BrowseRecordingsResponse = {
  "recording-count"?: number;
  "recording-offset"?: number;
  recordings?: MusicBrainzRecording[];
};

const MUSICBRAINZ_BASE_URL = "https://musicbrainz.org/ws/2";
const MUSICBRAINZ_PAGE_SIZE = 100;
const MUSICBRAINZ_FETCH_ATTEMPTS = 2;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function nullableText(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : null;
}

function isVideoRecording(recording: MusicBrainzRecording): boolean {
  return recording.video === true || String(recording.video || "").toLowerCase() === "true";
}

function artistCredit(recording: MusicBrainzRecording): string | null {
  const names = (recording["artist-credit"] || [])
    .map((credit) => nullableText(credit.name) ?? nullableText(credit.artist?.name))
    .filter((name): name is string => Boolean(name));
  return names.length > 0 ? names.join(", ") : null;
}

function upsertArtistMetadataForRecording(recording: MusicBrainzRecording, artistMbid: string | null): number | null {
  const normalizedArtistMbid = nullableText(artistMbid);
  if (!normalizedArtistMbid) {
    return null;
  }

  const existing = db.prepare(`
    SELECT id
    FROM ArtistMetadata
    WHERE foreign_artist_id = ? OR mbid = ?
    LIMIT 1
  `).get(normalizedArtistMbid, normalizedArtistMbid) as { Id?: number | null } | undefined;
  if (existing?.Id != null) {
    return Number(existing.Id);
  }

  const matchingCredit = (recording["artist-credit"] || [])
    .find((credit) => nullableText(credit.artist?.id) === normalizedArtistMbid);
  const fallbackCredit = recording["artist-credit"]?.[0];
  const artistName =
    nullableText(matchingCredit?.artist?.name) ??
    nullableText(matchingCredit?.name) ??
    nullableText(fallbackCredit?.artist?.name) ??
    nullableText(fallbackCredit?.name) ??
    normalizedArtistMbid;

  db.prepare(`
    INSERT OR IGNORE INTO ArtistMetadata (
      foreign_artist_id, mbid, name, data, updated_at
    ) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(
    normalizedArtistMbid,
    normalizedArtistMbid,
    artistName,
    JSON.stringify(matchingCredit?.artist || fallbackCredit?.artist || { id: normalizedArtistMbid, name: artistName }),
  );

  const row = db.prepare(`
    SELECT id
    FROM ArtistMetadata
    WHERE foreign_artist_id = ? OR mbid = ?
    LIMIT 1
  `).get(normalizedArtistMbid, normalizedArtistMbid) as { Id?: number | null } | undefined;

  return row?.Id == null ? null : Number(row.Id);
}

async function fetchMusicBrainzJson<T>(path: string): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MUSICBRAINZ_FETCH_ATTEMPTS; attempt += 1) {
    try {
      const response = await scheduleMusicBrainzRequest(() =>
        fetch(`${MUSICBRAINZ_BASE_URL}${path}`, {
          headers: {
            Accept: "application/json",
            ...getMusicBrainzHeaders(),
          },
          signal: AbortSignal.timeout(20_000),
        }),
      );

      if (!response.ok) {
        throw new Error(`MusicBrainz request failed (${response.status} ${response.statusText}): ${path}`);
      }

      return response.json() as Promise<T>;
    } catch (error) {
      lastError = error;
      if (attempt >= MUSICBRAINZ_FETCH_ATTEMPTS) {
        break;
      }
      await sleep(1000 * attempt);
    }
  }

  throw lastError;
}

function upsertRecording(recording: MusicBrainzRecording, options: {
  artistMbid?: string | null;
  isVideo: boolean;
}): number | null {
  const recordingMbid = nullableText(recording.id);
  if (!recordingMbid) {
    return null;
  }

  const title = nullableText(recording.title) ?? recordingMbid;
  const artistMbid = nullableText(options.artistMbid);
  const artistMetadataId = upsertArtistMetadataForRecording(recording, artistMbid);
  const recordingArtistMbid = artistMetadataId == null ? null : artistMbid;

  db.prepare(`
    INSERT OR IGNORE INTO Recordings (
      foreign_recording_id, mbid, artist_metadata_id, artist_mbid, title,
      artist_credit, length_ms, is_video, metadata_status, data, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'musicbrainz', ?, CURRENT_TIMESTAMP)
  `).run(
    recordingMbid,
    recordingMbid,
    artistMetadataId,
    recordingArtistMbid,
    title,
    artistCredit(recording),
    Number(recording.length || 0) > 0 ? Number(recording.length) : null,
    options.isVideo ? 1 : 0,
    JSON.stringify(recording),
  );

  db.prepare(`
    UPDATE Recordings
    SET
      artist_metadata_id = COALESCE(artist_metadata_id, ?),
      artist_mbid = COALESCE(artist_mbid, ?),
      title = COALESCE(NULLIF(?, ''), title),
      artist_credit = COALESCE(artist_credit, ?),
      length_ms = COALESCE(?, length_ms),
      is_video = CASE WHEN ? = 1 THEN 1 ELSE is_video END,
      metadata_status = 'musicbrainz',
      data = COALESCE(?, data),
      updated_at = CURRENT_TIMESTAMP
    WHERE foreign_recording_id = ? OR mbid = ?
  `).run(
    artistMetadataId,
    recordingArtistMbid,
    title,
    artistCredit(recording),
    Number(recording.length || 0) > 0 ? Number(recording.length) : null,
    options.isVideo ? 1 : 0,
    JSON.stringify(recording),
    recordingMbid,
    recordingMbid,
  );

  const row = db.prepare(`
    SELECT id
    FROM Recordings
    WHERE foreign_recording_id = ? OR mbid = ?
    LIMIT 1
  `).get(recordingMbid, recordingMbid) as { Id?: number | null } | undefined;

  return row?.Id == null ? null : Number(row.Id);
}

function upsertMusicVideoRelations(video: MusicBrainzRecording, sourceRecordingId: number | null): void {
  const videoMbid = nullableText(video.id);
  if (!videoMbid) {
    return;
  }

  for (const relation of video.relations || []) {
    if (String(relation.type || "").toLowerCase() !== "music video" || !relation.recording?.id) {
      continue;
    }

    const targetRecording = relation.recording;
    const targetRecordingId = upsertRecording(targetRecording, {
      isVideo: isVideoRecording(targetRecording),
      artistMbid: targetRecording["artist-credit"]?.[0]?.artist?.id ?? null,
    });
    const targetMbid = nullableText(targetRecording.id);
    if (!targetMbid) {
      continue;
    }

    db.prepare(`
      INSERT OR IGNORE INTO RecordingRelations (
        source_recording_id, target_recording_id, source_foreign_recording_id,
        target_foreign_recording_id, relation_type, foreign_relation_type_id, source, confidence, Data, updated_at
      ) VALUES (?, ?, ?, ?, 'music_video_for', ?, 'musicbrainz', 1, ?, CURRENT_TIMESTAMP)
    `).run(
      sourceRecordingId,
      targetRecordingId,
      videoMbid,
      targetMbid,
      nullableText(relation["type-id"]),
      JSON.stringify(relation),
    );
  }
}

export async function syncMusicBrainzVideosForArtist(
  artistMbid: string,
  options: { force?: boolean } = {},
): Promise<number> {
  const existing = db.prepare(`
    SELECT COUNT(*) AS count
    FROM Recordings
    WHERE artist_mbid = ?
      AND is_video = 1
  `).get(artistMbid) as { count?: number } | undefined;

  if (!options.force && Number(existing?.count || 0) > 0) {
    return 0;
  }

  let offset = 0;
  let total = Number.POSITIVE_INFINITY;
  let synced = 0;

  while (offset < total) {
    const params = new URLSearchParams({
      artist: artistMbid,
      inc: "artist-credits+isrcs+recording-rels",
      fmt: "json",
      limit: String(MUSICBRAINZ_PAGE_SIZE),
      offset: String(offset),
    });
    const page = await fetchMusicBrainzJson<BrowseRecordingsResponse>(`/recording?${params.toString()}`);
    const recordings = page.recordings || [];
    total = Number(page["recording-count"] ?? recordings.length);

    db.transaction(() => {
      for (const recording of recordings.filter(isVideoRecording)) {
        const recordingId = upsertRecording(recording, {
          artistMbid,
          isVideo: true,
        });
        upsertMusicVideoRelations(recording, recordingId);
        synced++;
      }
    })();

    offset += MUSICBRAINZ_PAGE_SIZE;
    if (recordings.length === 0) {
      break;
    }
  }

  return synced;
}
