/**
 * Clean and explicit renditions: what the catalogue says, what a provider says,
 * and which of them may fill which.
 *
 * Two rules decide everything here, and both are product decisions rather than
 * inferences from the data:
 *
 * 1. **An absent provider flag means clean.** Streaming services mark explicit
 *    content — it is a legal and store-listing obligation, not an optional
 *    enrichment. A track they did not mark is a track they are not calling
 *    explicit. The *fact* stays tri-state in storage, because "the provider
 *    said false" and "we never asked" are different things worth keeping; only
 *    policy collapses them.
 *
 * 2. **A labelled Edition takes only its own rendition.** When MusicBrainz
 *    issues a specifically clean edition, an explicit source for it is not an
 *    override — it is the wrong product, and the explicit edition exists to be
 *    monitored instead. So conflicting plans are dropped, not ranked lower.
 *
 * Coverage identity deliberately treats a clean and explicit Recording of one
 * performance as a single *wanted* song, so curation does not monitor both
 * editions. That leniency stops at the library boundary: what you want is one
 * song, what you fetch has to be the rendition you asked for.
 */

/** What a provider told us, kept exactly as told. */
export type ProviderExplicitness = "explicit" | "clean" | "unknown";

/** What the catalogue says this Edition is. */
export type EditionRendition = "explicit" | "clean" | "unlabelled";

/**
 * Policy value of an explicitness fact.
 *
 * `unknown` resolves to `clean` — see rule 1. This is the only place that
 * collapse happens, so changing the assumption is a one-line change here rather
 * than an audit of every caller.
 */
export function effectiveExplicitness(fact: ProviderExplicitness): "explicit" | "clean" {
  return fact === "explicit" ? "explicit" : "clean";
}

/** A provider's nullable flag as a fact, preserving "not told" as unknown. */
export function providerExplicitnessFromFlag(
  flag: boolean | number | null | undefined,
): ProviderExplicitness {
  if (flag == null) return "unknown";
  return Number(flag) === 1 ? "explicit" : "clean";
}

const EXPLICIT_WORD = /\bexplicit\b/i;
const CLEAN_WORD = /\b(?:clean|censored)\b/i;

/** Bracketed segments of a title: `Song (Clean Bandit remix) [Explicit]`. */
function bracketedSegments(title: string): string[] {
  const segments: string[] = [];
  for (const match of String(title || "").matchAll(/[([{]([^)\]}]*)[)\]}]/g)) {
    segments.push(match[1].trim());
  }
  return segments;
}

/**
 * Which rendition an Edition is, from the catalogue's own labelling.
 *
 * `disambiguation` is authoritative: it is the field MusicBrainz uses to
 * separate a clean issue from an explicit one, and 165 editions in the measured
 * library are labelled there.
 *
 * A title only labels the Edition when a bracketed segment is *exactly* the
 * marker. Scanning titles for the words themselves reads
 * "Drink About (Clean Bandit remix)" as a clean edition — the band's name is
 * not a content rating.
 */
export function editionRendition(
  title: string | null | undefined,
  disambiguation: string | null | undefined,
): EditionRendition {
  const disambiguationText = String(disambiguation || "");
  if (EXPLICIT_WORD.test(disambiguationText)) return "explicit";
  if (CLEAN_WORD.test(disambiguationText)) return "clean";

  for (const segment of bracketedSegments(title ?? "")) {
    const normalized = segment.toLowerCase().replace(/\s+version$/, "").trim();
    if (normalized === "explicit") return "explicit";
    if (normalized === "clean" || normalized === "censored") return "clean";
  }
  return "unlabelled";
}

/**
 * May this plan automatically fill this Edition?
 *
 * An unlabelled Edition accepts either rendition — `prefer_explicit` then
 * decides which is preferred, which is a ranking question, not an eligibility
 * one. A labelled Edition accepts only its own.
 */
export function planEligibleForEdition(
  planExplicitness: ProviderExplicitness,
  rendition: EditionRendition,
): boolean {
  if (rendition === "unlabelled") return true;
  return effectiveExplicitness(planExplicitness) === rendition;
}

/**
 * Rank for compare-sort under Settings → prefer_explicit. Higher is better.
 *
 * Only meaningful for unlabelled Editions; a labelled one has already excluded
 * the other rendition.
 */
export function renditionPreferenceRank(
  rendition: EditionRendition,
  preferExplicit: boolean,
): number {
  if (rendition === "unlabelled") return 1;
  return rendition === (preferExplicit ? "explicit" : "clean") ? 2 : 0;
}
