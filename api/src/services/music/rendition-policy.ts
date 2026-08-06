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
 * The channel format an Edition is mixed for.
 *
 * Coverage identity treats a Dolby Atmos mix and its stereo counterpart as one
 * *wanted* song — two libraries, one song. Acquisition must still not fill a
 * "Dolby Atmos mix" Edition from a stereo source, exactly as it must not fill a
 * clean Edition from an explicit one.
 */
export type EditionMixFormat = "spatial" | "unlabelled";

/**
 * How automatic acquisition treats an explicitness fact.
 *
 * This is a *policy projection*, not a newly established fact: `null` may mean
 * the provider said "not explicit", or it may mean we never fetched the field.
 * The product rule is that neither is grounds for putting the item on an
 * explicit Edition, and both are acceptable on a clean one — so unknown resolves
 * to `clean` here and nowhere else. Callers that need the truth read the fact.
 */
export function explicitnessForAutomaticAcquisition(
  fact: ProviderExplicitness,
): "explicit" | "clean" {
  return fact === "explicit" ? "explicit" : "clean";
}

/** A provider's nullable flag as a fact, preserving "not told" as unknown. */
export function providerExplicitnessFromFlag(
  flag: boolean | number | null | undefined,
): ProviderExplicitness {
  if (flag == null) return "unknown";
  return Number(flag) === 1 ? "explicit" : "clean";
}

/**
 * Rendition markers as MusicBrainz actually writes them.
 *
 * Mined from the full corpus (5.6M releases, 39M recordings): comments are
 * comma-separated attribute lists, and a rendition marker occupies one whole
 * segment. The observed forms, by frequency, are `explicit` (6859),
 * `clean` (5010), `clean version` (363), `clean lyrics` (151), `cleaned` (95),
 * `explicit version` (90), `clean edit` (18), `explicit lyrics` (16) and
 * `censored` (16) — combined as `dolby atmos mix, explicit` or
 * `mastered for iTunes, clean lyrics`.
 *
 * Matching whole segments rather than scanning for the words is what keeps
 * "whitney houston x clean bandit remix" — the single contaminating comment in
 * 5.6M releases — from reading as a clean edition.
 */
const EXPLICIT_SEGMENT = /^explicit(?:\s+(?:version|edit|edition|mix|lyrics))?$/i;
const CLEAN_SEGMENT = /^(?:clean|cleaned|censored)(?:\s+(?:version|edit|edition|mix|lyrics))?$/i;

/**
 * `a, b, c` and `a - b` → the segments MusicBrainz treats as separate
 * attributes. Commas dominate the corpus, but the spaced dash is common too
 * ("deluxe edition - clean").
 *
 * Only a *spaced* dash separates: "clean-up crew edition" is one attribute, and
 * splitting it would leave a bare "clean".
 */
function attributeSegments(text: string): string[] {
  return String(text || "")
    .split(/[,;]|\s[-–—]\s/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

/**
 * Channel-format markers as the corpus writes them.
 *
 * Same mining, same shape: these occupy a whole attribute segment, and they
 * combine with rendition markers in one comment — `dolby atmos mix, explicit`
 * (280 releases). Observed frequencies across MusicBrainz recordings:
 * `dolby atmos mix` 11806, `5.1 mix` 2737, `360 reality audio mix` 1411,
 * `dolby atmos` 395, `quadraphonic` 361, `5.1 surround mix` 229,
 * `quadraphonic mix` 193, `5.1 surround sound` 172, `5.1 audio` 137.
 *
 * A trailing-word allowance covers the medium variants — `quadraphonic vinyl
 * lp` (41) and `quadraphonic 8-track` (32) are still quadraphonic.
 */
const SPATIAL_SEGMENT = new RegExp(
  [
    "^(?:dolby\\s+)?atmos(?:\\s+mix)?$",
    "^360\\s+reality\\s+audio(?:\\s+mix)?$",
    "^[57][.\\s]1(?:\\s+(?:mix|audio|surround(?:\\s+(?:mix|sound))?))?$",
    "^quadraphonic(?:\\s+\\S.*)?$",
    "^(?:spatial(?:\\s+audio)?|surround)(?:\\s+(?:mix|sound|audio))?$",
    "^(?:binaural|ambisonic|auro\\s*3d)(?:\\s+mix)?$",
  ].join("|"),
  "i",
);

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
 * Both fields are read as whole markers, never as words in prose. Scanning for
 * the words reads "Drink About (Clean Bandit remix)" as a clean edition — a
 * band's name is not a content rating.
 */
export function editionRendition(
  title: string | null | undefined,
  disambiguation: string | null | undefined,
): EditionRendition {
  for (const segment of attributeSegments(disambiguation ?? "")) {
    if (EXPLICIT_SEGMENT.test(segment)) return "explicit";
    if (CLEAN_SEGMENT.test(segment)) return "clean";
  }

  // A title labels the Edition only when a bracketed segment is the marker on
  // its own — "(Explicit)", never "(Clean Bandit remix)".
  for (const segment of bracketedSegments(title ?? "")) {
    if (EXPLICIT_SEGMENT.test(segment)) return "explicit";
    if (CLEAN_SEGMENT.test(segment)) return "clean";
  }
  return "unlabelled";
}

/**
 * Which channel format the catalogue says this Edition is mixed for.
 *
 * Unlabelled means stereo in practice — the overwhelming default — but it is
 * reported as unlabelled so the caller decides, and so a library whose profile
 * allows spatial is not blocked from an unlabelled Edition that happens to
 * carry a spatial offer.
 */
export function editionMixFormat(
  title: string | null | undefined,
  disambiguation: string | null | undefined,
): EditionMixFormat {
  for (const segment of attributeSegments(disambiguation ?? "")) {
    if (SPATIAL_SEGMENT.test(segment)) return "spatial";
  }
  for (const segment of bracketedSegments(title ?? "")) {
    if (SPATIAL_SEGMENT.test(segment)) return "spatial";
  }
  return "unlabelled";
}

/**
 * The Edition's channel format, falling back to what its Recordings say.
 *
 * MusicBrainz labels the release comment on 3,286 of the releases that contain
 * a channel-format-labelled recording, and those need no inference. On the
 * other 956 the release says nothing — but only 155 of them are *entirely*
 * spatial. The remaining 801 are ordinary editions carrying a bonus Atmos cut
 * or a compilation track, and calling those spatial would deny them every
 * stereo plan.
 *
 * So the Recordings only decide when they are unanimous. Inferring from "any"
 * would break 801 editions to fix 155.
 */
export function editionMixFormatWithRecordings(
  title: string | null | undefined,
  disambiguation: string | null | undefined,
  recordingComments: ReadonlyArray<string | null | undefined>,
): EditionMixFormat {
  const labelled = editionMixFormat(title, disambiguation);
  if (labelled === "spatial") return "spatial";
  if (recordingComments.length === 0) return "unlabelled";
  const everyRecordingIsSpatial = recordingComments.every(
    (comment) => editionMixFormat(null, comment) === "spatial",
  );
  return everyRecordingIsSpatial ? "spatial" : "unlabelled";
}

/**
 * May a plan of this quality tier fill an Edition of this channel format?
 *
 * A spatial-labelled Edition takes only a spatial plan. An unlabelled Edition
 * takes either — the library's own quality profile already decides which
 * source formats it accepts, and duplicating that here would stop a
 * spatial-capable library from using an unlabelled Edition.
 */
export function planEligibleForMixFormat(
  planQualityTier: string | null | undefined,
  mixFormat: EditionMixFormat,
): boolean {
  if (mixFormat === "unlabelled") return true;
  return String(planQualityTier || "").toLowerCase() === "spatial";
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
  return explicitnessForAutomaticAcquisition(planExplicitness) === rendition;
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
