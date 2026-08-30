/**
 * YouTube music-video catalog ingest. Public ytmusicapi listing, not the
 * YouTube Music download plugin. RefreshArtist writes Recordings.youtube_video_id
 * even when that plugin is disabled or has no cookies. Downloads still need
 * browser headers/cookies.
 */

import { db } from "../../database.js";
import {
  getYouTubeMusicCapabilitySnapshot,
  parseYouTubeMusicUrl,
  type YouTubeMusicCapabilitySnapshot,
} from "../providers/youtube-music/youtube-music-provider.js";
import type { ProviderArtist, StreamingProvider } from "../providers/streaming-provider.js";
import { streamingProviderManager } from "../providers/index.js";
import { classifyRecordingVersion } from "./coverage-identity.js";
import { getLinkedProviderArtistId, storeProviderArtistMatch } from "./refresh-artist-match.js";
import { normalizeMatchText, providerVideoToOfferRow } from "./refresh-artist-support.js";
import { RefreshVideoService } from "./refresh-video-service.js";
import { parseVideoVariant } from "./video-variant.js";

export type YouTubeVideoCatalogProvider = Pick<StreamingProvider, "id" | "name" | "search" | "getVideo"> & {
  getArtistVideos: NonNullable<StreamingProvider["getArtistVideos"]>;
};

export type YouTubeVideoCatalogDeps = {
  getProvider?: () => YouTubeVideoCatalogProvider;
  probeCapabilities?: () => Promise<Pick<
    YouTubeMusicCapabilitySnapshot,
    "pythonAvailable" | "ytmusicapiAvailable" | "bridgeScriptAvailable"
  >>;
};

const SPARSE_VIDEO_RESOLUTION_BATCH_SIZE = 40;
const sparseResolutionPassByArtist = new Map<string, number>();

type SparseVideoCatalogDeps = Pick<YouTubeVideoCatalogDeps, "getProvider"> & {
  /** Deterministic test seam; production rotates the batch between invocations. */
  resolutionBatchIndex?: number;
};

function catalogProvider(deps: YouTubeVideoCatalogDeps): YouTubeVideoCatalogProvider {
  if (deps.getProvider) return deps.getProvider();
  const provider = streamingProviderManager.getStreamingProvider("youtube-music");
  if (!provider.getArtistVideos) {
    throw new Error("YouTube Music adapter has no getArtistVideos");
  }
  return provider as YouTubeVideoCatalogProvider;
}

function dateOnly(value: string | null | undefined): string | null {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

function dayDistance(left: string | null | undefined, right: string | null | undefined): number {
  const a = dateOnly(left);
  const b = dateOnly(right);
  if (!a || !b) return Number.POSITIVE_INFINITY;
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}

function baseVideoTitle(value: string | null | undefined): string {
  return classifyRecordingVersion(String(value || "")).baseTitle;
}

function youtubeVideoMatchesArtist(
  video: any,
  artistName: string,
  expectedChannelId: string | null,
): boolean {
  const artists = [video?.artist, ...(Array.isArray(video?.artists) ? video.artists : [])]
    .filter(Boolean);
  if (expectedChannelId && artists.some((artist) =>
    String(artist?.providerId || "").trim() === expectedChannelId)) {
    return true;
  }

  const expected = normalizeMatchText(artistName);
  if (!expected) return false;
  return artists.some((artist) => {
    const actual = normalizeMatchText(String(artist?.name || ""));
    if (!actual) return false;
    if (actual === expected) return true;
    // Collaboration credits such as "Marshmello & Bastille" are valid, but
    // unrelated uploaders and cover channels must not mint canonical identity.
    return (` ${actual} `).includes(` ${expected} `);
  });
}

function sparseSourcesAgree(
  left: { title: string; duration_ms: number; release_date: string | null },
  right: { title: string; duration_ms: number; release_date: string | null },
): boolean {
  if (baseVideoTitle(left.title) !== baseVideoTitle(right.title)) return false;
  if (Math.abs(Number(left.duration_ms) - Number(right.duration_ms)) > 2_000) return false;
  const distance = dayDistance(left.release_date, right.release_date);
  return !Number.isFinite(distance) || distance <= 7;
}

/**
 * Some provider catalogs publish only a bare title, duration, date, and image.
 * Resolve those rows through the public YouTube catalog only when one candidate
 * wins on the same base title, a two-second duration gate, and a nearby publish
 * date. The result is a catalog identity, not a provider guess, so it may supply
 * the missing Live, Lyric, Official Audio, or Visualiser qualifier.
 */
export async function supplementSparseProviderVideosFromYouTube(
  artistId: string,
  artistMbid: string | null,
  deps: SparseVideoCatalogDeps = {},
): Promise<number> {
  if (!artistMbid) return 0;
  let provider: YouTubeVideoCatalogProvider;
  try {
    provider = catalogProvider(deps as YouTubeVideoCatalogDeps);
  } catch {
    return 0;
  }
  if (!provider.getVideo) return 0;
  const getVideo = provider.getVideo.bind(provider);

  const artist = db.prepare(`SELECT name FROM ArtistMetadata WHERE mbid = ? LIMIT 1`)
    .get(artistMbid) as { name?: string | null } | undefined;
  const artistName = String(artist?.name || "").trim();
  if (!artistName) return 0;

  const storedRows = db.prepare(`
    SELECT
      recording.id AS recording_id,
      item.provider,
      item.title,
      item.duration_ms,
      item.release_date
    FROM Recordings recording
    JOIN ProviderVideoMatches video_match
      ON video_match.recording_id = recording.id
     AND video_match.match_state = 'accepted'
    JOIN ProviderItems item
      ON item.id = video_match.provider_video_item_id
     AND item.entity_type = 'video'
    WHERE recording.artist_mbid = ?
      AND recording.is_video = 1
      AND recording.mbid IS NULL
      AND recording.youtube_video_id IS NULL
      AND item.provider != 'youtube-music'
      AND item.duration_ms IS NOT NULL
    ORDER BY recording.id DESC, item.updated_at DESC, item.id DESC
  `).all(artistMbid) as Array<{
    recording_id: number;
    provider: string;
    title: string;
    duration_ms: number;
    release_date: string | null;
  }>;

  const rowsByRecording = new Map<number, typeof storedRows>();
  for (const row of storedRows) {
    if (parseVideoVariant(row.title) !== "video") continue;
    const rows = rowsByRecording.get(row.recording_id) ?? [];
    rows.push(row);
    rowsByRecording.set(row.recording_id, rows);
  }
  const sources = Array.from(rowsByRecording.values())
    .filter((rows) => rows.every((row) => sparseSourcesAgree(rows[0], row)))
    // SQL already orders newest offer first; retain it rather than allowing the
    // last (oldest) row in a Map constructor to overwrite it.
    .map((rows) => rows[0]);
  if (sources.length === 0) return 0;

  const expectedChannelId = cachedYouTubeArtistId(artistMbid)
    || youtubeChannelFromArtistLinks(artistMbid);

  const contextualReleases = db.prepare(`
    SELECT item.title, item.version, item.release_date
    FROM ProviderItems item
    JOIN ProviderEditionMatches edition_match
      ON edition_match.provider_edition_item_id = item.id
     AND edition_match.match_state = 'accepted'
    JOIN AlbumEditions edition ON edition.id = edition_match.edition_id
    WHERE item.provider = ?
      AND item.entity_type = 'release'
      AND edition.artist_mbid = ?
  `);

  const resolveSource = async (source: typeof sources[number]): Promise<{
    recordingId: number;
    video: any;
  } | null> => {
    const sourceBase = baseVideoTitle(source.title);
    if (!sourceBase) return null;
    const releaseContexts = (contextualReleases.all(source.provider, artistMbid) as Array<{
      title: string;
      version: string | null;
      release_date: string | null;
    }>).filter((release) =>
      dateOnly(release.release_date) === dateOnly(source.release_date)
      && baseVideoTitle(release.title) === sourceBase);
    const contextualTitle = releaseContexts.length === 1
      ? String(releaseContexts[0].title || source.title)
      : source.title;
    const query = `${artistName} ${contextualTitle}`.trim();

    let candidates: any[] = [];
    try {
      const result = await provider.search(query, { types: ["videos"], limit: 12 });
      candidates = (result.videos || []).filter((candidate) =>
        baseVideoTitle(candidate.title) === sourceBase
        && candidate.duration != null
        && Math.abs(Number(candidate.duration) * 1000 - Number(source.duration_ms)) <= 2_000
        && youtubeVideoMatchesArtist(candidate, artistName, expectedChannelId));
    } catch {
      return null;
    }
    if (candidates.length === 0) return null;

    const detailed: any[] = [];
    for (const candidate of candidates.slice(0, 6)) {
      try {
        const video = await getVideo(String(candidate.providerId));
        if (
          baseVideoTitle(video.title) === sourceBase
          && video.duration != null
          && Math.abs(Number(video.duration) * 1000 - Number(source.duration_ms)) <= 2_000
          && youtubeVideoMatchesArtist(video, artistName, expectedChannelId)
        ) detailed.push(video);
      } catch {
        // One failed candidate must not discard another provider result.
      }
    }
    if (detailed.length === 0) return null;

    const nearby = detailed
      .map((video) => ({ video, distance: dayDistance(source.release_date, video.releaseDate) }))
      .filter((entry) => entry.distance <= 7)
      .sort((left, right) => left.distance - right.distance);
    const bestDistance = nearby[0]?.distance;
    const winners = bestDistance == null
      ? (detailed.length === 1 ? detailed : [])
      : nearby.filter((entry) => entry.distance === bestDistance).map((entry) => entry.video);
    if (winners.length !== 1) return null;
    return { recordingId: source.recording_id, video: winners[0] };
  };

  // Bound provider traffic per refresh, but rotate through stable chunks so a
  // popular artist's older unresolved rows still make progress. Newest rows are
  // first; repeated invocations advance the in-process cursor, and the UTC-day
  // seed changes the starting chunk after a restart.
  const batchCount = Math.ceil(sources.length / SPARSE_VIDEO_RESOLUTION_BATCH_SIZE);
  const daySeed = Math.floor(Date.now() / 86_400_000) % batchCount;
  const batchIndex = deps.resolutionBatchIndex == null
    ? (sparseResolutionPassByArtist.get(artistMbid) ?? daySeed) % batchCount
    : Math.max(0, Math.floor(deps.resolutionBatchIndex)) % batchCount;
  if (deps.resolutionBatchIndex == null) {
    sparseResolutionPassByArtist.set(artistMbid, (batchIndex + 1) % batchCount);
  }
  const batchStart = batchIndex * SPARSE_VIDEO_RESOLUTION_BATCH_SIZE;
  const batchSources = sources.slice(batchStart, batchStart + SPARSE_VIDEO_RESOLUTION_BATCH_SIZE);
  const resolved: Array<{ recordingId: number; video: any }> = [];
  let nextSource = 0;
  const workers = Array.from({ length: Math.min(4, batchSources.length) }, async () => {
    while (nextSource < batchSources.length) {
      const source = batchSources[nextSource];
      nextSource += 1;
      const match = await resolveSource(source);
      if (match) resolved.push(match);
    }
  });
  await Promise.all(workers);

  const claimsByYoutubeId = new Map<string, Array<{ recordingId: number; video: any }>>();
  for (const match of resolved) {
    const youtubeId = String(match.video?.providerId || "").trim();
    if (!youtubeId) continue;
    const claims = claimsByYoutubeId.get(youtubeId) ?? [];
    claims.push(match);
    claimsByYoutubeId.set(youtubeId, claims);
  }
  const uniqueResolved = Array.from(claimsByYoutubeId.values())
    .filter((claims) => claims.length === 1)
    .map((claims) => claims[0])
    .sort((left, right) => left.recordingId - right.recordingId);

  const mergePlan = uniqueResolved.map((match) => ({
    providerOnlyRecordingId: match.recordingId,
    video: {
      ...providerVideoToOfferRow(match.video, artistId),
      provider: "youtube-music",
      _provider: "youtube-music",
      artist_mbid: artistMbid,
    },
  }));
  return RefreshVideoService.upsertVerifiedCatalogVideoTwins(artistId, mergePlan);
}

function cachedYouTubeArtistId(artistMbid: string): string | null {
  const row = db.prepare(`
    SELECT CAST(item.provider_id AS TEXT) AS provider_id
    FROM ProviderItems item
    JOIN ProviderArtistMatches artist_match
      ON artist_match.provider_artist_item_id = item.id
     AND artist_match.match_state = 'accepted'
    JOIN ArtistMetadata canonical_artist
      ON canonical_artist.id = artist_match.artist_id
    WHERE item.provider = 'youtube-music'
      AND item.entity_type = 'artist'
      AND canonical_artist.mbid = ?
    ORDER BY
      CASE artist_match.decision_source WHEN 'manual' THEN 0 ELSE 1 END,
      artist_match.confidence DESC,
      item.updated_at DESC
    LIMIT 1
  `).get(artistMbid) as { provider_id?: string | number | null } | undefined;
  return row?.provider_id == null ? null : String(row.provider_id);
}

function youtubeChannelFromArtistLinks(artistMbid: string): string | null {
  const row = db.prepare("SELECT links FROM ArtistMetadata WHERE mbid = ? LIMIT 1")
    .get(artistMbid) as { links?: string | null } | undefined;
  if (!row?.links) return null;
  try {
    const parsed = JSON.parse(row.links);
    const links = Array.isArray(parsed) ? parsed : [];
    for (const link of links) {
      const target = String(link?.target || link?.url || "").trim();
      if (!target) continue;
      const parsedUrl = parseYouTubeMusicUrl(target);
      if (parsedUrl?.type === "artist") return parsedUrl.providerId;
    }
  } catch {
    return null;
  }
  return null;
}

async function resolveYouTubeCatalogArtistId(
  provider: YouTubeVideoCatalogProvider,
  artistId: string,
  artistMbid: string | null,
): Promise<string | null> {
  if (artistMbid) {
    const cached = cachedYouTubeArtistId(artistMbid);
    if (cached) return cached;
    const fromLinks = youtubeChannelFromArtistLinks(artistMbid);
    if (fromLinks) return fromLinks;
    const linked = getLinkedProviderArtistId(artistMbid, provider.id);
    if (linked) return linked;
  }

  const localArtist = db.prepare("SELECT name FROM ArtistMetadata WHERE id = ? OR mbid = ? LIMIT 1")
    .get(artistId, artistMbid) as { name?: string | null } | undefined;
  const artistName = String(localArtist?.name || "").trim();
  if (!artistName) return null;

  const results = await provider.search(artistName, { types: ["artists"], limit: 8 });
  const artists = Array.isArray(results.artists) ? results.artists : [];
  const normalizedName = normalizeMatchText(artistName);
  const selected = artists.find((artist) => normalizeMatchText(artist.name) === normalizedName)
    || null;
  if (!selected?.providerId) return null;

  if (artistMbid) {
    storeProviderArtistMatch(
      provider as StreamingProvider,
      artistMbid,
      selected as ProviderArtist,
      "probable",
    );
  }
  return selected.providerId;
}

export async function syncYouTubeVideoCatalogForArtist(
  artistId: string,
  artistMbid: string | null,
  deps: YouTubeVideoCatalogDeps = {},
): Promise<number> {
  let snapshot: Pick<
    YouTubeMusicCapabilitySnapshot,
    "pythonAvailable" | "ytmusicapiAvailable" | "bridgeScriptAvailable"
  >;
  try {
    snapshot = await (deps.probeCapabilities || getYouTubeMusicCapabilitySnapshot)();
  } catch (error) {
    console.warn("[YouTubeVideoCatalog] capability probe failed:", error);
    return 0;
  }
  if (!snapshot.pythonAvailable || !snapshot.ytmusicapiAvailable || !snapshot.bridgeScriptAvailable) {
    console.warn(
      "[YouTubeVideoCatalog] public catalog unavailable "
      + `(python=${snapshot.pythonAvailable} ytmusicapi=${snapshot.ytmusicapiAvailable} bridge=${snapshot.bridgeScriptAvailable}); `
      + "MusicBrainz URL relations still supply YouTube watch ids when present.",
    );
    return 0;
  }

  let provider: YouTubeVideoCatalogProvider;
  try {
    provider = catalogProvider(deps);
  } catch (error) {
    console.warn("[YouTubeVideoCatalog] YouTube Music adapter is not registered:", error);
    return 0;
  }

  let providerArtistId: string | null;
  try {
    providerArtistId = await resolveYouTubeCatalogArtistId(provider, artistId, artistMbid);
  } catch (error) {
    console.warn(`[YouTubeVideoCatalog] artist resolve failed for ${artistId}:`, error);
    return 0;
  }
  if (!providerArtistId) {
    console.warn(`[YouTubeVideoCatalog] no YouTube channel for artist ${artistId}`);
    return 0;
  }

  try {
    const videos = (await provider.getArtistVideos(providerArtistId) || []).map((video) => ({
      ...providerVideoToOfferRow(video, artistId),
      provider: "youtube-music",
      _provider: "youtube-music",
    }));
    if (videos.length === 0) return 0;
    RefreshVideoService.upsertArtistVideos(artistId, videos);
    return videos.length;
  } catch (error) {
    console.warn(`[YouTubeVideoCatalog] getArtistVideos failed for ${artistId}:`, error);
    return 0;
  }
}
