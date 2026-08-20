export { acquisitionPlanDisplayQuality } from "./acquisitionPlanDisplayQuality";

/**
 * Album-level acquisition plan tooltip headline.
 * - single-source + exact → "Complete match"
 * - single-source + other relation → "Single source · Full/Partial coverage"
 * - composite → "Composite · Full/Partial coverage"
 */
export function formatAcquisitionPlanCoverageSummary(input: {
  composition: "single_source" | "composite";
  relation?: string | null;
  coverage: number;
  targetTrackCount: number;
}): string {
  const full = input.targetTrackCount <= 0 || input.coverage >= input.targetTrackCount;
  const coverageLabel = full ? "Full coverage" : "Partial coverage";
  if (input.composition === "composite") {
    return `Composite · ${coverageLabel}`;
  }
  if (String(input.relation || "").toLowerCase() === "exact") {
    return "Complete match";
  }
  return `Single source · ${coverageLabel}`;
}

/**
 * Coverage line for a selected stereo/spatial offer when the caller has only
 * the card's plan/match fields (artist page, library grid). Missing relation
 * on a single source is treated as exact — the same default the album page
 * uses when a plan has not been loaded yet.
 */
export function coverageSummaryForSelectedOffer(input: {
  composition?: string | null;
  relation?: string | null;
  coverage?: number | null;
  targetTrackCount?: number | null;
  providerAlbumId?: string | null;
}): string {
  const albumIds = String(input.providerAlbumId || "")
    .split(";")
    .map((id) => id.trim())
    .filter(Boolean);
  const isComposite = input.composition === "composite" || albumIds.length > 1;
  const coverage = Number(input.coverage);
  const targetTrackCount = Number(input.targetTrackCount);
  return formatAcquisitionPlanCoverageSummary({
    composition: isComposite ? "composite" : "single_source",
    relation: input.relation ?? (isComposite ? null : "exact"),
    coverage: Number.isFinite(coverage) ? coverage : 1,
    targetTrackCount: Number.isFinite(targetTrackCount) && targetTrackCount > 0
      ? targetTrackCount
      : 1,
  });
}
