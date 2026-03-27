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
  releaseYear?: string | null;
  explicit?: boolean | null;

  trackTitle?: string | null;
  trackVersion?: string | null;
  trackFullTitle?: string | null;
  trackArtistName?: string | null;
  trackArtistMbId?: string | null;
  trackNumber?: number | null;
  volumeNumber?: number | null;

  artistId?: string | null;
  albumId?: string | null;
  trackId?: string | null;

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
  const trackFullTitle =
    context.trackFullTitle ||
    (trackVersion && !trackTitle.toLowerCase().includes(trackVersion.toLowerCase())
      ? `${trackTitle} (${trackVersion})`
      : trackTitle);

  const trackNumber = Number(context.trackNumber || 0);
  const volumeNumber = Number(context.volumeNumber || 1);

  const releaseYear = (context.releaseYear ? String(context.releaseYear) : "").toString();
  const videoTitle = context.videoTitle || "Unknown Video";
  const trackId = context.trackId || "";

  return {
    artistName,
    artistMbId,
    artistId,
    albumTitle,
    albumId,
    albumType,
    albumMbId,
    albumVersion,
    albumFullTitle,
    releaseYear,
    trackTitle,
    trackArtistName,
    trackArtistMbId,
    trackVersion,
    trackFullTitle,
    trackNumber,
    volumeNumber,
    videoTitle,
    trackId,
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
  return (template || "").replace(/\{([^{}]+)\}/g, (_token, body: string) => resolveToken(body, context));
}

export function getNamingConfig(): NamingConfig {
  return getConfigSection("naming");
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

/**
 * Resolve a unique artist folder name, disambiguating if needed.
 * Mirrors Lidarr's SetPropertiesAndValidate disambiguation logic.
 * @param pathExists - function that checks if an artist.path already exists in DB
 */
export function resolveUniqueArtistFolder(
  artistName: string,
  artistId?: number | string | null,
  artistMbId?: string | null,
  pathExists?: (path: string) => boolean
): string {
  const basePath = resolveArtistFolder(artistName, artistMbId);

  if (!pathExists || !pathExists(basePath)) {
    return basePath;
  }

  // Try disambiguation with TIDAL artist ID (like Lidarr uses MusicBrainz disambiguation)
  if (artistId) {
    const disambiguated = `${basePath} (${artistId})`;
    if (!pathExists(disambiguated)) {
      return disambiguated;
    }
  }

  // Fall back to numeric suffix (like Lidarr's numeric fallback)
  let i = 1;
  let candidate: string;
  do {
    candidate = `${basePath} (${i})`;
    i++;
  } while (pathExists(candidate) && i < 100);

  return candidate;
}

export function resolveArtistFolderFromRecord(artist: { name: string; mbid?: string | null; path?: string | null }): string {
  const stored = String(artist.path || "").trim();
  if (stored) return stored;
  return resolveArtistFolder(artist.name, artist.mbid);
}
