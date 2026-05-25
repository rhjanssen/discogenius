import { db } from "../../database.js";

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
const MUSICBRAINZ_USER_AGENT = "Discogenius/1.2.6 (https://github.com/discogenius/discogenius)";
const MUSICBRAINZ_PAGE_SIZE = 100;

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

async function fetchMusicBrainzJson<T>(path: string): Promise<T> {
  const response = await fetch(`${MUSICBRAINZ_BASE_URL}${path}`, {
    headers: {
      Accept: "application/json",
      "User-Agent": MUSICBRAINZ_USER_AGENT,
    },
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    throw new Error(`MusicBrainz request failed (${response.status} ${response.statusText}): ${path}`);
  }

  return response.json() as Promise<T>;
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
  const artistMetadataId = artistMbid
    ? (db.prepare(`
        SELECT Id
        FROM ArtistMetadata
        WHERE ForeignArtistId = ? OR mbid = ?
        LIMIT 1
      `).get(artistMbid, artistMbid) as { Id?: number | null } | undefined)?.Id ?? null
    : null;

  db.prepare(`
    INSERT OR IGNORE INTO Recordings (
      ForeignRecordingId, mbid, ArtistMetadataId, artist_mbid, title,
      artist_credit, length_ms, IsVideo, MetadataStatus, isrcs, data, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'musicbrainz', ?, ?, CURRENT_TIMESTAMP)
  `).run(
    recordingMbid,
    recordingMbid,
    artistMetadataId,
    artistMbid,
    title,
    artistCredit(recording),
    Number(recording.length || 0) > 0 ? Number(recording.length) : null,
    options.isVideo ? 1 : 0,
    Array.isArray(recording.isrcs) ? JSON.stringify(recording.isrcs) : null,
    JSON.stringify(recording),
  );

  db.prepare(`
    UPDATE Recordings
    SET
      ArtistMetadataId = COALESCE(ArtistMetadataId, ?),
      artist_mbid = COALESCE(artist_mbid, ?),
      title = COALESCE(NULLIF(?, ''), title),
      artist_credit = COALESCE(artist_credit, ?),
      length_ms = COALESCE(?, length_ms),
      IsVideo = CASE WHEN ? = 1 THEN 1 ELSE IsVideo END,
      MetadataStatus = 'musicbrainz',
      isrcs = COALESCE(?, isrcs),
      data = COALESCE(?, data),
      updated_at = CURRENT_TIMESTAMP
    WHERE ForeignRecordingId = ? OR mbid = ?
  `).run(
    artistMetadataId,
    artistMbid,
    title,
    artistCredit(recording),
    Number(recording.length || 0) > 0 ? Number(recording.length) : null,
    options.isVideo ? 1 : 0,
    Array.isArray(recording.isrcs) ? JSON.stringify(recording.isrcs) : null,
    JSON.stringify(recording),
    recordingMbid,
    recordingMbid,
  );

  const row = db.prepare(`
    SELECT Id
    FROM Recordings
    WHERE ForeignRecordingId = ? OR mbid = ?
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
        SourceRecordingId, TargetRecordingId, SourceForeignRecordingId,
        TargetForeignRecordingId, RelationType, ForeignRelationTypeId,
        Source, Confidence, Data, UpdatedAt
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
      AND IsVideo = 1
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
