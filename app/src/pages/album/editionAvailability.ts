import {
  editionCountLabel,
  editionMediaLabel,
  editionMediaRank,
  editionRegionLabel,
} from "@/pages/album/editionDisplay";
import type { ProviderQualityOffer } from "@/components/ui/ProviderQualityPill";
import {
  acquisitionPlanDisplayQuality,
  formatAcquisitionPlanCoverageSummary,
} from "@/utils/acquisitionPlanCoverage";
import type { ReleaseGroupAvailability } from "@/hooks/useAlbumPage";

export type AvailabilityRelease = ReleaseGroupAvailability["releases"][number];
export type AvailabilityLibrary = ReleaseGroupAvailability["libraries"][number];
export type AvailabilityOffer = AvailabilityRelease["offers"][number];
export type AvailabilitySelection = AvailabilityLibrary["selections"][number];
export type AvailabilityPlan = AvailabilitySelection["plans"][number];
export type AudioQuality = AvailabilityOffer["variants"][number]["qualityClass"];

const AUDIO_QUALITIES = new Set<AudioQuality>([
  "lossy",
  "lossless",
  "hires-lossless",
  "spatial",
]);

const UNAVAILABLE_STATES = new Set([
  "unavailable",
  "no_longer_available",
  "geography_restricted",
  "entitlement_restricted",
  "explicit_policy_ineligible",
  "quality_unavailable",
]);

const QUALITY_RANK: Record<AudioQuality, number> = {
  lossy: 1,
  lossless: 2,
  "hires-lossless": 3,
  spatial: 4,
};

export const QUALITY_TIER_LABEL: Record<string, string> = {
  "hires-lossless": "Hi-Res",
  lossless: "Lossless",
  lossy: "High",
  spatial: "Spatial",
};

export const EXPLICIT_LABEL: Record<string, string> = {
  explicit: "Explicit",
  clean: "Clean",
  unknown: "Explicitness unknown",
};

export function releaseYear(date?: string | null): string | null {
  if (!date) return null;
  const year = new Date(date).getFullYear();
  return Number.isFinite(year) ? String(year) : date.slice(0, 4) || null;
}

/** Media type · year · disc/track counts · region (status when not Official). */
export function releaseMeta(release: AvailabilityRelease): string {
  const counts = [
    editionCountLabel(release.mediumCount, "medium", "media"),
    editionCountLabel(release.trackCount, "track", "tracks"),
  ].filter(Boolean).join(" · ");
  return [
    editionMediaLabel(release.mediaFormats),
    releaseYear(release.date),
    counts || null,
    editionRegionLabel(release.country),
    release.status?.toLowerCase() === "official" ? null : release.status,
  ].filter(Boolean).join(" · ");
}

export function isAvailableState(value: string): boolean {
  return !UNAVAILABLE_STATES.has(value.trim().toLowerCase());
}

export function selectableOffers(release: AvailabilityRelease): AvailabilityOffer[] {
  return release.offers.filter((offer) =>
    offer.matchState === "accepted"
    && isAvailableState(offer.availability)
    && offer.variants.some((variant) => isAvailableState(variant.availability)));
}

export function libraryQualities(library: AvailabilityLibrary): Set<AudioQuality> {
  return new Set(library.allowedSourceFormats.filter(
    (quality): quality is AudioQuality => AUDIO_QUALITIES.has(quality as AudioQuality),
  ));
}

export function librarySlot(library: AvailabilityLibrary): "stereo" | "spatial" {
  const allowed = libraryQualities(library);
  return allowed.has("spatial") && allowed.size === 1 ? "spatial" : "stereo";
}

export function audioLibrariesForAvailability(
  availability: ReleaseGroupAvailability,
): AvailabilityLibrary[] {
  return availability.libraries
    .filter((library) => {
      const qualities = libraryQualities(library);
      if (qualities.size === 0) return false;
      const onlyVideo = [...qualities].every((q) => String(q) === "video");
      return !onlyVideo;
    })
    .sort((left, right) => {
      const leftSlot = librarySlot(left) === "spatial" ? 1 : 0;
      const rightSlot = librarySlot(right) === "spatial" ? 1 : 0;
      return leftSlot - rightSlot || left.id - right.id;
    });
}

export function providerLabel(provider: string): string {
  const key = provider.trim().toLowerCase();
  if (key === "tidal") return "TIDAL";
  if (key.startsWith("apple")) return "Apple Music";
  if (key.includes("amazon")) return "Amazon Music";
  if (key.includes("youtube")) return "YouTube Music";
  if (key === "deezer") return "Deezer";
  if (key === "soundcloud") return "SoundCloud";
  if (key === "spotify") return "Spotify";
  return provider;
}

export function editionExplicitGate(
  release: AvailabilityRelease,
): "explicit" | "clean" | null {
  const text = `${release.title || ""} ${release.disambiguation || ""}`.toLowerCase();
  if (/\bexplicit\b/.test(text)) return "explicit";
  if (/\bclean\b|\bcensored\b/.test(text)) return "clean";
  return null;
}

export function planMatchesEditionGate(
  plan: AvailabilityPlan,
  gate: "explicit" | "clean" | null,
): boolean {
  if (!gate) return true;
  if (plan.explicitContent === "unknown") return true;
  if (gate === "explicit" && plan.explicitContent === "clean") return false;
  if (gate === "clean" && plan.explicitContent === "explicit") return false;
  return true;
}

export function sortPlansGroupedByProvider(plans: readonly AvailabilityPlan[]): AvailabilityPlan[] {
  const byRank = [...plans].sort((left, right) =>
    left.rank - right.rank || left.id - right.id);
  const groups = new Map<string, AvailabilityPlan[]>();
  const order: string[] = [];
  for (const plan of byRank) {
    const list = groups.get(plan.provider);
    if (!list) {
      order.push(plan.provider);
      groups.set(plan.provider, [plan]);
    } else {
      list.push(plan);
    }
  }
  return order.flatMap((provider) => groups.get(provider) || []);
}

export function planSourceOffers(
  plan: AvailabilityPlan,
  release: AvailabilityRelease,
): AvailabilityOffer[] {
  const sourceOffers = plan.providerEditionMatchIds
    .map((matchId) => release.offers.find((offer) => offer.providerEditionMatchId === matchId))
    .filter((offer): offer is AvailabilityOffer => Boolean(offer));
  return [...sourceOffers].sort((left, right) => {
    const leftPrimary = left.providerEditionMatchId === plan.primaryProviderEditionMatchId ? 0 : 1;
    const rightPrimary = right.providerEditionMatchId === plan.primaryProviderEditionMatchId ? 0 : 1;
    return leftPrimary - rightPrimary;
  });
}

export function planToQualityOffer(
  plan: AvailabilityPlan,
  release: AvailabilityRelease,
  library: AvailabilityLibrary,
): ProviderQualityOffer {
  const slot = librarySlot(library);
  const ordered = planSourceOffers(plan, release);
  const albumIds = ordered
    .map((offer) => String(offer.providerId || "").trim())
    .filter(Boolean);
  const primary = ordered[0];
  const isComposite = plan.composition === "composite" || albumIds.length > 1;
  return {
    slot,
    planKey: plan.planKey,
    quality: acquisitionPlanDisplayQuality(plan),
    provider: plan.provider,
    matchStatus: "verified",
    matchKind: isComposite ? "composite" : "direct",
    coverageSummary: formatAcquisitionPlanCoverageSummary({
      composition: isComposite ? "composite" : "single_source",
      relation: primary?.relation ?? null,
      coverage: plan.coverage,
      targetTrackCount: plan.targetTrackCount,
    }),
    providerAlbumId: albumIds.join(";"),
    providerAlbumIds: albumIds,
    providerUrl: primary?.providerUrl ?? null,
    selectedReleaseMbid: release.mbid,
    explicit: plan.explicitContent === "explicit"
      ? true
      : plan.explicitContent === "clean"
        ? false
        : null,
    available: plan.state !== "unavailable" && plan.state !== "failed",
  };
}

export function bestOfferViewsForLibrary(
  release: AvailabilityRelease,
  library: AvailabilityLibrary,
): ProviderQualityOffer[] {
  const allowed = libraryQualities(library);
  const slot = librarySlot(library);
  const byProviderAlbum = new Map<string, ProviderQualityOffer>();
  for (const offer of selectableOffers(release)) {
    const variants = offer.variants
      .filter((variant) => allowed.has(variant.qualityClass) && isAvailableState(variant.availability))
      .sort((left, right) => (QUALITY_RANK[right.qualityClass] || 0) - (QUALITY_RANK[left.qualityClass] || 0));
    const best = variants[0];
    if (!best) continue;
    const key = `${offer.provider}\0${offer.providerId}`;
    byProviderAlbum.set(key, {
      slot,
      quality: best.qualityClass === "hires-lossless"
        ? "HIRES_LOSSLESS"
        : best.qualityClass === "spatial"
          ? (best.spatialFormat === "atmos" ? "DOLBY_ATMOS" : "SPATIAL")
          : best.qualityClass === "lossless"
            ? "LOSSLESS"
            : "HIGH",
      provider: offer.provider,
      matchStatus: offer.matchState === "accepted" ? "verified" : offer.matchState,
      matchKind: "direct",
      coverageSummary: formatAcquisitionPlanCoverageSummary({
        composition: "single_source",
        relation: offer.relation,
        coverage: 1,
        targetTrackCount: 1,
      }),
      providerAlbumId: offer.providerId,
      providerAlbumIds: [offer.providerId],
      providerUrl: offer.providerUrl,
      selectedReleaseMbid: release.mbid,
      available: true,
    });
  }
  return [...byProviderAlbum.values()];
}

export function bestQualityRank(release: AvailabilityRelease): number {
  return Math.max(
    0,
    ...selectableOffers(release).flatMap((offer) =>
      offer.variants.map((variant) => QUALITY_RANK[variant.qualityClass] || 0)),
  );
}

export function sortEditionsForAvailability(
  releases: readonly AvailabilityRelease[],
  selectedReleaseIds: Set<number>,
): AvailabilityRelease[] {
  return [...releases].sort((left, right) =>
    Number(selectedReleaseIds.has(right.id)) - Number(selectedReleaseIds.has(left.id))
    || Number(selectableOffers(right).length > 0) - Number(selectableOffers(left).length > 0)
    || editionMediaRank(left.mediaFormats) - editionMediaRank(right.mediaFormats)
    || (right.trackCount || 0) - (left.trackCount || 0)
    || bestQualityRank(right) - bestQualityRank(left)
    || Math.max(0, ...right.offers.map((offer) => offer.confidence))
      - Math.max(0, ...left.offers.map((offer) => offer.confidence))
    || String(left.date || "9999").localeCompare(String(right.date || "9999"))
    || left.id - right.id);
}

export function selectedPlanSummary(
  plan: AvailabilityPlan,
  release: AvailabilityRelease,
): {
  headline: string;
  detail: string;
  tooltip: string;
} {
  const ordered = planSourceOffers(plan, release);
  const ids = ordered.map((offer) => String(offer.providerId || "").trim()).filter(Boolean);
  const primary = ordered[0];
  const isComposite = plan.composition === "composite" || ids.length > 1;
  const detail = formatAcquisitionPlanCoverageSummary({
    composition: isComposite ? "composite" : "single_source",
    relation: primary?.relation ?? null,
    coverage: plan.coverage,
    targetTrackCount: plan.targetTrackCount,
  });
  const tier = QUALITY_TIER_LABEL[plan.qualityTier] ?? plan.qualityTier;
  const explicit = EXPLICIT_LABEL[plan.explicitContent] ?? plan.explicitContent;
  const headline = `${providerLabel(plan.provider)} · ${tier} · ${explicit}`;
  const idLine = ids.length === 0
    ? ""
    : ids.length === 1
      ? `${providerLabel(plan.provider)} album ID: ${ids[0]}`
      : `${providerLabel(plan.provider)} album IDs (primary first):\n${ids.map((id, i) => `${i === 0 ? "•" : "·"} ${id}`).join("\n")}`;
  const tooltip = [
    detail,
    idLine,
    release.mbid ? `MusicBrainz edition ${release.mbid}` : null,
    plan.state === "stale" ? "Plan is stale — re-curate to refresh." : null,
    plan.state === "unavailable" || plan.state === "failed" ? "Plan is currently unavailable." : null,
  ].filter(Boolean).join("\n");
  return { headline, detail, tooltip };
}
