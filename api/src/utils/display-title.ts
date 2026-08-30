/** Append a catalog/provider disambiguation without repeating text already in the title. */
export function formatDisambiguatedTitle(
  title: string | null | undefined,
  disambiguation?: string | null,
  fallback = "Unknown",
): string {
  const base = String(title || "").trim() || fallback;
  const detail = String(disambiguation || "").trim();
  if (!detail || base.toLocaleLowerCase().includes(detail.toLocaleLowerCase())) {
    return base;
  }
  return `${base} (${detail})`;
}

/** Canonical recording detail wins; provider version only fills a catalog gap. */
export function formatTrackDisplayTitle(
  title: string | null | undefined,
  canonicalDisambiguation?: string | null,
  providerVersion?: string | null,
): string {
  return formatDisambiguatedTitle(
    title,
    String(canonicalDisambiguation || "").trim() || providerVersion,
    "Unknown Track",
  );
}
