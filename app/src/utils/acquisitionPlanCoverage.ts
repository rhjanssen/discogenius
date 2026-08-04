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
