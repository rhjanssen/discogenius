import path from "path";
import { getConfigSection, type NamingConfig } from "./config.js";
import { streamingProviderManager } from "../providers/index.js";

export type library_root = "music" | "spatial" | "videos";

export type NamingContext = {
  provider?: string | null;
  artistName: string;
  artistMbId?: string | null;
  artistDisambiguation?: string | null;
  artistGenre?: string | null;

  /** MusicBrainz release-group (album) title. */
  albumTitle?: string | null;
  albumType?: string | null;
  albumMbId?: string | null;
  /** MusicBrainz release-group disambiguation. */
  albumDisambiguation?: string | null;
  albumGenre?: string | null;
  /**
   * MusicBrainz release (edition) title. Falls back to albumTitle when unset.
   * Prefer this for folder names when editions differ (deluxe, Track by Track, …).
   */
  editionTitle?: string | null;
  /** MusicBrainz release (edition) disambiguation. */
  editionDisambiguation?: string | null;
  releaseGroupMbId?: string | null;
  releaseYear?: string | number | null;
  albumYear?: string | number | null;
  editionYear?: string | number | null;
  mediumName?: string | null;
  mediumFormat?: string | null;
  originalTitle?: string | null;
  originalFileName?: string | null;
  releaseGroup?: string | null;
  explicit?: boolean | null;

  trackTitle?: string | null;
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
  /** Plex extras type suffix including the leading hyphen (e.g. "-video", "-lyrics"). */
  videoType?: string | null;

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
// Windows-reserved device names break the filesystem when followed by an
// extension (e.g. "con.flac"). Matches the FileNameBuilder behavior:
// only fires when the reserved word is immediately followed by a dot, so it
// never mangles unrelated names like "Console" or "Prince".
const ReservedDeviceNameRegex = /^(?:aux|com[1-9]|con|lpt[1-9]|nul|prn)\./i;

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
  result = result.trimStart().replace(/^[. ]+/, "").trimEnd();
  return result.replace(ReservedDeviceNameRegex, (match) => `${match.slice(0, -1)}_.`);
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

/** Resolve `{Provider Name}` from the registered provider, not a hardcoded map. */
export function getPrettyProviderName(provider: string | null | undefined): string {
  return streamingProviderManager.getProviderDisplayName(provider);
}

function buildDerived(context: NamingContext) {
  const artistName = context.artistName || "Unknown Artist";
  const artistId = context.artistId || "";
  const artistMbId = context.artistMbId || "";
  const artistDisambiguation = context.artistDisambiguation || "";
  const artistGenre = context.artistGenre || "";

  const albumTitle = context.albumTitle || "Unknown Album";
  const albumId = context.albumId || "";
  const albumType = context.albumType || "";
  const albumMbId = context.albumMbId || "";
  const albumDisambiguation = context.albumDisambiguation || "";
  const albumGenre = context.albumGenre || "";
  // Edition title falls back to the release-group title so templates using
  // {Edition Title} still work when only the album title is known.
  const editionTitle = String(context.editionTitle || "").trim() || albumTitle;
  const editionDisambiguation = context.editionDisambiguation || "";
  const releaseGroupMbId = context.releaseGroupMbId || "";

  const trackTitle = context.trackTitle || "Unknown Track";
  const trackArtistName = context.trackArtistName || artistName;
  const trackArtistMbId = context.trackArtistMbId || artistMbId;
  const trackMbId = context.trackMbId || "";

  const trackNumber = Number(context.trackNumber || 0);
  const volumeNumber = Number(context.volumeNumber || 1);

  const albumYear = (context.albumYear ? String(context.albumYear) : "").toString();
  const editionYear = (context.editionYear ? String(context.editionYear) : "").toString();
  const releaseYear = (context.releaseYear ? String(context.releaseYear) : (editionYear || albumYear)).toString();
  const resolvedAlbumYear = albumYear || releaseYear;
  const resolvedEditionYear = editionYear || releaseYear;
  const mediumName = context.mediumName || "";
  const mediumFormat = context.mediumFormat || "";
  const originalTitle = context.originalTitle || "";
  const originalFileName = context.originalFileName || "";
  const releaseGroup = context.releaseGroup || "";
  const videoTitle = context.videoTitle || "Unknown Video";
  const rawVideoType = String(context.videoType || "").trim();
  const videoType = rawVideoType
    ? (rawVideoType.startsWith("-") ? rawVideoType : `-${rawVideoType}`)
    : "-video";
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
    artistGenre,
    artistId,
    albumTitle,
    albumId,
    albumType,
    albumMbId,
    albumDisambiguation,
    albumGenre,
    editionTitle,
    editionDisambiguation,
    releaseGroupMbId,
    releaseYear,
    albumYear: resolvedAlbumYear,
    editionYear: resolvedEditionYear,
    mediumName,
    mediumFormat,
    originalTitle,
    originalFileName,
    releaseGroup,
    trackTitle,
    trackArtistName,
    trackArtistMbId,
    trackMbId,
    recordingId,
    recordingMbId,
    mediaId,
    trackNumber,
    volumeNumber,
    videoTitle,
    videoType,
    trackId,
    videoId,
    providerName,
    providerArtistId,
    providerAlbumId,
    providerTrackId,
    providerMediaId: providerTrackId,
  };
}

type DerivedNamingContext = ReturnType<typeof buildDerived>;

function resolveTokenValue(
  tokenName: string,
  customFormat: string,
  context: NamingContext,
  derived: DerivedNamingContext,
  normalizedName = normalizeTokenName(tokenName),
): string {

  let baseValue: string | null = null;
  let isNumericToken = false;
  let numericValue: number | null = null;
  let numericFormat = customFormat;

  const trackNumberMatch = normalizedName.match(/^(?:tracknumber|track)(0+)$/);
  if (trackNumberMatch) {
    isNumericToken = true;
    numericValue = derived.trackNumber;
    numericFormat = trackNumberMatch[1];
  }

  const volumeNumberMatch = normalizedName.match(/^(?:volumenumber|medium)(0+)$/);
  if (!isNumericToken && volumeNumberMatch) {
    isNumericToken = true;
    numericValue = derived.volumeNumber;
    numericFormat = volumeNumberMatch[1];
  }

  switch (isNumericToken ? "__numeric_suffix__" : normalizedName) {
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
    case "artistgenre":
      baseValue = derived.artistGenre;
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

    // Album titles - all variants (MusicBrainz release-group)
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
    case "albumdisambiguation":
      baseValue = derived.albumDisambiguation;
      break;
    case "albumgenre":
      baseValue = derived.albumGenre;
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
    case "releaseyear":
    case "editionyear":
      baseValue = derived.releaseYear;
      break;
    case "albumyear":
    case "albumreleaseyear":
    case "originalyear":
    case "originalreleaseyear":
      baseValue = derived.albumYear;
      break;

    // Edition / release titles (MusicBrainz release — one specific product)
    case "editiontitle":
    case "releasetitle":
      baseValue = derived.editionTitle;
      break;
    case "editioncleantitle":
    case "releasecleantitle":
      baseValue = cleanTitle(derived.editionTitle);
      break;
    case "editiontitlethe":
    case "releasetitlethe":
      baseValue = titleThe(derived.editionTitle);
      break;
    case "editioncleantitlethe":
    case "releasecleantitlethe":
      baseValue = cleanTitleThe(derived.editionTitle);
      break;
    case "editiondisambiguation":
    case "releasedisambiguation":
      baseValue = derived.editionDisambiguation;
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
    case "videotype":
      baseValue = derived.videoType;
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

    case "mediumname":
      baseValue = derived.mediumName;
      break;
    case "mediumformat":
      baseValue = derived.mediumFormat;
      break;

    // Original file / scene tokens (Lidarr alignment)
    case "originaltitle":
      baseValue = derived.originalTitle;
      break;
    case "originalfilename":
      baseValue = derived.originalFileName;
      break;
    case "releasegroup":
      baseValue = derived.releaseGroup;
      break;

    // Quality metadata (including Lidarr aliases)
    case "quality":
    case "qualityfull":
    case "qualitytitle":
    case "qualityproper":
      baseValue = context.quality || "";
      break;
    case "codec":
    case "mediainfoaudiocodec":
      baseValue = context.codec || "";
      break;
    case "bitrate":
      baseValue = context.bitrate ? String(context.bitrate) : "";
      break;
    case "mediainfoaudiobitrate":
      baseValue = context.bitrate ? `${context.bitrate} kbps` : "";
      break;
    case "samplerate":
      if (context.sampleRate) {
        baseValue = formatQualityValue(context.sampleRate, customFormat);
      } else {
        baseValue = "";
      }
      break;
    case "mediainfoaudiosamplerate":
      baseValue = context.sampleRate ? `${(context.sampleRate / 1000).toFixed(1).replace(/\.0$/, "")}kHz` : "";
      break;
    case "bitdepth":
      baseValue = context.bitDepth ? String(context.bitDepth) : "";
      break;
    case "mediainfoaudiobitspersample":
      baseValue = context.bitDepth ? `${context.bitDepth}bit` : "";
      break;
    case "channels":
      baseValue = context.channels ? String(context.channels) : "";
      break;
    case "mediainfoaudiochannels":
      baseValue = context.channels
        ? (typeof context.channels === "number" && !String(context.channels).includes(".")
          ? `${context.channels}.0`
          : String(context.channels))
        : "";
      break;
    case "__numeric_suffix__":
      break;

    default:
      return "";
  }

  // Handle numeric tokens with format specifier
  if (isNumericToken && numericValue !== null) {
    return applyNumberFormat(numericValue, numericFormat);
  }

  return baseValue || "";
}

type TokenLetterCase = "lower" | "upper" | null;

type CompiledTokenExpression = {
  tokenName: string;
  normalizedName: string;
  customFormat: string;
  letterCase: TokenLetterCase;
};

type CompiledNamingNode =
  | { kind: "text"; value: string }
  | {
      kind: "token";
      expression: CompiledTokenExpression;
      prefix: string;
      suffix: string;
      separator: string;
    }
  | {
      kind: "provider-wrapper";
      provider: CompiledTokenExpression;
      providerIds: CompiledTokenExpression;
    }
  | { kind: "mbid-wrapper"; value: CompiledTokenExpression };

type CompiledNamingTemplate = {
  nodes: CompiledNamingNode[];
};

const NAMING_TEMPLATE_CACHE_LIMIT = 128;
const namingTemplatePlanCache = new Map<string, CompiledNamingTemplate>();
const SpecialMarkerRegex = /\uE000DISCOGENIUS_SPECIAL_(\d+)\uE000/g;
const TitleTokenRegex = /(\{\{|\}\})|\{([- ._[(]*)([a-zA-Z0-9]+(?:[- ._]+[a-zA-Z0-9]+)?)(?::([ a-zA-Z0-9+-:]+(?<![- ])))?([- ._)\]]*)\}/g;

function getTokenLetterCase(tokenName: string): TokenLetterCase {
  const letters = tokenName.replace(/[^a-zA-Z]/g, "");
  if (letters.length === 0) return null;
  if (letters === letters.toLowerCase()) return "lower";
  if (letters === letters.toUpperCase()) return "upper";
  return null;
}

function compileTokenExpression(tokenName: string, customFormat = ""): CompiledTokenExpression {
  return {
    tokenName,
    normalizedName: normalizeTokenName(tokenName),
    customFormat,
    letterCase: getTokenLetterCase(tokenName),
  };
}

function compileRawTokenExpression(rawTokenBody: string): CompiledTokenExpression {
  const parts = rawTokenBody.split(":");
  return compileTokenExpression(parts[0] || "", parts.slice(1).join(":") || "");
}

function appendCompiledText(
  nodes: CompiledNamingNode[],
  value: string,
  specialNodes: CompiledNamingNode[],
): void {
  if (!value) return;

  let lastIndex = 0;
  SpecialMarkerRegex.lastIndex = 0;
  for (const match of value.matchAll(SpecialMarkerRegex)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      nodes.push({ kind: "text", value: value.slice(lastIndex, index) });
    }
    const specialIndex = Number(match[1]);
    const special = specialNodes[specialIndex];
    if (special) nodes.push(special);
    lastIndex = index + match[0].length;
  }
  if (lastIndex < value.length) {
    nodes.push({ kind: "text", value: value.slice(lastIndex) });
  }
}

function compileNamingTemplate(template: string): CompiledNamingTemplate {
  const specialNodes: CompiledNamingNode[] = [];
  let processedTemplate = String(template || "");

  // Compile conditional provider wrappers once. At render time only the two
  // token values change; no nested-token regex work is repeated per track.
  processedTemplate = processedTemplate.replace(
    /\{\{([^{}]+)\}-\{([^{}]+)\}\}/g,
    (_match, providerToken: string, providerIdsToken: string) => {
      const index = specialNodes.push({
        kind: "provider-wrapper",
        provider: compileRawTokenExpression(providerToken),
        providerIds: compileRawTokenExpression(providerIdsToken),
      }) - 1;
      return `\uE000DISCOGENIUS_SPECIAL_${index}\uE000`;
    },
  );

  // Preserve the legacy conditional MusicBrainz wrapper as a compiled node.
  processedTemplate = processedTemplate.replace(
    /\{mbid-\{([^{}]+)\}\}/gi,
    (_match, token: string) => {
      const index = specialNodes.push({
        kind: "mbid-wrapper",
        value: compileRawTokenExpression(token),
      }) - 1;
      return `\uE000DISCOGENIUS_SPECIAL_${index}\uE000`;
    },
  );

  const nodes: CompiledNamingNode[] = [];
  let lastIndex = 0;
  TitleTokenRegex.lastIndex = 0;
  for (const match of processedTemplate.matchAll(TitleTokenRegex)) {
    const index = match.index ?? 0;
    appendCompiledText(nodes, processedTemplate.slice(lastIndex, index), specialNodes);

    const escaped = match[1];
    if (escaped) {
      nodes.push({ kind: "text", value: escaped === "{{" ? "{" : escaped === "}}" ? "}" : escaped });
    } else {
      const tokenName = match[3] || "";
      const customFormat = (match[4] || "").split(":")[0] || "";
      nodes.push({
        kind: "token",
        expression: compileTokenExpression(tokenName, customFormat),
        prefix: match[2] || "",
        suffix: match[5] || "",
        separator: /[- ._]/.exec(tokenName)?.[0] || "",
      });
    }
    lastIndex = index + match[0].length;
  }
  appendCompiledText(nodes, processedTemplate.slice(lastIndex), specialNodes);
  return { nodes };
}

function getCompiledNamingTemplate(template: string): CompiledNamingTemplate {
  const key = String(template || "");
  const cached = namingTemplatePlanCache.get(key);
  if (cached) return cached;

  const compiled = compileNamingTemplate(key);
  if (namingTemplatePlanCache.size >= NAMING_TEMPLATE_CACHE_LIMIT) {
    const oldest = namingTemplatePlanCache.keys().next().value as string | undefined;
    if (oldest !== undefined) namingTemplatePlanCache.delete(oldest);
  }
  namingTemplatePlanCache.set(key, compiled);
  return compiled;
}

function renderCompiledToken(
  expression: CompiledTokenExpression,
  context: NamingContext,
  derived: DerivedNamingContext,
  separator = "",
): string {
  let result = resolveTokenValue(
    expression.tokenName,
    expression.customFormat,
    context,
    derived,
    expression.normalizedName,
  ).trim();

  if (expression.letterCase === "lower") {
    result = result.toLowerCase();
  } else if (expression.letterCase === "upper") {
    result = result.toUpperCase();
  }
  if (separator) {
    result = result.replace(/ /g, separator);
  }
  return cleanFileName(result);
}

function renderTokens(template: string, context: NamingContext): string {
  const derived = buildDerived(context);
  const plan = getCompiledNamingTemplate(template);
  let rendered = "";

  for (const node of plan.nodes) {
    if (node.kind === "text") {
      rendered += node.value;
      continue;
    }
    if (node.kind === "provider-wrapper") {
      const provider = renderCompiledToken(node.provider, context, derived);
      const rawProviderIds = renderCompiledToken(node.providerIds, context, derived);
      const providerIds = rawProviderIds.split(";").map((part) => part.trim()).filter(Boolean);
      if (provider && providerIds.length > 0) {
        rendered += `{${provider}-${providerIds.join("; ")}}`;
      }
      continue;
    }
    if (node.kind === "mbid-wrapper") {
      const value = renderCompiledToken(node.value, context, derived);
      if (value) rendered += `{mbid-${value}}`;
      continue;
    }

    const replacement = renderCompiledToken(node.expression, context, derived, node.separator);
    if (replacement) {
      rendered += node.prefix + replacement + node.suffix;
    }
  }

  return rendered;
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
  "artistgenre",
  "artistid",
  "artistnamefirstcharacter",
  "albumtitle",
  "albumcleantitle",
  "albumtitlethe",
  "albumcleantitlethe",
  "albumtype",
  "albumdisambiguation",
  "albumgenre",
  "albummbid",
  "releasegroupmbid",
  "albumid",
  "releaseyear",
  "albumyear",
  "albumreleaseyear",
  "originalyear",
  "originalreleaseyear",
  "editionyear",
  "mediumname",
  "mediumformat",
  "originaltitle",
  "originalfilename",
  "releasegroup",
  "editiontitle",
  "editioncleantitle",
  "editiontitlethe",
  "editioncleantitlethe",
  "editiondisambiguation",
  "releasetitle",
  "releasecleantitle",
  "releasetitlethe",
  "releasecleantitlethe",
  "releasedisambiguation",
  "tracktitle",
  "trackcleantitle",
  "tracktitlethe",
  "trackcleantitlethe",
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
  "videotype",
  "tracknumber",
  "track",
  "volumenumber",
  "medium",
  "explicit",
  "e",
  "quality",
  "qualityfull",
  "qualitytitle",
  "qualityproper",
  "codec",
  "mediainfoaudiocodec",
  "bitrate",
  "mediainfoaudiobitrate",
  "samplerate",
  "mediainfoaudiosamplerate",
  "bitdepth",
  "mediainfoaudiobitspersample",
  "channels",
  "mediainfoaudiochannels",
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
  return KNOWN_TOKEN_NAMES.has(normalized);
}

function hasAnyToken(tokens: string[], names: string[]): boolean {
  const normalized = new Set(tokens.map(normalizeTemplateToken));
  return names.some((name) => normalized.has(normalizeTokenName(name)));
}

function hasTrackNumberToken(tokens: string[]): boolean {
  return tokens.some((token) => {
    const normalized = normalizeTemplateToken(token);
    return normalized === "tracknumber" || normalized === "track";
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
    if (!hasAnyToken(tokens, ["trackTitle", "trackCleanTitle", "trackTitleThe", "trackCleanTitleThe"])) {
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
    artistGenre: "Alternative Rock",
    albumTitle: "Bad Blood",
    albumType: "album",
    albumId: "26065586",
    albumMbId: "a1a8c886-df06-44ec-b851-f76156a086cf",
    albumDisambiguation: "extended cut",
    albumGenre: "Pop Rock",
    editionTitle: "Bad Blood",
    editionDisambiguation: "deluxe edition",
    releaseGroupMbId: "5b591b9a-4c28-444a-aab4-cd61be5bb5fb",
    releaseYear: "2013",
    albumYear: "2013",
    editionYear: "2013",
    trackTitle: "Pompeii",
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
    videoTitle: "Pompeii (Live At The O2)",
    videoType: "-video",
    explicit: false,
    quality: "LOSSLESS",
    codec: "FLAC",
    bitrate: 320,
    sampleRate: 44100,
    bitDepth: 16,
    channels: 2,
    mediumName: "Disc 1",
    mediumFormat: "CD",
    releaseGroup: "FLAC-GRP",
    originalTitle: "Bastille - Bad Blood - 01 - Pompeii",
    originalFileName: "01 - Pompeii",
  };

  // Previews are display strings: always use forward slashes regardless of
  // the server platform so examples don't mix path separators on Windows.
  const displayPath = (value: string) => value.replace(/\\/g, "/");

  return {
    artistFolder: displayPath(renderRelativePath(config.artist_folder, baseContext)),
    standardTrack: `${displayPath(renderRelativePath(config.album_track_path_single, baseContext))}.flac`,
    multiDiscTrack: `${displayPath(renderRelativePath(config.album_track_path_multi, { ...baseContext, volumeNumber: 2, trackNumber: 3 }))}.flac`,
    video: `${displayPath(renderFileStem(config.video_file, baseContext))}.mp4`,
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
