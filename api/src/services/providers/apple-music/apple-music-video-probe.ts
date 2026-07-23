/**
 * Probe Apple Music video quality from the public catalog preview HLS master.
 *
 * Catalog only exposes `has4K` (→ UHD). Progressive preview MP4s are always
 * ~480p, so they are useless for badges. The preview HLS master lists
 * RESOLUTION ladders (including trick-play) that track the source max height.
 */
import {
  appleMusicApiRequest,
  storefrontFor,
  type AppleMusicApiOptions,
  type FetchLike,
} from "./apple-music-api.js";
import { appleVideoQualityTag } from "./apple-music-quality.js";
import { neutralVideoTagFromHeight, parseM3u8MaxHeight } from "../provider-quality.js";

type ApplePreview = { url?: string; hlsUrl?: string };
type AppleVideoAttrs = {
  has4K?: boolean;
  previews?: ApplePreview[];
};

export type AppleVideoQualityProbe = {
  height: number | null;
  qualityTag: string | null;
};

function resolveFetch(fetchImpl?: FetchLike): FetchLike {
  if (fetchImpl) return fetchImpl;
  if (typeof fetch === "function") {
    return fetch as unknown as FetchLike;
  }
  throw new Error("No fetch implementation available for Apple Music video probe");
}

function previewHlsUrl(attrs: AppleVideoAttrs | null | undefined): string | null {
  const previews = Array.isArray(attrs?.previews) ? attrs!.previews! : [];
  for (const preview of previews) {
    const hls = String(preview?.hlsUrl || "").trim();
    if (hls) return hls;
    const url = String(preview?.url || "").trim();
    if (url.includes(".m3u8")) return url;
  }
  return null;
}

/** Fetch an Apple music-video resource and resolve a neutral quality tag. */
export async function resolveAppleVideoQualityTag(
  videoId: string,
  options: AppleMusicApiOptions = {},
  catalogHas4K?: boolean | null,
): Promise<string | null> {
  const fromCatalog = appleVideoQualityTag(catalogHas4K);
  if (fromCatalog) return fromCatalog;

  const probed = await probeAppleVideoQuality(videoId, options);
  return probed?.qualityTag ?? null;
}

/** Probe max height / quality for an Apple music-video id via preview HLS. */
export async function probeAppleVideoQuality(
  videoId: string,
  options: AppleMusicApiOptions = {},
): Promise<AppleVideoQualityProbe | null> {
  const id = String(videoId || "").trim();
  if (!id) return null;

  try {
    const sf = storefrontFor(options.token);
    const res = await appleMusicApiRequest<{ data?: Array<{ attributes?: AppleVideoAttrs }> }>(
      `/v1/catalog/${sf}/music-videos/${encodeURIComponent(id)}`,
      options,
    );
    const attrs = res.data?.[0]?.attributes;
    return {
      height: attrs?.has4K ? 2160 : null,
      qualityTag: await appleVideoQualityFromAttributes(attrs, options),
    };
  } catch (error) {
    console.warn(`[Apple Music] Video quality probe failed for ${id}:`, error);
    return null;
  }
}

/** Resolve quality from already-fetched catalog attributes (avoids a second GET). */
export async function appleVideoQualityFromAttributes(
  attrs: AppleVideoAttrs | null | undefined,
  options: AppleMusicApiOptions = {},
): Promise<string | null> {
  const fromCatalog = appleVideoQualityTag(attrs?.has4K);
  if (fromCatalog) return fromCatalog;

  const hlsUrl = previewHlsUrl(attrs);
  if (!hlsUrl) return null;
  try {
    const doFetch = resolveFetch(options.fetchImpl);
    const masterRes = await doFetch(hlsUrl);
    if (!masterRes.ok) return null;
    // Fixture FetchLike only exposes json(); live Response also has text().
    const text = typeof (masterRes as { text?: () => Promise<string> }).text === "function"
      ? await (masterRes as { text: () => Promise<string> }).text()
      : JSON.stringify(await masterRes.json());
    if (typeof text !== "string" || text.trim().startsWith("{")) {
      // Fixture JSON payloads are not m3u8 — treat as unknown.
      return null;
    }
    return neutralVideoTagFromHeight(parseM3u8MaxHeight(text));
  } catch (error) {
    console.warn("[Apple Music] Preview HLS quality probe failed:", error);
    return null;
  }
}
