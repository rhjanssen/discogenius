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
import { getLinkedProviderArtistId, storeProviderArtistMatch } from "./refresh-artist-match.js";
import { normalizeMatchText, providerVideoToOfferRow } from "./refresh-artist-support.js";
import { RefreshVideoService } from "./refresh-video-service.js";

export type YouTubeVideoCatalogProvider = Pick<StreamingProvider, "id" | "name" | "search"> & {
  getArtistVideos: NonNullable<StreamingProvider["getArtistVideos"]>;
};

export type YouTubeVideoCatalogDeps = {
  getProvider?: () => YouTubeVideoCatalogProvider;
  probeCapabilities?: () => Promise<Pick<
    YouTubeMusicCapabilitySnapshot,
    "pythonAvailable" | "ytmusicapiAvailable" | "bridgeScriptAvailable"
  >>;
};

function catalogProvider(deps: YouTubeVideoCatalogDeps): YouTubeVideoCatalogProvider {
  if (deps.getProvider) return deps.getProvider();
  const provider = streamingProviderManager.getStreamingProvider("youtube-music");
  if (!provider.getArtistVideos) {
    throw new Error("YouTube Music adapter has no getArtistVideos");
  }
  return provider as YouTubeVideoCatalogProvider;
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
