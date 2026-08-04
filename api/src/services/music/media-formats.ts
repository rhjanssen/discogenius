/**
 * The one reader of `AlbumEditions.media`.
 *
 * MusicBrainz medium lists reach us in more than one shape depending on which
 * catalog source wrote the row: the Servarr metadata mirror emits Lidarr-style
 * `[{ "Format": "CD" }]`, the MusicBrainz web service mapping emits
 * `[{ "format": "CD" }]`, and older rows hold a plain `["CD"]`. Two divergent
 * parsers used to disagree about which of those counted, so the same Edition
 * could describe itself as `["Digital Media", "Digital Media"]` in the track-list
 * tabs and `[]` in the Editions list.
 *
 * Formats are display metadata: a malformed payload degrades to "no formats
 * known" rather than throwing, but it never degrades into noise like
 * `[object Object]` or a raw JSON blob presented as a format name.
 */

interface MediumRecord {
  Format?: unknown;
  format?: unknown;
  name?: unknown;
}

function formatOf(entry: unknown): string {
  if (typeof entry === "string") return entry.trim();
  if (typeof entry === "number") return String(entry);
  if (entry && typeof entry === "object") {
    const record = entry as MediumRecord;
    for (const candidate of [record.Format, record.format, record.name]) {
      if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    }
  }
  return "";
}

/**
 * Distinct medium formats of one Edition, in first-seen order.
 *
 * A two-CD release reports `["CD"]`, not `["CD", "CD"]` — the tab strip and the
 * Editions list describe what kind of product it is, and the medium count is
 * carried separately.
 */
export function parseMediaFormats(mediaJson: string | null | undefined): string[] {
  const raw = String(mediaJson ?? "").trim();
  if (!raw) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A bare `CD` (unquoted) is not valid JSON but is a legible format name.
    // Anything that looks like a broken structure is dropped instead.
    return /^[\w][\w \-+/'".]*$/.test(raw) ? [raw] : [];
  }

  const entries = Array.isArray(parsed) ? parsed : [parsed];
  const formats: string[] = [];
  for (const entry of entries) {
    const format = formatOf(entry);
    if (format && !formats.includes(format)) formats.push(format);
  }
  return formats;
}
