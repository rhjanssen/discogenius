import type { ProviderQualityOffer } from "@/components/ui/ProviderQualityPill";

/**
 * Selected stereo/spatial slot offers for album card overlays and dense lists.
 * Mirrors Library list Available — not every provider variant, only what is
 * currently selected for download.
 */
export function albumSelectedQualityOffers(album: {
  stereo_provider_id?: string | null;
  stereo_quality?: string | null;
  stereo_provider?: string | null;
  stereo_match_status?: string | null;
  stereo_release_mbid?: string | null;
  spatial_provider_id?: string | null;
  spatial_quality?: string | null;
  spatial_provider?: string | null;
  spatial_match_status?: string | null;
  spatial_release_mbid?: string | null;
  quality?: string | null;
  selected_provider?: string | null;
  selected_release_mbid?: string | null;
} | null | undefined): ProviderQualityOffer[] {
  if (!album) return [];

  const offers: ProviderQualityOffer[] = [];
  if (album.stereo_provider_id) {
    offers.push({
      slot: "stereo",
      quality: album.stereo_quality || album.quality,
      provider: album.stereo_provider || album.selected_provider,
      matchStatus: album.stereo_match_status,
      providerAlbumId: album.stereo_provider_id,
      selectedReleaseMbid: album.stereo_release_mbid || album.selected_release_mbid,
    });
  }
  if (album.spatial_provider_id) {
    offers.push({
      slot: "spatial",
      quality: album.spatial_quality || "DOLBY_ATMOS",
      provider: album.spatial_provider || album.selected_provider,
      matchStatus: album.spatial_match_status,
      providerAlbumId: album.spatial_provider_id,
      selectedReleaseMbid: album.spatial_release_mbid || album.selected_release_mbid,
    });
  }
  return offers;
}
