import path from "path";
import { getConfigSection, type NamingConfig } from "./config.js";

export type LibraryRoot = "music" | "spatial_music" | "music_videos";

export type NamingContext = {
  artistName: string;
  artistMbId?: string | null;

  albumTitle?: string | null;
  albumVersion?: string | null;
  albumFullTitle?: string | null;
  albumType?: string | null;
  albumMbId?: string | null;
  releaseGroupMbId?: string | null;
  releaseYear?: string | null;
  explicit?: boolean | null;

  trackTitle?: string | null;
  trackVersion?: string | null;
  trackFullTitle?: string | null;
  trackArtistName?: string | null;
  trackArtistMbId?: string | null;
  trackMbId?: string | null;
  trackNumber?: number | null;
  volumeNumber?: number | null;

  artistId?: string | null;
  albumId?: string | null;
  trackId?: string | null;
  videoId?: string | null;

  videoTitle?: string | null;

  // Audio quality metadata (optional, from library_files)
  quality?: string | null;
  codec?: string | null;
  bitrate?: number | null;
  sampleRate?: number | null;
  bitDepth?: number | null;
  channels?: number | null;
};

function sanitizeSegment(input: string): string {
  return (input || "")
    .replace(/[<>:"/\\|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Path/filename cleaners

function cleanTitle(input: string): string {
  // 1. Replace & with "and"
  let result = (input || "").replace(/&/g, "and");

  // 2. Replace / with space
  result = result.replace(/\//g, " ");

  // 3. Remove special characters
  // This removes: <>:"/\|?*'!#@$%^~;``() and brackets
  // The logic is to remove punctuation but keep alphanumeric and spaces
  result = result.replace(/[<>:"/\\|?*'!#@$%^~;`()[\]{}]/g, " ");

  // 4. Remove diacritics using Unicode normalization
  result = result.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  // 5. Cleanup whitespace (multiple spaces -> single space)
  result = result.replace(/\s+/g, " ").trim();

  return result;
}

function titleThe(input: string): string {
  // Match: ^(The|An|A) (.*?)((?: *\([^)]+\))*)$
  // Replace: $2, $1$3 (moves prefix to end, preserves parenthetical suffix)
  const value = (input || "").trim();
  if (!value) return "";

  const match = /^(The|An|A)\s+(.*?)((?: *\([^)]+\))*)$/i.exec(value);
  if (!match) return value;

  const prefix = match[1];
  const main = match[2].trim();
  const suffix = match[3];

  return main ? `${main}, ${prefix}${suffix}` : value;
}

function cleanTitleThe(input: string): string {
  // If title matches TitlePrefixRegex, split and clean parts separately
  // Otherwise return CleanTitle(title)
  const value = (input || "").trim();
  if (!value) return "";

  const match = /^(The|An|A)\s+(.*?)((?: *\([^)]+\))*)$/i.exec(value);
  if (!match) {
    // No prefix found, just clean the whole thing
    return cleanTitle(value);
  }

  const prefix = match[1];
  const main = match[2].trim();
  const suffix = match[3];

  // Clean main and suffix parts separately
  const cleanedMain = cleanTitle(main);
  const cleanedSuffix = cleanTitle(suffix);

  return `${cleanedMain}, ${prefix}${cleanedSuffix}`;
}

function toCleanText(input: string): string {
  // Legacy function for backward compatibility with modifier syntax
  return cleanTitle(input);
}

function toNameThe(input: string): string {
  // Legacy function for backward compatibility with modifier syntax
  return titleThe(input);
}

function normalizeTokenName(input: string): string {
  return (input || "").toLowerCase().replace(/[\s._-]+/g, "").trim();
}

function applyNumberFormat(value: number, format?: string): string {
  const normalizedFormat = (format || "").trim();
  if (!normalizedFormat) {
    return String(value);
  }

  if (/^0+$/.test(normalizedFormat)) {
    return String(value).padStart(normalizedFormat.length, "0");
  }

  const width = Number.parseInt(normalizedFormat, 10);
  if (Number.isFinite(width) && width > 0) {
    return String(value).padStart(width, "0");
  }

  return String(value);
}

function parseLegacyPaddedToken(normalizedName: string, base: string): number | null {
  const match = new RegExp(`^${base}(0+)$`).exec(normalizedName);
  if (!match) return null;
  return match[1].length;
}

function cleanupRendered(input: string): string {
  return (input || "")
    .replace(/\(\s*\)/g, "")
    .replace(/\[\s*\]/g, "")
    .replace(/\{\s*\}/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function formatQualityValue(value: unknown, format: string): string {
  if (value === null || value === undefined) {
    return "";
  }

  // Numeric quality values may need unit formatting
  if (typeof value === "number") {
    // sampleRate: Hz (e.g., 44100) -> kHz (e.g., 44.1)
    if (format === "kHz") {
      const kHz = (value / 1000).toFixed(1);
      return kHz.endsWith(".0") ? kHz.slice(0, -2) : kHz;
    }
    if (format === "Hz" || format === "raw") {
      return String(value);
    }
    // Default: just the value
    return String(value);
  }

  return String(value);
}

function buildDerived(context: NamingContext) {
  const artistName = context.artistName || "Unknown Artist";
  const artistId = context.artistId || "";
  const artistMbId = context.artistMbId || "";

  const albumTitle = context.albumTitle || "Unknown Album";
  const albumId = context.albumId || "";
  const albumType = context.albumType || "";
  const albumMbId = context.albumMbId || "";
  const releaseGroupMbId = context.releaseGroupMbId || "";
  const albumVersion = context.albumVersion ?? "";
  const albumFullTitle =
    context.albumFullTitle ||
    (albumVersion && !albumTitle.toLowerCase().includes(albumVersion.toLowerCase())
      ? `${albumTitle} (${albumVersion})`
      : albumTitle);

  const trackTitle = context.trackTitle || "Unknown Track";
  const trackVersion = context.trackVersion ?? "";
  const trackArtistName = context.trackArtistName || artistName;
  const trackArtistMbId = context.trackArtistMbId || artistMbId;
  const trackMbId = context.trackMbId || "";
  const trackFullTitle =
    context.trackFullTitle ||
    (trackVersion && !trackTitle.toLowerCase().includes(trackVersion.toLowerCase())
      ? `${trackTitle} (${trackVersion})`
      : trackTitle);

  const trackNumber = Number(context.trackNumber || 0);
  const volumeNumber = Number(context.volumeNumber || 1);

  const releaseYear = (context.releaseYear ? String(context.releaseYear) : "").toString();
  const videoTitle = context.videoTitle || "Unknown Video";
  const trackId = context.trackId || context.videoId || "";
  const videoId = context.videoId || context.trackId || "";

  return {
    artistName,
    artistMbId,
    artistId,
    albumTitle,
    albumId,
    albumType,
    albumMbId,
    releaseGroupMbId,
    albumVersion,
    albumFullTitle,
    releaseYear,
    trackTitle,
    trackArtistName,
    trackArtistMbId,
    trackMbId,
    trackVersion,
    trackFullTitle,
    trackNumber,
    volumeNumber,
    videoTitle,
    trackId,
    videoId,
  };
}

function resolveToken(rawTokenBody: string, context: NamingContext): string {
  const derived = buildDerived(context);

  // Split by ':' to get token name and format specifiers
  // Note: modifiers like :the:clean are deprecated; use named variables instead
  //       e.g., {artistCleanNameThe} instead of {artistName:clean:the}
  const parts = rawTokenBody.split(":");
  const tokenName = parts[0];
  const formatSpecifiers = parts.slice(1);
  const normalizedName = normalizeTokenName(tokenName);

  // Check for legacy padded token formats (e.g., trackNumber00, volumeNumber000)
  const trackNumberLegacyPad = parseLegacyPaddedToken(normalizedName, "tracknumber");
  if (trackNumberLegacyPad !== null) {
    return applyNumberFormat(derived.trackNumber, "0".repeat(trackNumberLegacyPad));
  }
  const volumeNumberLegacyPad = parseLegacyPaddedToken(normalizedName, "volumenumber");
  if (volumeNumberLegacyPad !== null) {
    return applyNumberFormat(derived.volumeNumber, "0".repeat(volumeNumberLegacyPad));
  }

  // Resolve base unsanitized value based on token name
  let baseValue: string | null = null;
  let isNumericToken = false;
  let numericValue: number | null = null;

  switch (normalizedName) {
    // Artist names - all variants
    case "artistname":
      baseValue = derived.artistName;
      break;
    case "artistcleanname":
      baseValue = cleanTitle(derived.artistName);
      break;
    case "artistnamethe":
      baseValue = titleThe(derived.artistName);
      break;
    case "artistcleannamthe":
    case "artistcleannamethe":
      baseValue = cleanTitleThe(derived.artistName);
      break;
    case "artistmbid":
      baseValue = derived.artistMbId;
      break;
    case "artistid":
      baseValue = derived.artistId;
      break;
    case "artistnamefirstcharacter": {
      // Like Lidarr's TitleFirstCharacter: strip diacritics first, then check alphanumeric
      const theArtistName = titleThe(derived.artistName);
      if (theArtistName.length === 0) { baseValue = "_"; break; }
      const normalized = theArtistName.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      const first = normalized[0];
      if (/[a-zA-Z0-9]/.test(first)) {
        baseValue = first.toUpperCase();
        break;
      }
      if (normalized.length > 1 && /[a-zA-Z0-9]/.test(normalized[1])) {
        baseValue = normalized[1].toUpperCase();
        break;
      }
      baseValue = "_";
      break;
    }

    // Album titles - all variants
    case "albumtitle":
      baseValue = derived.albumTitle;
      break;
    case "albumcleantitle":
      baseValue = cleanTitle(derived.albumTitle);
      break;
    case "albumtitlethe":
      baseValue = titleThe(derived.albumTitle);
      break;
    case "albumcleantitlethe":
      baseValue = cleanTitleThe(derived.albumTitle);
      break;
    case "albumtype":
      baseValue = derived.albumType;
      break;
    case "albummbid":
      baseValue = derived.albumMbId;
      break;
    case "releasegroupmbid":
      baseValue = derived.releaseGroupMbId;
      break;
    case "albumid":
      baseValue = derived.albumId;
      break;
    case "albumfulltitle":
      baseValue = derived.albumFullTitle;
      break;
    case "releaseyear":
      baseValue = derived.releaseYear;
      break;

    // Track titles - all variants
    case "tracktitle":
      baseValue = derived.trackTitle;
      break;
    case "trackcleantitle":
      baseValue = cleanTitle(derived.trackTitle);
      break;
    case "tracktitlethe":
      baseValue = titleThe(derived.trackTitle);
      break;
    case "trackcleantitlethe":
      baseValue = cleanTitleThe(derived.trackTitle);
      break;
    case "trackfulltitle":
      baseValue = derived.trackFullTitle;
      break;

    // Track artist names - all variants
    case "trackartistname":
      baseValue = derived.trackArtistName;
      break;
    case "trackartistcleanname":
      baseValue = cleanTitle(derived.trackArtistName);
      break;
    case "trackartistnamethe":
      baseValue = titleThe(derived.trackArtistName);
      break;
    case "trackartistcleannamethe":
      baseValue = cleanTitleThe(derived.trackArtistName);
      break;
    case "trackartistmbid":
      baseValue = derived.trackArtistMbId;
      break;
    case "trackmbid":
      baseValue = derived.trackMbId;
      break;
    case "trackid":
      baseValue = derived.trackId;
      break;

    // Video titles - all variants
    case "videotitle":
      baseValue = derived.videoTitle;
      break;
    case "videocleantitle":
      baseValue = cleanTitle(derived.videoTitle);
      break;
    case "videotitlethe":
      baseValue = titleThe(derived.videoTitle);
      break;
    case "videocleantitlethe":
      baseValue = cleanTitleThe(derived.videoTitle);
      break;
    case "videoid":
      baseValue = derived.videoId;
      break;

    // Track/Medium numbers (support format specifier)
    case "tracknumber":
    case "track":
      isNumericToken = true;
      numericValue = derived.trackNumber;
      break;
    case "volumenumber":
    case "medium":
      isNumericToken = true;
      numericValue = derived.volumeNumber;
      break;

    // Explicit markers
    case "explicit":
      return context.explicit ? "(Explicit)" : "";
    case "e":
      return context.explicit ? "[E]" : "";

    // Quality metadata
    case "quality":
      baseValue = context.quality || "";
      break;
    case "codec":
      baseValue = context.codec || "";
      break;
    case "bitrate":
      baseValue = context.bitrate ? String(context.bitrate) : "";
      break;
    case "samplerate":
      if (context.sampleRate) {
        baseValue = formatQualityValue(context.sampleRate, formatSpecifiers[0] || "");
      } else {
        baseValue = "";
      }
      break;
    case "bitdepth":
      baseValue = context.bitDepth ? String(context.bitDepth) : "";
      break;
    case "channels":
      baseValue = context.channels ? String(context.channels) : "";
      break;

    // Legacy/ignored tokens (return empty for backward compatibility)
    case "albumversion":
    case "trackversion":
      return "";

    default:
      return "";
  }

  // Handle numeric tokens with format specifier
  if (isNumericToken && numericValue !== null) {
    const format = formatSpecifiers[0] || "";
    return applyNumberFormat(numericValue, format);
  }

  // Apply format specifiers to string-based values (e.g., sampleRate:kHz)
  // then sanitize
  if (baseValue !== null) {
    // Note: Modifiers deprecated. For backward compatibility, still support a few legacy modifiers:
    // :the, :clean, :first - but new code should use named variables instead
    const legacyModifiers = formatSpecifiers.filter((m) => {
      const trimmed = m.trim();
      return trimmed === "the" || trimmed === "clean" || trimmed === "first";
    });

    let result = baseValue;
    for (const modifier of legacyModifiers) {
      const trimmed = modifier.trim();
      if (trimmed === "the") {
        result = titleThe(result);
      } else if (trimmed === "clean") {
        result = cleanTitle(result);
      } else if (trimmed === "first") {
        result = result.trim().charAt(0) || "";
      }
    }

    return sanitizeSegment(result);
  }

  return "";
}

function renderTokens(template: string, context: NamingContext): string {
  const literalPlaceholders: string[] = [];
  const withNestedTokens = (template || "").replace(/\{([^{}]+)-\{([^{}]+)\}\}/g, (_match, prefix: string, tokenBody: string) => {
    const value = resolveToken(tokenBody, context);
    const literalPrefix = sanitizeSegment(String(prefix || "").trim());
    if (!value || !literalPrefix) {
      return "";
    }

    const placeholder = `__DISCOGENIUS_LITERAL_${literalPlaceholders.length}__`;
    literalPlaceholders.push(`{${literalPrefix}-${value}}`);
    return placeholder;
  });

  const rendered = withNestedTokens
    .replace(/\{([^{}]+)\}/g, (_token, body: string) => resolveToken(body, context));

  return literalPlaceholders.reduce(
    (current, value, index) => current.replace(`__DISCOGENIUS_LITERAL_${index}__`, value),
    rendered,
  );
}

export function getNamingConfig(): NamingConfig {
  return getConfigSection("naming");
}

const KNOWN_TOKEN_NAMES = new Set([
  "artistname",
  "artistcleanname",
  "artistnamethe",
  "artistcleannamthe",
  "artistcleannamethe",
  "artistmbid",
  "artistid",
  "artistnamefirstcharacter",
  "albumtitle",
  "albumcleantitle",
  "albumtitlethe",
  "albumcleantitlethe",
  "albumtype",
  "albummbid",
  "releasegroupmbid",
  "albumid",
  "albumfulltitle",
  "releaseyear",
  "tracktitle",
  "trackcleantitle",
  "tracktitlethe",
  "trackcleantitlethe",
  "trackfulltitle",
  "trackartistname",
  "trackartistcleanname",
  "trackartistnamethe",
  "trackartistcleannamethe",
  "trackartistmbid",
  "trackmbid",
  "trackid",
  "videotitle",
  "videocleantitle",
  "videotitlethe",
  "videocleantitlethe",
  "videoid",
  "tracknumber",
  "track",
  "volumenumber",
  "medium",
  "explicit",
  "e",
  "quality",
  "codec",
  "bitrate",
  "samplerate",
  "bitdepth",
  "channels",
  "albumversion",
  "trackversion",
]);

export type NamingTemplateValidationResult = {
  valid: boolean;
  errors: string[];
  unknownTokens: string[];
  tokens: string[];
};

export type NamingPreviewResult = {
  artistFolder: string;
  standardTrack: string;
  multiDiscTrack: string;
  video: string;
};

function extractTemplateTokens(template: string): string[] {
  const tokens: string[] = [];
  for (const match of (template || "").matchAll(/\{([^{}]+)\}/g)) {
    const token = String(match[1] || "").trim();
    if (token) tokens.push(token);
  }
  return tokens;
}

function normalizeTemplateToken(token: string): string {
  return normalizeTokenName(String(token || "").split(":")[0] || "");
}

function isKnownTemplateToken(token: string): boolean {
  const normalized = normalizeTemplateToken(token);
  return KNOWN_TOKEN_NAMES.has(normalized)
    || parseLegacyPaddedToken(normalized, "tracknumber") !== null
    || parseLegacyPaddedToken(normalized, "volumenumber") !== null;
}

function hasAnyToken(tokens: string[], names: string[]): boolean {
  const normalized = new Set(tokens.map(normalizeTemplateToken));
  return names.some((name) => normalized.has(normalizeTokenName(name)));
}

function hasTrackNumberToken(tokens: string[]): boolean {
  return tokens.some((token) => {
    const normalized = normalizeTemplateToken(token);
    return normalized === "tracknumber"
      || normalized === "track"
      || parseLegacyPaddedToken(normalized, "tracknumber") !== null;
  });
}

export function validateNamingTemplate(
  template: string,
  kind: "artist_folder" | "track" | "video",
): NamingTemplateValidationResult {
  const errors: string[] = [];
  const rawTemplate = String(template || "");
  const tokens = extractTemplateTokens(rawTemplate);
  const unknownTokens = Array.from(new Set(tokens.filter((token) => !isKnownTemplateToken(token))));
  const literalTemplateText = rawTemplate.replace(/\{[^{}]*\}/g, "");

  if (!rawTemplate.trim()) {
    errors.push("Template cannot be empty.");
  }

  if (/[<>:"|?*]/.test(literalTemplateText)) {
    errors.push("Template contains characters that are not valid in file or folder names.");
  }

  if (rawTemplate.split(/[\\/]+/g).some((segment) => segment.trim() === "..")) {
    errors.push("Template cannot contain parent-directory segments.");
  }

  if (unknownTokens.length > 0) {
    errors.push(`Unknown token${unknownTokens.length === 1 ? "" : "s"}: ${unknownTokens.join(", ")}.`);
  }

  if (kind === "artist_folder" && !hasAnyToken(tokens, ["artistName", "artistCleanName", "artistNameThe", "artistCleanNameThe"])) {
    errors.push("Artist folder template must include an artist name token.");
  }

  if (kind === "track") {
    if (!hasAnyToken(tokens, ["trackTitle", "trackFullTitle", "trackCleanTitle", "trackTitleThe", "trackCleanTitleThe"])) {
      errors.push("Track template must include a track title token.");
    }
    if (!hasTrackNumberToken(tokens)) {
      errors.push("Track template must include a track number token.");
    }
  }

  if (kind === "video" && !hasAnyToken(tokens, ["videoTitle", "videoCleanTitle", "videoTitleThe", "videoCleanTitleThe", "trackId", "videoId"])) {
    errors.push("Video template must include a video title or TIDAL ID token.");
  }

  return {
    valid: errors.length === 0,
    errors,
    unknownTokens,
    tokens,
  };
}

export function validateNamingConfig(config: NamingConfig): Record<keyof NamingConfig, NamingTemplateValidationResult> {
  return {
    artist_folder: validateNamingTemplate(config.artist_folder, "artist_folder"),
    album_track_path_single: validateNamingTemplate(config.album_track_path_single, "track"),
    album_track_path_multi: validateNamingTemplate(config.album_track_path_multi, "track"),
    video_file: validateNamingTemplate(config.video_file, "video"),
  };
}

export function previewNamingConfig(config: NamingConfig): NamingPreviewResult {
  const baseContext: NamingContext = {
    artistName: "Nine Inch Nails",
    artistId: "65662",
    artistMbId: "b7ffd2af-418f-4be2-bdd1-22f8b48613da",
    albumTitle: "The Downward Spiral",
    albumVersion: "Deluxe Edition",
    albumFullTitle: "The Downward Spiral (Deluxe Edition)",
    albumType: "album",
    albumId: "77617",
    albumMbId: "81a185ad-085c-4cde-8a97-84a6f176180b",
    releaseGroupMbId: "f3fe65f9-efab-38bd-a8e8-9be4ea2e2976",
    releaseYear: "1994",
    trackTitle: "Hurt",
    trackVersion: null,
    trackFullTitle: "Hurt",
    trackArtistName: "Nine Inch Nails",
    trackArtistMbId: "b7ffd2af-418f-4be2-bdd1-22f8b48613da",
    trackMbId: "f4d1b6b1-0a1a-47f0-bf0b-fae0e5f5a5f4",
    trackId: "123456789",
    videoId: "987654321",
    trackNumber: 14,
    volumeNumber: 1,
    videoTitle: "Hurt",
    explicit: false,
    quality: "HIRES_LOSSLESS",
    codec: "FLAC",
    sampleRate: 96000,
    bitDepth: 24,
    channels: 2,
  };

  return {
    artistFolder: renderRelativePath(config.artist_folder, baseContext),
    standardTrack: `${renderRelativePath(config.album_track_path_single, baseContext)}.flac`,
    multiDiscTrack: `${renderRelativePath(config.album_track_path_multi, { ...baseContext, volumeNumber: 2, trackNumber: 3 })}.flac`,
    video: `${renderFileStem(config.video_file, baseContext)}.mp4`,
  };
}

export function renderRelativePath(template: string, context: NamingContext): string {
  const rendered = cleanupRendered(renderTokens(template, context));
  const rawSegments = rendered.split(/[\\/]+/g);

  const segments = rawSegments
    .map((segment) => cleanupRendered(segment))
    .map((segment) => sanitizeSegment(segment))
    .filter((segment) => segment.length > 0)
    .filter((segment) => segment !== "." && segment !== "..");

  return segments.length > 0 ? path.join(...segments) : "Unknown";
}

export function renderFileStem(template: string, context: NamingContext): string {
  return sanitizeSegment(cleanupRendered(renderTokens(template, context)));
}

export function getLibraryRootPath(libraryPath: string, root: LibraryRoot): string {
  return path.join(libraryPath, root);
}

/**
 * Resolve the library folder name for an artist using the active naming convention.
 * Used when an artist is first added to compute and persist `artist.path`.
 */
export function resolveArtistFolder(artistName: string, artistMbId?: string | null): string {
  const naming = getNamingConfig();
  return renderRelativePath(naming.artist_folder, { artistName, artistMbId });
}

export function resolveArtistFolderFromRecord(artist: { name: string; mbid?: string | null; path?: string | null }): string {
  const stored = String(artist.path || "").trim();
  if (stored) return stored;
  return resolveArtistFolder(artist.name, artist.mbid);
}
