import { db } from "../../database.js";
import { getMusicBrainzHeaders, scheduleMusicBrainzRequest } from "../mediafiles/fingerprint.js";
import { ProviderMatchRepository } from "../music/provider-match-repository.js";
import { ProviderCatalogRepository } from "../providers/provider-catalog-repository.js";
import { parseProviderResourceIdentity } from "./provider-url-identity.js";

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
    url?: { resource?: string; id?: string };
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

type SyncContext = {
  artistMetadataIds: Map<string, number | null>;
  upsertRecording: { get(...params: unknown[]): unknown };
};

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

/**
 * Structured recording credits for the `Recordings.credits` column —
 * `[{id, name, join_phrase}]`. This is the queryable form readers use (instead
 * of digging artist-credit out of the raw `data` blob), and the shape both the
 * recording-centric curation gather and MB-local's richer credits feed into.
 */
function structuredArtistCredits(recording: MusicBrainzRecording): string | null {
  const credits = (recording["artist-credit"] || [])
    .map((credit) => ({
      id: nullableText(credit.artist?.id) ?? "",
      name: nullableText(credit.name) ?? nullableText(credit.artist?.name) ?? "",
      join_phrase: nullableText((credit as { joinphrase?: string }).joinphrase) ?? "",
    }))
    .filter((credit) => credit.name);
  return credits.length > 0 ? JSON.stringify(credits) : null;
}

function upsertArtistMetadataForRecording(
  recording: MusicBrainzRecording,
  artistMbid: string | null,
  context: SyncContext,
): number | null {
  const normalizedArtistMbid = nullableText(artistMbid);
  if (!normalizedArtistMbid) {
    return null;
  }

  if (context.artistMetadataIds.has(normalizedArtistMbid)) {
    return context.artistMetadataIds.get(normalizedArtistMbid) ?? null;
  }

  const existing = db.prepare(`
    SELECT id
    FROM ArtistMetadata
    WHERE foreign_artist_id = ? OR mbid = ?
    LIMIT 1
  `).get(normalizedArtistMbid, normalizedArtistMbid) as { id?: number | null } | undefined;
  if (existing?.id != null) {
    const id = Number(existing.id);
    context.artistMetadataIds.set(normalizedArtistMbid, id);
    return id;
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
      foreign_artist_id, mbid, name, updated_at
    ) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
  `).run(
    normalizedArtistMbid,
    normalizedArtistMbid,
    artistName,
  );

  const row = db.prepare(`
    SELECT id
    FROM ArtistMetadata
    WHERE foreign_artist_id = ? OR mbid = ?
    LIMIT 1
  `).get(normalizedArtistMbid, normalizedArtistMbid) as { id?: number | null } | undefined;

  const id = row?.id == null ? null : Number(row.id);
  context.artistMetadataIds.set(normalizedArtistMbid, id);
  return id;
}

function createSyncContext(): SyncContext {
  return {
    artistMetadataIds: new Map(),
    upsertRecording: db.prepare(`
      INSERT INTO Recordings (
        foreign_recording_id, mbid, artist_metadata_id, artist_mbid, title,
        artist_credit, credits, length_ms, is_video, isrcs, metadata_status, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'musicbrainz', CURRENT_TIMESTAMP)
      ON CONFLICT(mbid) DO UPDATE SET
        foreign_recording_id = COALESCE(Recordings.foreign_recording_id, excluded.foreign_recording_id),
        artist_metadata_id = COALESCE(Recordings.artist_metadata_id, excluded.artist_metadata_id),
        artist_mbid = COALESCE(Recordings.artist_mbid, excluded.artist_mbid),
        title = COALESCE(NULLIF(excluded.title, ''), Recordings.title),
        artist_credit = COALESCE(Recordings.artist_credit, excluded.artist_credit),
        credits = COALESCE(Recordings.credits, excluded.credits),
        length_ms = COALESCE(excluded.length_ms, Recordings.length_ms),
        is_video = CASE WHEN excluded.is_video = 1 THEN 1 ELSE Recordings.is_video END,
        isrcs = COALESCE(excluded.isrcs, Recordings.isrcs),
        metadata_status = 'musicbrainz',
        updated_at = CURRENT_TIMESTAMP
      RETURNING id
    `),
  };
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
}, context: SyncContext): number | null {
  const recordingMbid = nullableText(recording.id);
  if (!recordingMbid) {
    return null;
  }

  const title = nullableText(recording.title) ?? recordingMbid;
  const artistMbid = nullableText(options.artistMbid);
  const artistMetadataId = upsertArtistMetadataForRecording(recording, artistMbid, context);
  const recordingArtistMbid = artistMetadataId == null ? null : artistMbid;
  const isrcs = Array.isArray(recording.isrcs)
    ? recording.isrcs.map((value) => String(value || "").trim().toUpperCase()).filter(Boolean)
    : [];
  const isrcJson = isrcs.length > 0 ? JSON.stringify(isrcs) : null;

  const row = context.upsertRecording.get(
    recordingMbid,
    recordingMbid,
    artistMetadataId,
    recordingArtistMbid,
    title,
    artistCredit(recording),
    structuredArtistCredits(recording),
    Number(recording.length || 0) > 0 ? Number(recording.length) : null,
    options.isVideo ? 1 : 0,
    isrcJson,
  ) as { id?: number | null } | undefined;

  return row?.id == null ? null : Number(row.id);
}

function upsertMusicVideoRelations(
  video: MusicBrainzRecording,
  sourceRecordingId: number | null,
  context: SyncContext,
): void {
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
    }, context);
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

/**
 * MusicBrainz often stamps the exact YouTube/TIDAL/Apple watch URL on a video
 * recording (`free streaming` / `streaming` url-rels). Provider catalog matching
 * only sees whatever `getArtistVideos` returns and may attach the studio OMV to
 * a different MB recording — leaving these URL-backed performances with zero
 * offers even when YouTube Music is connected. Pin the offer to the recording
 * that owns the URL relation.
 */
function upsertMusicBrainzVideoUrlOffers(
  video: MusicBrainzRecording,
  recordingId: number | null,
  artistMbid: string | null,
): number {
  if (recordingId == null) {
    return 0;
  }

  const title = nullableText(video.title);
  const durationMs = Number(video.length || 0) > 0 ? Math.round(Number(video.length)) : null;
  let created = 0;
  const catalog = new ProviderCatalogRepository(db);
  const matches = new ProviderMatchRepository(db);

  for (const relation of video.relations || []) {
    const relationType = String(relation.type || "").toLowerCase();
    if (relationType !== "free streaming" && relationType !== "streaming") {
      continue;
    }
    const resource = nullableText(relation.url?.resource);
    if (!resource) {
      continue;
    }
    const identity = parseProviderResourceIdentity(resource);
    if (!identity || identity.type !== "video" || !identity.id) {
      continue;
    }

    const providerVideoItemId = catalog.upsertItem({
      provider: identity.provider,
      entityType: "video",
      providerId: identity.id,
      title,
      durationMs,
      availability: "available",
      providerUrl: resource,
    });
    matches.upsertVideoMatch({
      providerVideoItemId,
      recordingId,
      decision: {
        matchState: "accepted",
        decisionSource: "automatic",
        confidence: 0.98,
        method: "musicbrainz-recording-url",
        matcherVersion: 1,
        evidence: {
          recordingMbid: nullableText(video.id),
          artistMbid: nullableText(artistMbid),
          url: resource,
          relationType,
        },
      },
    });
    created += 1;
  }

  return created;
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

  // Prefer the active catalog source when it can serve MB video recordings
  // directly (MB-local reads them straight from Postgres — no public-MB browse,
  // no 1req/s limit). Falls back to the public MB browse below when unavailable.
  try {
    const { catalogProviderRegistry } = await import("../../services/catalog/index.js");
    const active = catalogProviderRegistry.getActive();
    if (typeof active.getArtistVideoRecordings === "function") {
      const recordings = await active.getArtistVideoRecordings(artistMbid);
      let synced = 0;
      db.transaction(() => {
        const context = createSyncContext();
        for (const recording of recordings.filter(isVideoRecording)) {
          const recordingId = upsertRecording(recording, { artistMbid, isVideo: true }, context);
          upsertMusicVideoRelations(recording, recordingId, context);
          upsertMusicBrainzVideoUrlOffers(recording, recordingId, artistMbid);
          synced++;
        }
      })();
      return synced;
    }
  } catch (error) {
    console.warn(`[MusicBrainzVideoService] Active-source video fetch failed for ${artistMbid}; falling back to public MB:`, error);
  }

  let offset = 0;
  let total = Number.POSITIVE_INFINITY;
  let synced = 0;

  while (offset < total) {
    const params = new URLSearchParams({
      artist: artistMbid,
      // url-rels carry YouTube/TIDAL free-streaming links that become ProviderItems
      // — without them MB-only performances stay offer-less after provider matching.
      inc: "artist-credits+isrcs+recording-rels+url-rels",
      fmt: "json",
      limit: String(MUSICBRAINZ_PAGE_SIZE),
      offset: String(offset),
    });
    const page = await fetchMusicBrainzJson<BrowseRecordingsResponse>(`/recording?${params.toString()}`);
    const recordings = page.recordings || [];
    total = Number(page["recording-count"] ?? recordings.length);

    db.transaction(() => {
      const context = createSyncContext();
      for (const recording of recordings.filter(isVideoRecording)) {
        const recordingId = upsertRecording(recording, {
          artistMbid,
          isVideo: true,
        }, context);
        upsertMusicVideoRelations(recording, recordingId, context);
        upsertMusicBrainzVideoUrlOffers(recording, recordingId, artistMbid);
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
