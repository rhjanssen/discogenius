/**
 * How one Album Edition describes itself in the UI.
 *
 * The Editions list and the track-list tab strip name the same products, so
 * they share one set of labels. They used to carry two: the tab strip printed
 * raw MusicBrainz codes ("BE") while the Editions list printed country names
 * ("Belgium"), and the same release read as two different things on one page.
 *
 * These are presentation helpers only. Which Editions exist, which are
 * monitored, and which list opens first are decided by the API.
 */

/** MusicBrainz-style worldwide / non-country pseudo-codes we always surface. */
const WORLDWIDE_CODES = new Set(["XW", "XE", "XU"]);

export function countryDisplayName(code: string): string {
  const upper = code.trim().toUpperCase();
  if (!upper) return code;
  if (upper === "XW") return "Worldwide";
  if (upper === "XE") return "Europe";
  if (upper === "XU") return "Unknown / special";
  try {
    const names = new Intl.DisplayNames(["en"], { type: "region" });
    return names.of(upper) || upper;
  } catch {
    return upper;
  }
}

/**
 * Compact region label for edition meta.
 *
 * - ≤3 codes → full English names (Worldwide / Europe / country names)
 * - more, with a worldwide code → "XW & N regions" (N = non-worldwide count)
 * - more, without worldwide → "N regions"
 *
 * `country` arrives as the raw MusicBrainz column, which is JSON (`["BE"]`) far
 * more often than it is a scalar, and is frequently blank (`[]`, `[""]`).
 */
export function editionRegionLabel(country?: string | null): string | null {
  const text = String(country || "").trim();
  if (!text || text === "[]" || text === "[\"\"]" || text === "['']" || text === "null") {
    return null;
  }
  let countries: string[];
  try {
    const parsed: unknown = JSON.parse(text);
    countries = Array.isArray(parsed) ? parsed.map(String) : [text];
  } catch {
    countries = text.split(/[,;|]/);
  }
  const normalized = [...new Set(
    countries
      .map((value) => value.replace(/^\[+|\]+$/g, "").trim().toUpperCase())
      .filter((value) => value && value !== "UNKNOWN"),
  )];
  if (normalized.length === 0) return null;

  if (normalized.length <= 3) {
    return normalized.map(countryDisplayName).join(", ");
  }

  const worldwide = normalized.filter((code) => WORLDWIDE_CODES.has(code));
  const others = normalized.filter((code) => !WORLDWIDE_CODES.has(code));
  if (worldwide.length > 0) {
    // Prefer the canonical XW token when present; otherwise the first world code.
    const worldToken = normalized.includes("XW") ? "XW" : worldwide[0];
    if (others.length === 0) return worldToken === "XW" ? "Worldwide" : countryDisplayName(worldToken);
    return `${worldToken} & ${others.length} region${others.length === 1 ? "" : "s"}`;
  }
  return `${normalized.length} regions`;
}

/** Short display label for MusicBrainz medium formats ("Digital + CD"). */
export function editionMediaLabel(formats: readonly string[] | undefined | null): string | null {
  if (!formats || formats.length === 0) return null;
  const short = (format: string) => {
    const normalized = format.trim();
    if (!normalized) return null;
    if (/^digital(\s+media)?$/i.test(normalized)) return "Digital";
    if (/^cd$/i.test(normalized)) return "CD";
    if (/vinyl|12"|7"|lp/i.test(normalized)) return "Vinyl";
    if (/cassette/i.test(normalized)) return "Cassette";
    return normalized;
  };
  const unique = [...new Set(formats.map(short).filter(Boolean) as string[])];
  return unique.length > 0 ? unique.join(" + ") : null;
}

/** Lower is better: Digital → CD → Vinyl → Cassette → other → unknown. */
export function editionMediaRank(formats: readonly string[] | undefined | null): number {
  const label = (editionMediaLabel(formats) || "").toLowerCase();
  if (label.includes("digital")) return 0;
  if (label.includes("cd")) return 1;
  if (label.includes("vinyl")) return 2;
  if (label.includes("cassette")) return 3;
  if (!label) return 5;
  return 4;
}

export function editionCountLabel(
  count: number | null | undefined,
  singular: string,
  plural: string,
): string | null {
  if (count == null || count <= 0) return null;
  return `${count} ${count === 1 ? singular : plural}`;
}

export interface EditionLabelSource {
  title: string | null;
  disambiguation: string | null;
  country: string | null;
  mediaFormats: readonly string[];
  trackCount: number | null;
}

/**
 * Track-list tab label for one Edition of the same Album.
 *
 * Prefer product identity over date noise:
 *   [Edition title if ≠ album title] [disambiguation] · Media · Region · N tracks
 */
export function editionTabLabel(
  edition: EditionLabelSource,
  albumTitle?: string | null,
): string {
  const album = String(albumTitle || "").trim().toLowerCase();
  const editionTitle = String(edition.title || "").trim();
  const disambiguation = String(edition.disambiguation || "").trim();
  const titlePart = (() => {
    if (!editionTitle) return disambiguation || null;
    const titleDiffers = !album || editionTitle.toLowerCase() !== album;
    if (titleDiffers && disambiguation
      && !editionTitle.toLowerCase().includes(disambiguation.toLowerCase())) {
      return `${editionTitle} (${disambiguation})`;
    }
    if (titleDiffers) return editionTitle;
    if (disambiguation) return disambiguation;
    return null;
  })();
  const parts = [
    titlePart,
    editionMediaLabel(edition.mediaFormats),
    editionRegionLabel(edition.country),
    editionCountLabel(edition.trackCount, "track", "tracks"),
  ].filter(Boolean) as string[];
  return parts.length > 0 ? parts.join(" · ") : (editionTitle || "Edition");
}
