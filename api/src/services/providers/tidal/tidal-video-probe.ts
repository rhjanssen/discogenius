/**
 * Probe the actual max resolution available for a TIDAL music video.
 *
 * Catalog `quality: MP4_1080P` is frequently wrong (stream may top out at
 * 720p or 480p). We ask for HIGH playbackinfo, then read the HLS master
 * playlist's RESOLUTION lines — the same source tiddl downloads from.
 */
import { getCountryCode, loadToken, refreshTidalToken } from "./tidal.js";
import {
  isUntrustedTidalCatalogVideoQuality,
  tidalVideoQualityTag,
  tidalVideoQualityTagFromProbe,
  parseM3u8MaxHeight,
} from "./tidal-quality.js";

const TIDAL_API_BASE = "https://api.tidal.com/v1";

export type TidalVideoQualityProbe = {
  height: number | null;
  streamQuality: string | null;
  qualityTag: string | null;
};

async function fetchJson(
  url: string,
  accessToken: string,
): Promise<{ ok: boolean; status: number; data: any }> {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  const text = await res.text().catch(() => "");
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text.slice(0, 200) };
  }
  return { ok: res.ok, status: res.status, data };
}

async function probeOnce(
  videoId: string,
  accessToken: string,
  countryCode: string,
): Promise<TidalVideoQualityProbe | null> {
  // Prefer HIGH; TIDAL silently downgrades videoQuality when 1080p is absent.
  for (const requested of ["HIGH", "MEDIUM", "LOW"] as const) {
    const url =
      `${TIDAL_API_BASE}/videos/${encodeURIComponent(videoId)}/playbackinfopostpaywall`
      + `?videoquality=${requested}&playbackmode=STREAM&assetpresentation=FULL`
      + `&countryCode=${encodeURIComponent(countryCode)}`;
    const { ok, status, data } = await fetchJson(url, accessToken);
    if (!ok || !data?.manifest) {
      if (status === 401 || status === 403) {
        return null;
      }
      continue;
    }

    const streamQuality = typeof data.videoQuality === "string" ? data.videoQuality : null;
    let height: number | null = null;
    try {
      const decoded = Buffer.from(String(data.manifest), "base64").toString("utf8");
      const manifestJson = JSON.parse(decoded) as { urls?: string[] };
      const masterUrl = Array.isArray(manifestJson.urls)
        ? manifestJson.urls.find((u) => typeof u === "string" && u.length > 0)
        : null;
      if (masterUrl) {
        const masterRes = await fetch(masterUrl);
        if (masterRes.ok) {
          height = parseM3u8MaxHeight(await masterRes.text());
        }
      }
    } catch (error) {
      console.warn(`[TIDAL] Failed to parse video stream manifest for ${videoId}:`, error);
    }

    const qualityTag = tidalVideoQualityTagFromProbe({ height, streamQuality });
    if (qualityTag || height != null || streamQuality) {
      return { height, streamQuality, qualityTag };
    }
  }
  return null;
}

/** Probe max available height/quality for a TIDAL video id. */
export async function probeTidalVideoQuality(videoId: string): Promise<TidalVideoQualityProbe | null> {
  const id = String(videoId || "").trim();
  if (!id) return null;

  let token = loadToken();
  if (!token?.access_token) return null;
  const cc = getCountryCode();

  let result = await probeOnce(id, token.access_token, cc);
  if (result) return result;

  try {
    await refreshTidalToken(true);
    token = loadToken();
    if (!token?.access_token) return null;
    result = await probeOnce(id, token.access_token, cc);
    return result;
  } catch (error) {
    console.warn(`[TIDAL] Video quality probe token refresh failed for ${id}:`, error);
    return null;
  }
}

/**
 * Resolve the quality tag for a TIDAL video: stream probe first, then trusted
 * catalog tags (MP4_720P etc.). Never returns FHD from bare catalog MP4_1080P.
 */
export async function resolveTidalVideoQualityTag(
  videoId: string,
  catalogQuality?: string | null,
): Promise<string | null> {
  const probed = await probeTidalVideoQuality(videoId);
  if (probed?.qualityTag) {
    return probed.qualityTag;
  }
  if (!isUntrustedTidalCatalogVideoQuality(catalogQuality)) {
    return tidalVideoQualityTag(catalogQuality);
  }
  return null;
}
