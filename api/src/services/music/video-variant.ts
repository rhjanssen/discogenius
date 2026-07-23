/**
 * Catalog video identity helpers: clean group title + variant class.
 * Provider marketing titles are evidence for establishing these fields only;
 * import/organize/rename read Recordings.title + Recordings.video_variant.
 */

/**
 * Catalog video class. `official` is the OMV marketing form of `video` (same
 * filename suffix) but must not cross-merge with live cuts once titles are cleaned.
 */
export const VIDEO_VARIANTS = ["video", "official", "lyric", "live", "audio", "visualizer"] as const;
export type VideoVariant = (typeof VIDEO_VARIANTS)[number];

/** Soft duration gate for same-class and cross-class video merges (2s). */
export const VIDEO_DURATION_MATCH_MS = 2_000;

/**
 * Wider gate when linking a main/official music video to studio album audio.
 * OMVs routinely run several seconds longer than the stereo cut; the tight
 * video↔video gate would otherwise prefer a same-duration live bootleg.
 */
export const VIDEO_AUDIO_STUDIO_DURATION_MATCH_MS = 20_000;

const VARIANT_CLASS_RULES: Array<{ variant: VideoVariant; re: RegExp }> = [
  { variant: "audio", re: /\baudio\b/i },
  { variant: "lyric", re: /\blyrics?\b/i },
  // Moving artwork / visualiser cuts share the Visualizer filter — keep them
  // out of Official Audio / bare OMV buckets.
  { variant: "visualizer", re: /\bvisuali[sz]er\b|\bmoving\s+artwork\b/i },
  // MTV Unplugged (and similar branded sessions) are live performances.
  { variant: "live", re: /\blive\b|\bperformance\b|\bmtv\s+unplugged\b/i },
  { variant: "official", re: /\bofficial\b|\bmusic\s*video\b/i },
];

const VARIANT_RANK: Record<VideoVariant, number> = {
  lyric: 4,
  live: 3,
  audio: 2,
  visualizer: 2,
  official: 2,
  video: 1,
};

/** Classify a provider/MB title into a catalog video variant. */
export function parseVideoVariant(title: string | null | undefined): VideoVariant {
  const text = String(title || "");
  for (const { variant, re } of VARIANT_CLASS_RULES) {
    if (re.test(text)) return variant;
  }
  return "video";
}

/** True when the class is the main OMV / unlabeled music-video slot (not lyric/live). */
export function isMainVideoVariant(variant: VideoVariant | null | undefined): boolean {
  const normalized = normalizeVideoVariant(variant);
  return normalized === "video" || normalized === "official";
}

/**
 * Default-OMV marketing wrappers stripped from stored display titles.
 * Lyric / audio / visualizer markers stay — matching uses
 * {@link cleanVideoGroupTitle} (bare); display keeps the cut label.
 */
const MARKETING_PAREN_RE =
  /\s*[([][^)\]]*\b(official(?:\s+music)?\s*video|music\s*video)\b[^)\]]*[)\]]/gi;
const MARKETING_DASH_RE =
  /\s+[-–—]\s*(?:official(?:\s+music)?\s*video|music\s*video)\s*$/i;

/**
 * Strip lyric/live/official/audio/visualizer qualifiers for identity matching
 * (e.g. "Oblivion", not "Oblivion (Lyric Video)"). Matching uses this; storage
 * and UI prefer {@link catalogVideoDisplayTitle}.
 */
export function cleanVideoGroupTitle(title: string | null | undefined): string {
  const raw = String(title || "").trim();
  if (!raw) return "Unknown Video";

  const cleaned = raw
    .replace(
      /\s*[([][^)\]]*\b(lyrics?|live|performance|audio|visuali[sz]er|moving\s+artwork|mtv\s+unplugged|official(?:\s+music)?\s*video|music\s*video|official)[^)\]]*[)\]]/gi,
      "",
    )
    .replace(
      /\s+[-–—]\s*(?:official\s+)?(?:lyric(?:s)?(?:\s+video)?|live(?:\s+.*)?|audio(?:\s+.*)?|visuali[sz]er(?:\s+.*)?|moving\s+artwork(?:\s+.*)?)?\s*$/i,
      "",
    )
    .replace(/\s+/g, " ")
    .trim();

  // If stripping emptied the string, keep the original (edge-case titles).
  return cleaned || raw;
}

/**
 * Display title stored on Recordings: drop default OMV wrappers (Official Music
 * Video / Official Video) but keep lyric/audio/visualizer/venue/feat text so
 * the UI and `{Video Title}` naming show the cut. Matching still uses
 * {@link cleanVideoGroupTitle}.
 */
export function catalogVideoDisplayTitle(title: string | null | undefined): string {
  const raw = String(title || "").trim();
  if (!raw) return "Unknown Video";
  const cleaned = raw
    .replace(MARKETING_PAREN_RE, "")
    .replace(MARKETING_DASH_RE, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || raw;
}

export function isMarketingVideoParenthetical(text: string): boolean {
  return /\b(official(?:\s+music)?\s*video|music\s*video|lyric(?:s)?(?:\s+video)?|audio|visuali[sz]er)\b/i.test(
    String(text || ""),
  );
}

export function extractVideoParentheticals(title: string): string[] {
  return [...String(title || "").matchAll(/\(([^)]+)\)|\[([^\]]+)\]/g)]
    .map((match) => String(match[1] || match[2] || "").trim())
    .filter(Boolean);
}

/** Prefer the more specific variant when merging offers onto one recording. */
export function preferredVideoVariant(
  left: VideoVariant | string | null | undefined,
  right: VideoVariant | string | null | undefined,
): VideoVariant {
  const a = normalizeVideoVariant(left);
  const b = normalizeVideoVariant(right);
  return VARIANT_RANK[a] >= VARIANT_RANK[b] ? a : b;
}

export function normalizeVideoVariant(value: unknown): VideoVariant {
  const text = String(value || "").trim().toLowerCase();
  if ((VIDEO_VARIANTS as readonly string[]).includes(text)) {
    return text as VideoVariant;
  }
  return "video";
}

/**
 * Plex/Jellyfin extras suffix for filename templates ({videoType}).
 * Variant column wins; title parse fills interview/BTS/concert when variant is plain video.
 */
export function resolveVideoTypeSuffix(
  variant: VideoVariant | null | undefined,
  title?: string | null,
): string {
  const normalized = normalizeVideoVariant(variant);
  if (normalized === "lyric") return "-lyrics";
  if (normalized === "live") return "-live";
  // official/audio/visualizer share the main Plex extras token.
  if (normalized === "official" || normalized === "audio" || normalized === "visualizer") {
    return "-video";
  }

  const text = String(title || "").trim();
  if (!text) return "-video";
  const lower = text.toLowerCase();
  if (/behind[\s-]*the[\s-]*scenes/.test(lower)) return "-behindthescenes";
  if (/\binterview\b/.test(lower)) return "-interview";

  const qualifiers = [
    ...[...lower.matchAll(/\(([^)]*)\)|\[([^\]]*)\]/g)].map((m) => m[1] || m[2] || ""),
    ...(lower.split(/\s+[-–—]\s+/).slice(1)),
  ].join(" ");
  if (/\bconcert\b/.test(qualifiers)) return "-concert";

  return "-video";
}
