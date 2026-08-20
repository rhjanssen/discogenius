import type { ProviderQualityOffer } from "@/components/ui/ProviderQualityPill";
import { isSpatialAudioQuality } from "./spatialAudio";

/**
 * Provider + quality offers for a queue / history row. Same badge row as album
 * and artist cards. Coverage copy is omitted — a download is not a match.
 */
export function queueProviderOffers(item: {
  type?: string | null;
  quality?: string | null;
  provider?: string | null;
  providerId?: string | null;
  url?: string | null;
} | null | undefined): ProviderQualityOffer[] {
  if (!item) return [];
  const provider = String(item.provider || "").trim() || null;
  const quality = String(item.quality || "").trim() || null;
  if (!provider && !quality) return [];
  const isVideo = item.type === "video";
  return [{
    slot: isVideo ? "video" : isSpatialAudioQuality(quality) ? "spatial" : "stereo",
    quality,
    provider,
    providerAlbumId: String(item.providerId || "").trim() || null,
    providerUrl: item.url || null,
    coverageSummary: "",
  }];
}
