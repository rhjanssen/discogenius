import path from "path";
import { getConfigSection, type NamingConfig } from "./config.js";

export type library_root = "music" | "spatial" | "videos";

export type NamingContext = {
  provider?: string | null;
  artistName: string;
  artistMbId?: string | null;
  artistDisambiguation?: string | null;

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
  recordingId?: string | null;
  recordingMbId?: string | null;
  mediaId?: string | null;
  providerMediaId?: string | null;
  trackNumber?: number | null;
  volumeNumber?: number | null;

  artistId?: string | null;
  albumId?: string | null;
  trackId?: string | null;
  videoId?: string | null;

  videoTitle?: string | null;

  // Audio quality metadata (optional, from TrackFiles)
  quality?: string | null;
  codec?: string | null;
  bitrate?: number | null;
  sampleRate?: number | null;
  bitDepth?: number | null;
  channels?: number | null;
};

const TitlePrefixRegex = /^(The|An|A)\s+(.*?)((?: *\([^)]+\))*)$/i;
const ScenifyReplaceChars = /\//g;
const ScenifyRemoveChars = /(?<=\s)([,<>/\\;:'"|`~!@$%^*_=\-?])(?=\s)|([':?,])(?=(?:[sm]\s)|\s|$)|([()[\]{}])/gi;
const FileNameCleanupRegex = /([- ._])\1+/g;
const TrimSeparatorsRegex = /[- ._]+$/;

function removeDiacritics(input: string): string {
  return (input || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

export function cleanTitle(title: string): string {
  if (!title) return "";
  let result = title.replace(/&/g, "and");
  result = result.replace(ScenifyReplaceChars, " ");
  result = result.replace(ScenifyRemoveChars, "");
  return removeDiacritics(result);
}

export function titleThe(title: string): string {
  if (!title) return "";
  return title.replace(TitlePrefixRegex, "$2, $1$3");
}

export function cleanTitleThe(title: string): string {
  if (!title) return "";
  const match = TitlePrefixRegex.exec(title);
  if (match) {
    const prefix = match[1];
    const main = match[2];
    const suffix = match[3];
    return `${cleanTitle(main).trim()}, ${prefix}${cleanTitle(suffix)}`;
  }
  return cleanTitle(title);
}

export function cleanFileName(name: string): string {
  let result = name;
  result = result.replace(/: /g, " - ");
  result = result.replace(/:/g, "-");
  result = result.replace(/\\/g, "+");
  result = result.replace(/\//g, "+");
  result = result.replace(/</g, "");
  result = result.replace(/>/g, "");
  result = result.replace(/\?/g, "!");
  result = result.replace(/\*/g, "-");
  result = result.replace(/\|/g, "");
  result = result.replace(/"/g, "");
  return result.trimStart().replace(/^[. ]+/, "").trimEnd();
}

export function cleanPathSegment(segment: string): string {
  let result = cleanFileName(segment);
  result = result.replace(FileNameCleanupRegex, (match) => match[0]);
  result = result.replace(TrimSeparatorsRegex, "");
  return result.trimStart().replace(/^[. ]+/, "").trimEnd();
}

function toCleanText(input: string): string {
  return cleanTitle(input);
}

function toNameThe(input: string): string {
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

function getPrettyProviderName(provider: string | null | undefined): string {
  const lower = (provider || "tidal").trim().toLowerCase();
  if (lower === "tidal") return "TIDAL";
  if (lower === "apple" || lower === "apple-music" || lower === "applemusic") return "Apple Music";
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function buildDerived(context: NamingContext) {
  const artistName = context.artistName || "Unknown Artist";
  const artistId = context.artistId || "";
  const artistMbId = context.artistMbId || "";
  const artistDisambiguation = context.artistDisambiguation || "";

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
  const mediaId = context.mediaId || context.providerMediaId || trackId || videoId || "";
  const recordingId = context.recordingId || "";
  const recordingMbId = context.recordingMbId || trackMbId || "";

  const providerName = getPrettyProviderName(context.provider);
  const providerArtistId = context.artistId || "";
  const providerAlbumId = context.albumId || "";
  const providerTrackId = context.providerMediaId || context.mediaId || context.trackId || context.videoId || "";

  return {
    artistName,
    artistMbId,
    artistDisambiguation,
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
    recordingId,
    recordingMbId,
    mediaId,
    trackVersion,
    trackFullTitle,
    trackNumber,
    volumeNumber,
    videoTitle,
    trackId,
    videoId,
    providerName,
    providerArtistId,
    providerAlbumId,
    providerTrackId,
    providerMediaId: providerTrackId,
  };
}

function resolveTokenValue(tokenName: string, customFormat: string, context: NamingContext): string {
  const derived = buildDerived(context);
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
    case "artistdisambiguation":
      baseValue = derived.artistDisambiguation;
      break;
    case "artistid":
      baseValue = derived.artistId;
      break;
    case "providername":
      baseValue = derived.providerName;
      break;
    case "providerartistid":
      baseValue = derived.providerArtistId;
      break;
    case "artistnamefirstcharacter": {
      const theArtistName = titleThe(derived.artistName);
      if (theArtistName.length === 0) {
        baseValue = "_";
        break;
      }
      const normalized = removeDiacritics(theArtistName);
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
    case "provideralbumid":
      baseValue = derived.providerAlbumId;
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
    case "recordingid":
      baseValue = derived.recordingId;
      break;
    case "recordingmbid":
      baseValue = derived.recordingMbId;
      break;
    case "mediaid":
      baseValue = derived.mediaId;
      break;
    case "trackid":
      baseValue = derived.trackId;
      break;
    case "providertrackid":
      baseValue = derived.providerTrackId;
      break;
    case "providermediaid":
      baseValue = derived.providerMediaId;
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
    case "providervideoid":
      baseValue = derived.providerTrackId;
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
        baseValue = formatQualityValue(context.sampleRate, customFormat);
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
    return applyNumberFormat(numericValue, customFormat);
  }

  return baseValue || "";
}

function resolveToken(rawTokenBody: string, context: NamingContext): string {
  const parts = rawTokenBody.split(":");
  const tokenName = parts[0];
  const customFormat = parts.slice(1).join(":") || "";

  const hasLetters = /[a-zA-Z]/.test(tokenName);
  const isAllLowercase = hasLetters && tokenName === tokenName.toLowerCase();
  const isAllUppercase = hasLetters && tokenName === tokenName.toUpperCase();

  let result = resolveTokenValue(tokenName, customFormat, context);

  // Apply legacy modifiers (deprecated, e.g. :the, :clean)
  const formatSpecifiers = parts.slice(1);
  const legacyModifiers = formatSpecifiers.filter((m) => {
    const trimmed = m.trim();
    return trimmed === "the" || trimmed === "clean" || trimmed === "first";
  });

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

  if (isAllLowercase) {
    result = result.toLowerCase();
  } else if (isAllUppercase) {
    result = result.toUpperCase();
  }

  return cleanFileName(result);
}

function renderTokens(template: string, context: NamingContext): string {
  const literalPlaceholders: string[] = [];
  let processedTemplate = (template || "");

  // 1. Handle new double-bracket nested style: {{token1}-{token2}} -> e.g. {{providerName}-{providerAlbumId}}
  processedTemplate = processedTemplate.replace(/\{\{([^{}]+)\}-\{([^{}]+)\}\}/g, (_match, token1: string, token2: string) => {
    const val1 = resolveToken(token1, context);
    const val2Raw = resolveToken(token2, context);
    if (!val1 || !val2Raw) {
      return "";
    }
    const parts = val2Raw.split(";").map(p => p.trim()).filter(Boolean);
    if (parts.length === 0) return "";
    const combinedIds = parts.join("; ");
    const placeholder = `__DISCOGENIUS_LITERAL_${literalPlaceholders.length}__`;
    literalPlaceholders.push(`{${val1}-${combinedIds}}`);
    return placeholder;
  });

  // 2. Handle legacy single-bracket nested style: {prefix-{token}} -> e.g. {tidal-{videoId}}
  processedTemplate = processedTemplate.replace(/\{([^{}]+)-\{([^{}]+)\}\}/g, (_match, prefix: string, tokenBody: string) => {
    const val2Raw = resolveToken(tokenBody, context);
    const literalPrefix = cleanFileName(String(prefix || "").trim());
    if (!val2Raw || !literalPrefix) {
      return "";
    }
    const parts = val2Raw.split(";").map(p => p.trim()).filter(Boolean);
    if (parts.length === 0) return "";
    const combinedIds = parts.join("; ");
    const placeholder = `__DISCOGENIUS_LITERAL_${literalPlaceholders.length}__`;
    literalPlaceholders.push(`{${literalPrefix}-${combinedIds}}`);
    return placeholder;
  });

  // 3. Align with Lidarr's TitleRegex and ReplaceToken behavior (allowing colons in customFormat)
  const TitleRegex = /(\{\{|\}\})|\{([- ._[(]*)([a-zA-Z0-9]+(?:[- ._]+[a-zA-Z0-9]+)?)(?::([ a-zA-Z0-9+-:]+(?<![- ])))?([- ._)\]]*)\}/g;

  const rendered = processedTemplate.replace(TitleRegex, (
    match: string,
    escaped: string | undefined,
    prefix: string | undefined,
    token: string | undefined,
    customFormat: string | undefined,
    suffix: string | undefined,
  ) => {
    if (escaped) {
      if (escaped === "{{") return "{";
      if (escaped === "}}") return "}";
      return escaped;
    }

    const tokenName = token || "";
    const customFormatVal = customFormat || "";
    const prefixVal = prefix || "";
    const suffixVal = suffix || "";

    const separatorMatch = /[- ._]/.exec(tokenName);
    const separator = separatorMatch ? separatorMatch[0] : "";

    const formatSpecifiers = customFormatVal.split(":");
    const primaryFormat = formatSpecifiers[0] || "";

    let replacementText = resolveTokenValue(tokenName, primaryFormat, context);

    if (replacementText === null || replacementText === undefined) {
      return match;
    }

    // Apply legacy modifiers (deprecated, e.g. :the, :clean, :first)
    const legacyModifiers = formatSpecifiers.filter((m) => {
      const trimmed = m.trim();
      return trimmed === "the" || trimmed === "clean" || trimmed === "first";
    });

    for (const modifier of legacyModifiers) {
      const trimmed = modifier.trim();
      if (trimmed === "the") {
        replacementText = titleThe(replacementText);
      } else if (trimmed === "clean") {
        replacementText = cleanTitle(replacementText);
      } else if (trimmed === "first") {
        replacementText = replacementText.trim().charAt(0) || "";
      }
    }

    replacementText = replacementText.trim();

    const letters = tokenName.replace(/[^a-zA-Z]/g, "");
    const isAllLowercase = letters.length > 0 && letters === letters.toLowerCase();
    const isAllUppercase = letters.length > 0 && letters === letters.toUpperCase();

    if (isAllLowercase) {
      replacementText = replacementText.toLowerCase();
    } else if (isAllUppercase) {
      replacementText = replacementText.toUpperCase();
    }

    if (separator) {
      replacementText = replacementText.replace(/ /g, separator);
    }

    replacementText = cleanFileName(replacementText);

    if (replacementText.length > 0) {
      return prefixVal + replacementText + suffixVal;
    }

    return "";
  });

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
  "artistdisambiguation",
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
  "recordingid",
  "recordingmbid",
  "mediaid",
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
  "providername",
  "providerartistid",
  "provideralbumid",
  "providertrackid",
  "providervideoid",
  "providermediaid",
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

  if (kind === "video" && !hasAnyToken(tokens, ["videoTitle", "videoCleanTitle", "videoTitleThe", "videoCleanTitleThe", "mediaId", "trackId", "videoId", "providerMediaId", "providerTrackId", "providerVideoId"])) {
    errors.push("Video template must include a video title or provider track/video ID token.");
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
    provider: "tidal",
    artistName: "Bastille",
    artistId: "4031487",
    artistMbId: "7808accb-6395-4b25-858c-678bbb73896b",
    artistDisambiguation: "English pop rock band",
    albumTitle: "Bad Blood",
    albumVersion: "The Extended Cut",
    albumFullTitle: "Bad Blood (The Extended Cut)",
    albumType: "album",
    albumId: "26065586",
    albumMbId: "a1a8c886-df06-44ec-b851-f76156a086cf",
    releaseGroupMbId: "5b591b9a-4c28-444a-aab4-cd61be5bb5fb",
    releaseYear: "2013",
    trackTitle: "Pompeii",
    trackVersion: null,
    trackFullTitle: "Pompeii",
    trackArtistName: "Bastille",
    trackArtistMbId: "7808accb-6395-4b25-858c-678bbb73896b",
    trackMbId: "a3a1f1a5-817e-40af-b98a-d5f9b4515ed0",
    recordingId: "26065587",
    recordingMbId: "a3a1f1a5-817e-40af-b98a-d5f9b4515ed0",
    mediaId: "26065587",
    providerMediaId: "26065587",
    trackId: "26065587",
    videoId: "26065587",
    trackNumber: 1,
    volumeNumber: 1,
    videoTitle: "Pompeii",
    explicit: false,
    quality: "LOSSLESS",
    codec: "FLAC",
    sampleRate: 44100,
    bitDepth: 16,
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
    .map((segment) => cleanPathSegment(segment))
    .filter((segment) => segment.length > 0)
    .filter((segment) => segment !== "." && segment !== "..");

  return segments.length > 0 ? path.join(...segments) : "Unknown";
}

export function renderFileStem(template: string, context: NamingContext): string {
  return cleanPathSegment(cleanupRendered(renderTokens(template, context)));
}

export function getLibraryRootPath(libraryPath: string, root: library_root): string {
  return path.join(libraryPath, root);
}

/**
 * Resolve the library folder name for an artist using the active naming convention.
 * Used when an artist is first added to compute and persist `artist.path`.
 */
export function resolveArtistFolder(
  artistName: string,
  artistMbId?: string | null,
  artistDisambiguation?: string | null,
): string {
  const naming = getNamingConfig();
  return renderRelativePath(naming.artist_folder, { artistName, artistMbId, artistDisambiguation });
}

export function resolveArtistFolderFromRecord(artist: { name: string; mbid?: string | null; disambiguation?: string | null; path?: string | null }): string {
  const stored = String(artist.path || "").trim();
  if (stored) return stored;
  return resolveArtistFolder(artist.name, artist.mbid, artist.disambiguation);
}
