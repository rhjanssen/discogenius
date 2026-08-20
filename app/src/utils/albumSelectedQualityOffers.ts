import type { ProviderQualityOffer } from "@/components/ui/ProviderQualityPill";
import { coverageSummaryForSelectedOffer } from "./acquisitionPlanCoverage";

type SelectedSlotOfferFields = {
  providerId?: string | null;
  providerUrl?: string | null;
  quality?: string | null;
  provider?: string | null;
  matchStatus?: string | null;
  releaseMbid?: string | null;
  composition?: string | null;
  relation?: string | null;
  coverage?: number | null;
  targetTrackCount?: number | null;
};

/**
 * Selected stereo/spatial slot offers for album card overlays and dense lists.
 * Mirrors Library list Available — not every provider variant, only what is
 * currently selected for download.
 */
export function albumSelectedQualityOffers(album: {
  stereo_provider_id?: string | null;
  stereo_provider_url?: string | null;
  stereo_quality?: string | null;
  stereo_provider?: string | null;
  stereo_match_status?: string | null;
  stereo_release_mbid?: string | null;
  stereo_plan_composition?: string | null;
  stereo_plan_relation?: string | null;
  stereo_plan_coverage?: number | null;
  stereo_plan_target_track_count?: number | null;
  spatial_provider_id?: string | null;
  spatial_provider_url?: string | null;
  spatial_quality?: string | null;
  spatial_provider?: string | null;
  spatial_match_status?: string | null;
  spatial_release_mbid?: string | null;
  spatial_plan_composition?: string | null;
  spatial_plan_relation?: string | null;
  spatial_plan_coverage?: number | null;
  spatial_plan_target_track_count?: number | null;
  quality?: string | null;
  selected_provider?: string | null;
  selected_release_mbid?: string | null;
} | null | undefined): ProviderQualityOffer[] {
  if (!album) return [];

  const offers: ProviderQualityOffer[] = [];
  const stereo = slotOffer("stereo", {
    providerId: album.stereo_provider_id,
    providerUrl: album.stereo_provider_url,
    quality: album.stereo_quality || album.quality,
    provider: album.stereo_provider || album.selected_provider,
    matchStatus: album.stereo_match_status,
    releaseMbid: album.stereo_release_mbid || album.selected_release_mbid,
    composition: album.stereo_plan_composition,
    relation: album.stereo_plan_relation,
    coverage: album.stereo_plan_coverage,
    targetTrackCount: album.stereo_plan_target_track_count,
  });
  if (stereo) offers.push(stereo);
  const spatial = slotOffer("spatial", {
    providerId: album.spatial_provider_id,
    providerUrl: album.spatial_provider_url,
    quality: album.spatial_quality || "DOLBY_ATMOS",
    provider: album.spatial_provider || album.selected_provider,
    matchStatus: album.spatial_match_status,
    releaseMbid: album.spatial_release_mbid || album.selected_release_mbid,
    composition: album.spatial_plan_composition,
    relation: album.spatial_plan_relation,
    coverage: album.spatial_plan_coverage,
    targetTrackCount: album.spatial_plan_target_track_count,
  });
  if (spatial) offers.push(spatial);
  return offers;
}

function slotOffer(
  slot: "stereo" | "spatial",
  fields: SelectedSlotOfferFields,
): ProviderQualityOffer | null {
  const providerAlbumId = String(fields.providerId || "").trim() || null;
  if (!providerAlbumId) return null;
  const isComposite = fields.composition === "composite" || providerAlbumId.includes(";");
  return {
    slot,
    quality: fields.quality,
    provider: fields.provider,
    matchStatus: fields.matchStatus,
    matchKind: isComposite ? "composite" : "direct",
    coverageSummary: coverageSummaryForSelectedOffer({
      composition: fields.composition,
      relation: fields.relation,
      coverage: fields.coverage,
      targetTrackCount: fields.targetTrackCount,
      providerAlbumId,
    }),
    providerAlbumId,
    providerUrl: fields.providerUrl,
    selectedReleaseMbid: fields.releaseMbid,
  };
}
