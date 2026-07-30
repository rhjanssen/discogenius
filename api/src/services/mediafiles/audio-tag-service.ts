import fs from "fs";
import os from "node:os";
import path from "node:path";
import * as mm from "music-metadata";
import pLimit from "p-limit";
import { db } from "../../database.js";
import { type MetadataConfig, type WriteAudioTagsPolicy, getConfigSection } from "../config/config.js";
import { embedAudioCover, compareEmbeddedAudioCover, type CoverImageInfo, type EmbeddedCoverComparison, writeMetadata, removeAllTags } from "./audioUtils.js";
import {
  type AcoustIdLookupResult,
  type MusicBrainzRecording,
  type MusicBrainzRelease,
  generateFingerprint,
  lookupAcoustIdMatches,
  lookupMusicBrainzRecording,
  lookupMusicBrainzRecordingsByIsrc,
  lookupMusicBrainzReleasesByBarcode,
} from "./fingerprint.js";
import { normalizeComparableText, stringSimilarity } from "./import-matching-utils.js";
import { shouldReapplyArtistPathTemplate } from "../music/artist-paths.js";
import { resolveStoredLibraryPath } from "./library-paths.js";
import { MoveArtistService } from "./move-artist-service.js";
import { buildStreamingMediaUrl } from "../download/download-routing.js";
import { getLyricsForProviderMedia, type ResolvedLyrics } from "../extras/lyrics/lyric-service.js";
import { cleanProviderText } from "./metadata-files.js";
import { providerMediaLyricsKey } from "./track-lyrics-materializer.js";
import { classifyLyricsForSidecar } from "../extras/lyrics/lyric-sidecar.js";

export type ManagedTag = {
  key: string;
  label: string;
  ffmpegKey: string;
  targetValue: string;
  aliases?: string[];
  writeAliases?: string[];
};

export function selectEmbeddedLyricsText(lyrics: { subtitles?: string | null; text?: string | null } | null | undefined): string {
  return classifyLyricsForSidecar(lyrics)?.content || "";
}

export function buildEmbeddedLyricsManagedTag(
  lyrics: { subtitles?: string | null; text?: string | null } | null | undefined,
): ManagedTag | null {
  const targetValue = selectEmbeddedLyricsText(lyrics);
  return targetValue ? {
    key: "lyrics",
    label: "Lyrics",
    ffmpegKey: "lyrics-eng",
    targetValue,
    aliases: ["lyrics", "LYRICS", "unsyncedlyrics"],
  } : null;
}

export function buildFullTitle(title: string | null | undefined, version: string | null | undefined): string {
  const baseTitle = String(title || "").trim() || "Unknown Track";
  const normalizedVersion = String(version || "").trim();

  if (!normalizedVersion) {
    return baseTitle;
  }

  return baseTitle.toLowerCase().includes(normalizedVersion.toLowerCase())
    ? baseTitle
    : `${baseTitle} (${normalizedVersion})`;
}

export function formatPosition(no: number | null | undefined, of: number | null | undefined): string | null {
  const position = Number(no || 0);
  const total = Number(of || 0);

  if (position <= 0 && total <= 0) {
    return null;
  }

  if (total > 0) {
    return `${Math.max(position, 0)}/${total}`;
  }

  return String(position);
}

export function formatPositiveNumber(value: number | null | undefined): string | null {
  const numeric = Number(value || 0);
  return numeric > 0 ? String(numeric) : null;
}

export function formatReplayGain(value: number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  // Skip placeholder zeros providers emit when they have no real ReplayGain.
  if (Math.abs(numeric) < 0.0005) {
    return null;
  }

  const prefix = numeric >= 0 ? "+" : "";
  return `${prefix}${numeric.toFixed(2)} dB`;
}

export function formatReplayPeak(value: number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  // Skip unset placeholders (0.0 / 1.0) that are not real measured peaks.
  if (numeric <= 0 || Math.abs(numeric - 1) < 0.0000005) {
    return null;
  }

  return numeric.toFixed(6);
}

type RetagTrackRow = {
  id: number;
  artist_id: number;
  album_id: number | null;
  media_id: number | null;
  file_path: string;
  relative_path: string | null;
  library_root: string | null;
  extension: string;
  file_quality: string | null;
  file_codec: string | null;
  file_channels: number | null;
  file_provider: string | null;
  file_provider_entity_type: string | null;
  file_provider_id: string | null;
  file_fingerprint: string | null;
  file_acoustid_id: string | null;
  file_fingerprint_duration: number | null;
  primary_artist_name: string;
  media_title: string;
  media_version: string | null;
  media_duration: number | null;
  media_release_date: string | null;
  media_track_number: number | null;
  media_volume_number: number | null;
  media_isrc: string | null;
  media_copyright: string | null;
  media_replay_gain: number | null;
  media_peak: number | null;
  media_musical_key: string | null;
  album_title: string | null;
  album_version: string | null;
  album_release_date: string | null;
  album_num_volumes: number | null;
  album_upc: string | null;
  album_genres: string | null;
  album_original_date: string | null;
  media_format: string | null;
  album_label: string | null;
  album_review_text: string | null;
  media_credits: string | null;
  media_mbid: string | null;
  media_acoustid_id: string | null;
  media_acoustid_fingerprint: string | null;
  media_fingerprint_duration: number | null;
  media_explicit: number | null;
  album_mbid: string | null;
  album_mb_release_group_id: string | null;
  canonical_release_group_mbid: string | null;
  album_provider_id: string | null;
  artist_mbid: string | null;
  release_status: string | null;
  release_country: string | null;
  release_primary_type: string | null;
  release_secondary_types: string | null;
  library_slot: string | null;
  canonical_release_mbid: string | null;
  canonical_track_mbid: string | null;
  canonical_recording_mbid: string | null;
  recording_artist_credit: string | null;
  recording_data: string | null;
};

export type RetagDifference = {
  field: string;
  oldValue: string | null;
  newValue: string | null;
};

export type RetagPreviewItem = {
  id: number;
  artistId: number;
  albumId: number | null;
  mediaId: number | null;
  path: string;
  missing: boolean;
  changes: RetagDifference[];
  error?: string;
};

export type RetagStatusSummary = {
  enabled: boolean;
  total: number;
  scanned: number;
  limited: boolean;
  retagNeeded: number;
  missing: number;
  sample: RetagPreviewItem[];
};

export type RetagApplyResult = {
  retagged: number;
  skipped: number;
  missing: number;
  errors: Array<{ id: number; error: string }>;
};

type RetagApplyOptions = {
  /**
   * Permit provider/network lyric discovery while writing tags. Interactive
   * maintenance keeps this enabled; the download-import path disables it so
   * optional lyric misses cannot hold a completed media job for minutes.
   */
  includeExternalLyrics?: boolean;
  lyricsByProviderMedia?: Map<string, ResolvedLyrics | null>;
  /** Reports per-file progress (completed, total) so a command can show "x/y files". */
  onProgress?: (completed: number, total: number) => void;
};

export type RetagMediaIdOptions = {
  provider?: string | null;
  includeExternalLyrics?: boolean;
  lyricsByProviderMedia?: Map<string, ResolvedLyrics | null>;
  onProgress?: (completed: number, total: number) => void;
};

export type RetagScopeOptions = {
  artistId?: string;
  albumId?: string;
  limit?: number;
  offset?: number;
  onProgress?: (completed: number, total: number) => void;
};

type RetagEvaluationOptions = {
  includeExternalMetadata?: boolean;
  lyricsByProviderMedia?: Map<string, ResolvedLyrics | null>;
  /** Shared across a batch so an album's cover is resolved/rendered only once. */
  embeddedCoverContext?: EmbeddedCoverContext;
};

/**
 * Skip embedding only when the currently-embedded cover already IS the album's
 * cover (byte-identical to the resolved target). Otherwise overrule it — Lidarr
 * policy: replace a wrong embedded cover whether it is larger OR smaller (in both
 * filesize and resolution) than the album's canonical cover. There is no
 * "downgrade" guard: a larger-but-wrong cover (e.g. a 3000px image from a hybrid
 * track) must still be overruled with the correct capped album cover.
 */
function shouldSkipCoverEmbed(comparison: EmbeddedCoverComparison): boolean {
  return comparison.matches;
}

/** "1200×1200 · 312 KB" — resolution (dot) size, à la Lidarr's cover diff. */
function formatCoverInfo(info: CoverImageInfo | null): string {
  if (!info) return "None";
  const dimensions = info.width && info.height ? `${info.width}×${info.height}` : "Image";
  return `${dimensions} · ${formatCoverBytes(info.bytes)}`;
}

function formatCoverBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

type EmbeddedCoverContext = {
  byAlbum: Map<string, Promise<string | null>>;
  temporaryDirectories: string[];
};

type EmbeddedCoverSyncOutcome = "embedded" | "unchanged" | "failed";

// Keep embedded artwork in Lidarr's practical size range while the cached
// master and folder sidecar retain the provider/catalog origin.
const EMBEDDED_COVER_HEIGHT = 1200;

// How many files the retag preview/status reads at once. Disk/parse bound, so a
// modest fan-out (matching the artwork/refresh services) is the sweet spot.
const RETAG_EVALUATION_CONCURRENCY = 8;

async function resolvePreferredEmbeddedCover(
  row: RetagTrackRow,
  _config: MetadataConfig,
  _resolvedMediaPath: string,
  context: EmbeddedCoverContext,
): Promise<string | null> {
  // Single source of truth: the cover already in the mediacover cache for this
  // file's OWN canonical release group — the exact image the UI shows. No
  // provider fallback, no hybrid-matched-track release group, no folder-sidecar
  // preference, and no on-the-fly download at tag-write time. Refresh + provider
  // matching are the phases that acquire artwork; if it was never cached, we
  // simply do not embed (mirrors Lidarr, which embeds from the album's stored
  // MediaCover and does not fetch during a tag write).
  const albumMbid = String(row.canonical_release_group_mbid || row.album_mbid || "").trim();
  if (!albumMbid) return null;

  const key = `canonical:${albumMbid}`;
  let pending = context.byAlbum.get(key);
  if (!pending) {
    pending = (async () => {
      const {
        getCachedMediaCoverOriginalFilePath,
        renderCappedCoverBuffer,
      } = await import("../metadata/media-cover-service.js");
      const cover = getCachedMediaCoverOriginalFilePath(albumMbid, "Album", "cover");
      if (!cover || !fs.existsSync(cover)) return null;

      // Cap the embedded rendition at EMBEDDED_COVER_HEIGHT: scale down on the fly
      // (from the local cached file, no network) only when it exceeds the cap;
      // otherwise embed the cached cover as-is.
      const capped = renderCappedCoverBuffer(cover, EMBEDDED_COVER_HEIGHT);
      if (!capped) return cover;

      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-embedded-cover-"));
      context.temporaryDirectories.push(tempDir);
      const tempCover = path.join(tempDir, "cover.jpg");
      fs.writeFileSync(tempCover, capped);
      return tempCover;
    })();
    context.byAlbum.set(key, pending);
  }
  return pending;
}

async function resolveLyricsForRetagRow(
  row: RetagTrackRow,
  allowProviderFetch: boolean,
  cache?: Map<string, ResolvedLyrics | null>,
): Promise<ResolvedLyrics | null> {
  if (!row.file_provider_id) return null;
  const key = providerMediaLyricsKey(row.file_provider, row.file_provider_id);
  if (cache?.has(key)) return cache.get(key) ?? null;
  if (!allowProviderFetch) return null;
  const lyrics = await getLyricsForProviderMedia(row.file_provider_id, row.file_provider);
  cache?.set(key, lyrics);
  return lyrics;
}

function buildProviderTrackUrl(row: RetagTrackRow): string {
  const provider = String(row.file_provider || "tidal").trim() || "tidal";
  const providerTrackId = String(row.file_provider_id || row.media_id || "").trim();

  try {
    return buildStreamingMediaUrl("track", providerTrackId, provider);
  } catch {
    return "";
  }
}

function shouldSkipEmbeddedAudioTagWrite(row: RetagTrackRow): boolean {
  // ffmpeg has no APE (Monkey's Audio) muxer/encoder in this build (decode-only,
  // confirmed live: `ffmpeg -formats` lists "ape" with demuxer support only) —
  // a stream-copy metadata rewrite has no container to write back into. APE
  // files still import/play fine; they just can't carry Discogenius's tags.
  return String(row.extension || "").toLowerCase().replace(/^\./, "") === "ape";
}

function resolveTagPolicy(config: MetadataConfig): WriteAudioTagsPolicy {
  return config.write_audio_tags_policy ?? "no";
}

function isRetagMaintenanceEnabled(config: MetadataConfig): boolean {
  return resolveTagPolicy(config) !== "no" || config.embed_replaygain !== false || config.enable_fingerprinting === true;
}

function normalizeReleaseDate(value: string | null | undefined): string | null {
  const raw = String(value || "").trim();
  if (!raw) {
    return null;
  }

  const match = raw.match(/^\d{4}(?:-\d{2}-\d{2})?/);
  return match ? match[0] : raw;
}

function parseArtistCreditNames(artistCredit?: string | null, data?: string | null): string[] {
  const names: string[] = [];

  if (data) {
    try {
      const parsed = JSON.parse(data);
      // Structured `Recordings.credits` is a top-level `[{id,name,join_phrase}]`
      // array; a provider blob (or legacy row) nests it under `artist-credit`.
      const credits = Array.isArray(parsed)
        ? parsed
        : (parsed["artist-credit"] || parsed.artistCredits || parsed.artist_credits);
      if (Array.isArray(credits)) {
        for (const credit of credits) {
          const name = String(credit?.name || credit?.artist?.name || "").trim();
          if (name) {
            names.push(name);
          }
        }
      }
    } catch {
      // Ignore malformed MusicBrainz payloads and fall back below.
    }
  }

  const fallbackCredit = String(artistCredit || "").trim();
  if (names.length === 0 && fallbackCredit) {
    names.push(fallbackCredit);
  }

  return Array.from(new Set(names));
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Parse Albums.genres / AlbumEditions.label JSON arrays into trimmed strings. */
function parseJsonStringList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter((item) => item.length > 0);
  } catch {
    return [];
  }
}

function normalizeValue(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (Array.isArray(value)) {
    const normalizedItems = value
      .map((item) => normalizeValue(item))
      .filter((item): item is string => Boolean(item));
    return normalizedItems.length > 0 ? normalizedItems.join(", ") : null;
  }

  if (typeof value === "object") {
    const maybePosition = value as { no?: number; of?: number; text?: unknown };
    if (typeof maybePosition.no === "number" || typeof maybePosition.of === "number") {
      const no = Number.isFinite(maybePosition.no) ? Number(maybePosition.no) : null;
      const of = Number.isFinite(maybePosition.of) ? Number(maybePosition.of) : null;
      if (no !== null && of !== null && of > 0) {
        return `${no}/${of}`;
      }
      if (no !== null) {
        return String(no);
      }
      if (of !== null && of > 0) {
        return `0/${of}`;
      }
    }

    if ("text" in maybePosition) {
      return normalizeValue(maybePosition.text);
    }

    return collapseWhitespace(String(value));
  }

  return collapseWhitespace(String(value));
}

function normalizeComparableValue(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const normalized = collapseWhitespace(value);
  return normalized ? normalized : null;
}

/** Normalize AlbumEditions.country (plain code or JSON array string) for tags. */
function formatReleaseCountryTag(value: unknown): string | null {
  const raw = String(value || "").trim();
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const countries = parsed
        .map((item) => formatReleaseCountryTag(item))
        .filter((country): country is string => Boolean(country));
      return countries.length > 0 ? countries.join(", ") : null;
    }
  } catch {
    // Scalar path below.
  }

  const withoutBrackets = raw.replace(/^\[+|\]+$/g, "").trim();
  if (!withoutBrackets) return null;
  return withoutBrackets.toLowerCase() === "worldwide" ? "Worldwide" : withoutBrackets;
}

function normalizeIdentifier(value: string | null | undefined): string {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

type FingerprintRecordingMatch = {
  recording: MusicBrainzRecording;
  titleScore: number;
  artistScore: number;
  albumScore: number;
  durationDelta: number | null;
  isrcMatch: boolean;
  score: number;
};

type MusicBrainzReleaseMatch = {
  release: MusicBrainzRelease;
  titleScore: number;
  artistScore: number;
  yearScore: number;
  score: number;
};

function evaluateFingerprintRecordingMatch(row: RetagTrackRow, recording: MusicBrainzRecording): FingerprintRecordingMatch {
  const normalizedTrackTitle = normalizeComparableText(row.media_title);
  const normalizedPrimaryArtist = normalizeComparableText(row.primary_artist_name);
  const normalizedAlbumTitle = normalizeComparableText(row.album_title || "");
  const normalizedRecordingTitle = normalizeComparableText(recording.title);
  const recordingArtistScores = recording.artists.map((artistName) => stringSimilarity(
    normalizedPrimaryArtist,
    normalizeComparableText(artistName),
  ));
  const recordingAlbumScores = recording.releaseTitles.map((releaseTitle) => stringSimilarity(
    normalizedAlbumTitle,
    normalizeComparableText(releaseTitle),
  ));
  const titleScore = normalizedTrackTitle
    ? stringSimilarity(normalizedTrackTitle, normalizedRecordingTitle)
    : 0;
  const artistScore = normalizedPrimaryArtist && recordingArtistScores.length > 0
    ? Math.max(...recordingArtistScores)
    : 0;
  const albumScore = normalizedAlbumTitle && recordingAlbumScores.length > 0
    ? Math.max(...recordingAlbumScores)
    : 0;
  const normalizedTrackIsrc = normalizeIdentifier(row.media_isrc);
  const isrcMatch = normalizedTrackIsrc.length > 0
    && recording.isrcs.some((isrc) => normalizeIdentifier(isrc) === normalizedTrackIsrc);

  const rowDuration = Number(row.media_duration || 0);
  const recordingDuration = Number(recording.durationSeconds || 0);
  const durationDelta = rowDuration > 0 && recordingDuration > 0
    ? Math.abs(rowDuration - recordingDuration)
    : null;

  let score = 0;
  if (isrcMatch) {
    score += 4;
  }

  score += titleScore * 3;
  score += artistScore * 2;
  score += albumScore;

  if (durationDelta !== null) {
    if (durationDelta <= 2) {
      score += 1;
    } else if (durationDelta <= 5) {
      score += 0.5;
    } else if (durationDelta > 12) {
      score -= 1;
    }
  }

  return {
    recording,
    titleScore,
    artistScore,
    albumScore,
    durationDelta,
    isrcMatch,
    score,
  };
}

function isAcceptableFingerprintMatch(match: FingerprintRecordingMatch): boolean {
  if (match.isrcMatch) {
    return true;
  }

  if (match.titleScore < 0.9) {
    return false;
  }

  if (match.artistScore > 0 && match.artistScore < 0.72) {
    return false;
  }

  if (match.durationDelta !== null && match.durationDelta > 10) {
    return false;
  }

  return match.score >= 4.1;
}

function evaluateMusicBrainzReleaseMatch(row: RetagTrackRow, release: MusicBrainzRelease): MusicBrainzReleaseMatch {
  const normalizedAlbumTitle = normalizeComparableText(row.album_title || "");
  const normalizedPrimaryArtist = normalizeComparableText(row.primary_artist_name);
  const normalizedReleaseTitle = normalizeComparableText(release.title);
  const titleScore = normalizedAlbumTitle
    ? stringSimilarity(normalizedAlbumTitle, normalizedReleaseTitle)
    : 0;
  const artistScore = normalizedPrimaryArtist && release.artistCredits.length > 0
    ? Math.max(...release.artistCredits.map((credit) => stringSimilarity(
      normalizedPrimaryArtist,
      normalizeComparableText(credit.name),
    )))
    : 0;

  const currentYear = normalizeReleaseDate(row.album_release_date || row.media_release_date)?.slice(0, 4) || "";
  const releaseYear = String(release.date || "").slice(0, 4);
  const yearScore = currentYear && releaseYear
    ? (currentYear === releaseYear ? 1 : 0)
    : 0;

  let score = titleScore * 3 + artistScore * 2 + yearScore;
  if (normalizeIdentifier(row.album_upc) && normalizeIdentifier(release.barcode) === normalizeIdentifier(row.album_upc)) {
    score += 3;
  }

  return {
    release,
    titleScore,
    artistScore,
    yearScore,
    score,
  };
}

function isAcceptableReleaseMatch(match: MusicBrainzReleaseMatch): boolean {
  if (match.titleScore < 0.85) {
    return false;
  }

  if (match.artistScore > 0 && match.artistScore < 0.72) {
    return false;
  }

  return match.score >= 4.2;
}

function buildNativeTagAliases(rawId: string): string[] {
  const normalized = rawId.trim().toLowerCase();
  if (!normalized) {
    return [];
  }

  const aliases = new Set<string>([normalized]);
  if (normalized.startsWith("txxx:")) {
    aliases.add(normalized.slice(5));
  }
  if (normalized.startsWith("----:com.apple.itunes:")) {
    aliases.add(normalized.slice("----:com.apple.itunes:".length));
  }
  if (normalized.startsWith("com.apple.itunes:")) {
    aliases.add(normalized.slice("com.apple.itunes:".length));
  }
  if (normalized.includes(":")) {
    aliases.add(normalized.split(":").pop() || normalized);
  }

  return Array.from(aliases);
}

function buildNativeLookup(metadata: mm.IAudioMetadata): Map<string, string> {
  const lookup = new Map<string, string>();

  for (const tagSet of Object.values(metadata.native || {})) {
    for (const tag of tagSet as Array<{ id?: string; value?: unknown }>) {
      const value = normalizeValue(tag?.value);
      if (!value) {
        continue;
      }

      for (const alias of buildNativeTagAliases(String(tag?.id || ""))) {
        if (!lookup.has(alias)) {
          lookup.set(alias, value);
        }
      }
    }
  }

  return lookup;
}

function getLookupValue(lookup: Map<string, string>, aliases: string[]): string | null {
  for (const alias of aliases) {
    const value = lookup.get(alias.toLowerCase());
    if (value) {
      return value;
    }
  }

  return null;
}

function isNumericMp4NativeId(rawId: string): boolean {
  return rawId.length === 4 && Array.from(rawId).some((char) => char.charCodeAt(0) < 32);
}

function hasNumericMp4NativeIds(metadata: mm.IAudioMetadata): boolean {
  return Object.values(metadata.native || {}).some((tagSet) =>
    (tagSet as Array<{ id?: string }>).some((tag) => isNumericMp4NativeId(String(tag?.id || ""))),
  );
}

function mp4NativeIdForIndex(index: number): string {
  const id = Buffer.alloc(4);
  id.writeUInt32BE(index, 0);
  return id.toString("latin1");
}

function readMp4MdtaKeyMap(filePath: string): Map<string, string> {
  const keyMap = new Map<string, string>();
  let fd: number | null = null;

  try {
    fd = fs.openSync(filePath, "r");
    const stat = fs.fstatSync(fd);
    const header = Buffer.alloc(16);

    const readAtomHeader = (position: number, rangeEnd: number): { size: number; type: string; headerSize: number } | null => {
      if (position + 8 > rangeEnd) {
        return null;
      }

      const read = fs.readSync(fd!, header, 0, 16, position);
      if (read < 8) {
        return null;
      }

      let size = header.readUInt32BE(0);
      const type = header.toString("latin1", 4, 8);
      let headerSize = 8;
      if (size === 1) {
        if (read < 16) {
          return null;
        }
        size = Number(header.readBigUInt64BE(8));
        headerSize = 16;
      } else if (size === 0) {
        size = rangeEnd - position;
      }

      if (!Number.isFinite(size) || size < headerSize || position + size > rangeEnd) {
        return null;
      }

      return { size, type, headerSize };
    };

    const parseKeysBox = (payloadStart: number, payloadEnd: number) => {
      const length = payloadEnd - payloadStart;
      if (length < 8 || length > 1024 * 1024) {
        return;
      }

      const buffer = Buffer.alloc(length);
      fs.readSync(fd!, buffer, 0, length, payloadStart);
      let offset = 4; // version/flags
      const count = buffer.readUInt32BE(offset);
      offset += 4;

      for (let index = 1; index <= count && offset + 8 <= buffer.length; index++) {
        const keySize = buffer.readUInt32BE(offset);
        if (keySize < 8 || offset + keySize > buffer.length) {
          break;
        }

        const keyName = buffer.toString("utf8", offset + 8, offset + keySize).replace(/\0+$/g, "").trim();
        if (keyName) {
          keyMap.set(mp4NativeIdForIndex(index), keyName);
        }
        offset += keySize;
      }
    };

    const walkAtoms = (start: number, end: number) => {
      let position = start;
      while (position + 8 <= end) {
        const atom = readAtomHeader(position, end);
        if (!atom) {
          break;
        }

        const payloadStart = position + atom.headerSize + (atom.type === "meta" ? 4 : 0);
        const payloadEnd = position + atom.size;
        if (atom.type === "keys") {
          parseKeysBox(position + atom.headerSize, payloadEnd);
        } else if (atom.type === "moov" || atom.type === "udta" || atom.type === "meta") {
          walkAtoms(payloadStart, payloadEnd);
        }

        position += atom.size;
      }
    };

    walkAtoms(0, stat.size);
  } catch {
    return keyMap;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore close errors
      }
    }
  }

  return keyMap;
}

function mergeMp4KeyedNativeLookup(metadata: mm.IAudioMetadata, lookup: Map<string, string>, filePath: string) {
  if (!hasNumericMp4NativeIds(metadata)) {
    return;
  }

  const keyMap = readMp4MdtaKeyMap(filePath);
  if (keyMap.size === 0) {
    return;
  }

  for (const tagSet of Object.values(metadata.native || {})) {
    for (const tag of tagSet as Array<{ id?: string; value?: unknown }>) {
      const keyName = keyMap.get(String(tag?.id || ""));
      if (!keyName) {
        continue;
      }

      const value = normalizeValue(tag?.value);
      if (!value) {
        continue;
      }

      for (const alias of buildNativeTagAliases(keyName)) {
        lookup.set(alias, value);
      }
    }
  }
}

function getCurrentTagValue(metadata: mm.IAudioMetadata, lookup: Map<string, string>, tag: ManagedTag): string | null {
  const common = metadata.common as Record<string, any>;
  const fallback = () => getLookupValue(lookup, [tag.ffmpegKey, ...(tag.aliases || [])]);

  switch (tag.key) {
    case "lyrics":
      return normalizeValue(common.lyrics) || fallback();
    case "title":
      return normalizeValue(common.title) || fallback();
    case "artist":
      return normalizeValue(common.artist || common.artists) || fallback();
    case "album_artist":
      return normalizeValue(common.albumartist || common.albumartists) || fallback();
    case "album":
      return normalizeValue(common.album) || fallback();
    case "track":
      return formatPosition(common.track?.no ?? null, common.track?.of ?? null) || fallback();
    case "track_number":
      return formatPositiveNumber(common.track?.no ?? null) || fallback();
    case "track_count":
      return formatPositiveNumber(common.track?.of ?? null) || fallback();
    case "disc":
      return formatPosition(common.disk?.no ?? null, common.disk?.of ?? null) || fallback();
    case "disc_number":
      return formatPositiveNumber(common.disk?.no ?? null) || fallback();
    case "disc_count":
      return formatPositiveNumber(common.disk?.of ?? null) || fallback();
    case "date":
      return normalizeReleaseDate(common.date || (common.year ? String(common.year) : null)) || normalizeReleaseDate(fallback());
    case "isrc":
      return normalizeValue(common.isrc) || fallback();
    case "copyright":
      return normalizeValue(common.copyright) || fallback();
    default:
      return fallback();
  }
}

export class AudioTagService {
  private static refreshArtistPathFromTemplateIfNeeded(artistId: number) {
    const artist = db.prepare("SELECT id, name, mbid, path FROM Artists WHERE id = ?").get(artistId) as {
      id: number | string;
      name: string | null;
      mbid: string | null;
      path: string | null;
    } | undefined;

    if (!artist) {
      return;
    }

    if (!shouldReapplyArtistPathTemplate({
      artistId: artist.id,
      artistName: String(artist.name || "Unknown Artist"),
      artistMbId: artist.mbid || null,
      existingPath: artist.path || null,
    })) {
      return;
    }

    try {
      MoveArtistService.moveArtist({
        artistId: String(artist.id),
        applyNamingTemplate: true,
        moveFiles: true,
      });
    } catch (error) {
      console.warn(`[Retag] Failed to reapply artist path template for ${artistId}:`, error);
    }
  }

  private static getTrackCount(options: RetagScopeOptions = {}): number {
    const where: string[] = ["lf.file_type = 'track'"];
    const params: Array<string> = [];

    if (options.artistId) {
      where.push("lf.artist_id = ?");
      params.push(options.artistId);
    }
    if (options.albumId) {
      where.push(`(
        lf.canonical_release_group_mbid = ?
        OR lf.canonical_release_mbid = ?
        OR (
          lf.provider_entity_type = 'track'
          AND CAST(lf.provider_id AS TEXT) IN (
            SELECT CAST(scope_item.provider_id AS TEXT)
            FROM ProviderItems scope_item
            JOIN ProviderEditionMembers scope_member
              ON scope_member.member_item_id = scope_item.id
            JOIN ProviderEditionMatches scope_match
              ON scope_match.provider_edition_item_id = scope_member.provider_edition_item_id
             AND scope_match.match_state = 'accepted'
            JOIN AlbumEditions scope_release ON scope_release.id = scope_match.edition_id
            JOIN Albums scope_group ON scope_group.id = scope_release.release_group_id
            WHERE scope_item.entity_type = 'track'
              AND (scope_group.mbid = ? OR scope_release.mbid = ?)
          )
        )
      )`);
      params.push(options.albumId, options.albumId, options.albumId, options.albumId);
    }

    const row = db.prepare(`
      SELECT COUNT(*) AS count
      FROM TrackFiles lf
      WHERE ${where.join(" AND ")}
    `).get(...params) as { count?: number } | undefined;

    return Number(row?.count || 0);
  }

  private static getTrackRows(options: RetagScopeOptions = {}, includePaging = true): RetagTrackRow[] {
    const limit = options.limit ?? 200;
    const offset = options.offset ?? 0;
    const where: string[] = ["lf.file_type = 'track'"];
    const params: Array<string | number> = [];

    if (options.artistId) {
      where.push("lf.artist_id = ?");
      params.push(options.artistId);
    }
    if (options.albumId) {
      where.push(`(
        lf.canonical_release_group_mbid = ?
        OR lf.canonical_release_mbid = ?
        OR (
          lf.provider_entity_type = 'track'
          AND CAST(lf.provider_id AS TEXT) IN (
            SELECT CAST(scope_item.provider_id AS TEXT)
            FROM ProviderItems scope_item
            JOIN ProviderEditionMembers scope_member
              ON scope_member.member_item_id = scope_item.id
            JOIN ProviderEditionMatches scope_match
              ON scope_match.provider_edition_item_id = scope_member.provider_edition_item_id
             AND scope_match.match_state = 'accepted'
            JOIN AlbumEditions scope_release ON scope_release.id = scope_match.edition_id
            JOIN Albums scope_group ON scope_group.id = scope_release.release_group_id
            WHERE scope_item.entity_type = 'track'
              AND (scope_group.mbid = ? OR scope_release.mbid = ?)
          )
        )
      )`);
      params.push(options.albumId, options.albumId, options.albumId, options.albumId);
    }

    const sql = this.buildTrackRowsSql(where.join(" AND "), includePaging);

    if (includePaging) {
      params.push(limit, offset);
    }

    return db.prepare(sql).all(...params) as RetagTrackRow[];
  }

  private static buildTrackRowsSql(whereClause: string, includePaging = false): string {
    return `
      SELECT
        lf.id,
        lf.artist_id,
        NULL AS album_id,
        lf.provider_id AS media_id,
        lf.file_path,
        lf.relative_path,
        lf.library_root,
        lf.extension,
        lf.library_slot,
        lf.quality AS file_quality,
        lf.codec AS file_codec,
        lf.channels AS file_channels,
        COALESCE(lf.provider, provider_track.provider, provider_album.provider) AS file_provider,
        lf.provider_entity_type AS file_provider_entity_type,
        COALESCE(lf.provider_id, provider_track.provider_id) AS file_provider_id,
        lf.fingerprint AS file_fingerprint,
        lf.acoustid_id AS file_acoustid_id,
        lf.fingerprint_duration AS file_fingerprint_duration,
        artist.name AS primary_artist_name,
        COALESCE(canonical_track.title, provider_canonical_track.title, canonical_recording.title, provider_recording.title, provider_track.title) AS media_title,
        CASE WHEN COALESCE(canonical_track.mbid, provider_canonical_track.mbid) IS NOT NULL THEN NULL ELSE provider_track.version END AS media_version,
        COALESCE(
          CASE WHEN canonical_track.length_ms IS NOT NULL THEN ROUND(canonical_track.length_ms / 1000.0) END,
          CASE WHEN provider_canonical_track.length_ms IS NOT NULL THEN ROUND(provider_canonical_track.length_ms / 1000.0) END,
          CASE WHEN canonical_recording.length_ms IS NOT NULL THEN ROUND(canonical_recording.length_ms / 1000.0) END,
          CASE WHEN provider_recording.length_ms IS NOT NULL THEN ROUND(provider_recording.length_ms / 1000.0) END,
          CASE WHEN provider_track.duration_ms IS NOT NULL
            THEN ROUND(provider_track.duration_ms / 1000.0) END
        ) AS media_duration,
        COALESCE(canonical_release.date, ar.date, provider_track.release_date, provider_album.release_date) AS media_release_date,
        COALESCE(canonical_track.position, provider_canonical_track.position) AS media_track_number,
        COALESCE(canonical_track.medium_position, provider_canonical_track.medium_position) AS media_volume_number,
        COALESCE(
          provider_track.isrc,
          CASE WHEN json_valid(canonical_recording.isrcs) THEN json_extract(canonical_recording.isrcs, '$[0]') ELSE canonical_recording.isrcs END,
          CASE WHEN json_valid(provider_recording.isrcs) THEN json_extract(provider_recording.isrcs, '$[0]') ELSE provider_recording.isrcs END
        ) AS media_isrc,
        COALESCE(
          canonical_recording.copyright,
          provider_recording.copyright,
          provider_track.copyright,
          provider_album.copyright
        ) AS media_copyright,
        provider_track.replay_gain AS media_replay_gain,
        provider_track.peak AS media_peak,
        provider_track.musical_key AS media_musical_key,
        COALESCE(canonical_group.title, canonical_release.title, alb.title, provider_album.title) AS album_title,
        CASE WHEN COALESCE(canonical_group.mbid, alb.mbid) IS NOT NULL THEN NULL ELSE provider_album.version END AS album_version,
        COALESCE(canonical_release.date, ar.date, provider_album.release_date) AS album_release_date,
        canonical_release.media_count AS album_num_volumes,
        COALESCE(canonical_release.barcode, provider_album.upc) AS album_upc,
        COALESCE(canonical_group.genres, alb.genres, am.genres) AS album_genres,
        COALESCE(canonical_group.first_release_date, alb.first_release_date) AS album_original_date,
        COALESCE(
          CASE WHEN json_valid(canonical_release.media) AND json_extract(canonical_release.media, '$[0].format') IS NOT NULL AND json_extract(canonical_release.media, '$[0].format') != '' THEN json_extract(canonical_release.media, '$[0].format') END,
          CASE WHEN json_valid(ar.media) AND json_extract(ar.media, '$[0].format') IS NOT NULL AND json_extract(ar.media, '$[0].format') != '' THEN json_extract(ar.media, '$[0].format') END,
          'Digital Media'
        ) AS media_format,
        canonical_release.label AS album_label,
        COALESCE(
          canonical_group.review_text,
          alb.review_text
        ) AS album_review_text,
        COALESCE(canonical_recording.credits, provider_recording.credits) AS media_credits,
        COALESCE(lf.canonical_recording_mbid, canonical_recording.mbid, provider_recording.mbid) AS media_mbid,
        lf.acoustid_id AS media_acoustid_id,
        lf.fingerprint AS media_acoustid_fingerprint,
        lf.fingerprint_duration AS media_fingerprint_duration,
        provider_track.explicit AS media_explicit,
        COALESCE(lf.canonical_release_mbid, canonical_release.mbid, ar.mbid) AS album_mbid,
        COALESCE(lf.canonical_release_group_mbid, canonical_group.mbid, alb.mbid) AS album_mb_release_group_id,
        -- The file's OWN canonical release group (no hybrid provider-track fallback):
        -- the album identity the UI resolves the cover by. Used for cover embedding
        -- so a hybrid-matched track can never pull a foreign album's art.
        lf.canonical_release_group_mbid AS canonical_release_group_mbid,
        provider_album.provider_id AS album_provider_id,
        COALESCE(lf.canonical_artist_mbid, canonical_recording.artist_mbid, provider_recording.artist_mbid, canonical_group.artist_mbid, alb.artist_mbid, artist.mbid) AS artist_mbid,
        COALESCE(canonical_release.status, ar.status) AS release_status,
        COALESCE(canonical_release.country, ar.country) AS release_country,
        COALESCE(canonical_group.primary_type, alb.primary_type) AS release_primary_type,
        COALESCE(canonical_group.secondary_types, alb.secondary_types) AS release_secondary_types,
        COALESCE(lf.canonical_release_mbid, canonical_release.mbid, ar.mbid) AS canonical_release_mbid,
        COALESCE(lf.canonical_track_mbid, canonical_track.mbid, provider_canonical_track.mbid) AS canonical_track_mbid,
        COALESCE(lf.canonical_recording_mbid, canonical_recording.mbid, provider_recording.mbid) AS canonical_recording_mbid,
        canonical_recording.artist_credit AS recording_artist_credit,
        canonical_recording.credits AS recording_data
      FROM TrackFiles lf
      JOIN Artists artist ON artist.id = lf.artist_id
      LEFT JOIN Tracks canonical_track
        ON canonical_track.id = lf.track_id
        OR (lf.track_id IS NULL AND canonical_track.mbid = lf.canonical_track_mbid)
      LEFT JOIN AlbumEditions canonical_release
        ON canonical_release.id = lf.album_edition_id
        OR (lf.album_edition_id IS NULL AND canonical_release.mbid = lf.canonical_release_mbid)
      LEFT JOIN Albums canonical_group
        ON canonical_group.id = lf.release_group_id
        OR (lf.release_group_id IS NULL AND canonical_group.mbid = lf.canonical_release_group_mbid)
      LEFT JOIN Recordings canonical_recording
        ON canonical_recording.id = COALESCE(lf.recording_id, canonical_track.recording_id)
        OR (
          lf.recording_id IS NULL
          AND canonical_track.recording_id IS NULL
          AND canonical_recording.mbid = lf.canonical_recording_mbid
        )
      LEFT JOIN ProviderItems provider_track
        ON provider_track.id = (
          SELECT candidate.id
          FROM ProviderItems candidate
          WHERE candidate.entity_type = 'track'
            AND CASE WHEN lf.provider_entity_type = 'track' THEN lf.provider_id END IS NOT NULL
            AND CAST(candidate.provider_id AS TEXT) = CAST(lf.provider_id AS TEXT)
            AND (lf.provider IS NULL OR candidate.provider = lf.provider)
          ORDER BY candidate.updated_at DESC, candidate.provider_id ASC
          LIMIT 1
        )
      LEFT JOIN ProviderEditionMembers provider_member
        ON provider_member.id = (
          SELECT candidate_member.id
          FROM ProviderEditionMembers candidate_member
          LEFT JOIN ProviderTrackMatches candidate_match
            ON candidate_match.provider_edition_member_id = candidate_member.id
           AND candidate_match.match_state = 'accepted'
          WHERE candidate_member.member_item_id = provider_track.id
          ORDER BY
            CASE
              WHEN candidate_match.track_id = canonical_track.id THEN 0
              WHEN candidate_match.recording_id = canonical_recording.id THEN 1
              ELSE 2
            END,
            candidate_member.id
          LIMIT 1
        )
      LEFT JOIN ProviderTrackMatches provider_track_match
        ON provider_track_match.provider_edition_member_id = provider_member.id
       AND provider_track_match.match_state = 'accepted'
      LEFT JOIN Tracks provider_canonical_track
        ON provider_canonical_track.id = provider_track_match.track_id
      LEFT JOIN Recordings provider_recording
        ON provider_recording.id = provider_track_match.recording_id
      LEFT JOIN ProviderItems provider_album
        ON provider_album.id = (
          SELECT album_candidate.id
          FROM ProviderItems album_candidate
          WHERE album_candidate.entity_type = 'release'
            AND (
              (
                lf.provider_entity_type IN ('album', 'release')
                AND CAST(album_candidate.provider_id AS TEXT) = CAST(lf.provider_id AS TEXT)
                AND (COALESCE(lf.provider, provider_track.provider) IS NULL OR album_candidate.provider = COALESCE(lf.provider, provider_track.provider))
              )
              OR album_candidate.id = provider_member.provider_edition_item_id
            )
          ORDER BY CASE WHEN album_candidate.id = provider_member.provider_edition_item_id THEN 0 ELSE 1 END,
            album_candidate.updated_at DESC
          LIMIT 1
        )
      LEFT JOIN ProviderEditionMatches provider_release_match
        ON provider_release_match.id = (
          SELECT candidate_release_match.id
          FROM ProviderEditionMatches candidate_release_match
          WHERE candidate_release_match.provider_edition_item_id = provider_album.id
            AND candidate_release_match.match_state = 'accepted'
          ORDER BY
            CASE WHEN candidate_release_match.edition_id = canonical_release.id THEN 0 ELSE 1 END,
            CASE candidate_release_match.decision_source WHEN 'manual' THEN 0 ELSE 1 END,
            candidate_release_match.confidence DESC
          LIMIT 1
        )
      LEFT JOIN AlbumEditions ar
        ON ar.id = COALESCE(canonical_release.id, canonical_track.album_edition_id, provider_release_match.edition_id)
      LEFT JOIN Albums alb
        ON alb.id = COALESCE(canonical_group.id, ar.release_group_id)
      LEFT JOIN ArtistMetadata am ON am.mbid = artist.mbid
      WHERE ${whereClause}
        AND (provider_track.provider_id IS NOT NULL OR canonical_track.mbid IS NOT NULL OR provider_canonical_track.mbid IS NOT NULL OR canonical_recording.mbid IS NOT NULL OR provider_recording.mbid IS NOT NULL)
      ORDER BY lf.artist_id, COALESCE(canonical_group.mbid, alb.mbid), COALESCE(canonical_track.medium_position, provider_canonical_track.medium_position, 1), COALESCE(canonical_track.position, provider_canonical_track.position, 0), lf.id
      ${includePaging ? "LIMIT ? OFFSET ?" : ""}
    `;
  }

  private static getTrackRowsByIds(ids: number[]): RetagTrackRow[] {
    if (ids.length === 0) {
      return [];
    }

    const placeholders = ids.map(() => "?").join(",");
    return db.prepare(this.buildTrackRowsSql(`lf.id IN (${placeholders})`, false)).all(...ids) as RetagTrackRow[];
  }

  private static getTrackArtistNames(row: RetagTrackRow, fallbackArtistName: string): string[] {
    const canonicalNames = parseArtistCreditNames(row.recording_artist_credit, row.recording_data);
    if (canonicalNames.length > 0) {
      return canonicalNames;
    }

    if (row.artist_mbid) {
      const artistRow = db.prepare(`
        SELECT name
        FROM ArtistMetadata
        WHERE mbid = ?
        LIMIT 1
      `).get(row.artist_mbid) as { name?: string | null } | undefined;
      const artistName = String(artistRow?.name || "").trim();
      if (artistName) {
        return [artistName];
      }
    }

    return [fallbackArtistName];
  }

  private static getAlbumArtistNames(row: RetagTrackRow, fallbackArtistName: string): string[] {
    if (row.album_mb_release_group_id) {
      const canonicalRows = db.prepare(`
        SELECT COALESCE(NULLIF(aa.credited_name, ''), artist.name) AS name
        FROM AlbumArtists aa
        LEFT JOIN ArtistMetadata artist ON artist.mbid = aa.artist_mbid
        WHERE aa.release_group_mbid = ?
        ORDER BY aa.ord ASC
      `).all(row.album_mb_release_group_id) as Array<{ name?: string | null }>;

      const canonicalNames = canonicalRows.map((canonicalRow) => String(canonicalRow.name || "").trim()).filter(Boolean);
      if (canonicalNames.length > 0) {
        return canonicalNames;
      }
    }

    if (row.artist_mbid) {
      const artistRow = db.prepare(`
        SELECT name
        FROM ArtistMetadata
        WHERE mbid = ?
        LIMIT 1
      `).get(row.artist_mbid) as { name?: string | null } | undefined;
      const artistName = String(artistRow?.name || "").trim();
      if (artistName) {
        return [artistName];
      }
    }

    return [fallbackArtistName];
  }

  private static getTrackCountForDisc(albumId: number | null, volumeNumber: number, canonicalReleaseMbid?: string | null): number | null {
    if (canonicalReleaseMbid) {
      const canonicalRow = db.prepare(`
        SELECT COUNT(*) AS count
        FROM Tracks
        WHERE release_mbid = ?
          AND COALESCE(medium_position, 1) = ?
      `).get(canonicalReleaseMbid, volumeNumber) as { count?: number } | undefined;
      const canonicalCount = Number(canonicalRow?.count || 0);
      if (canonicalCount > 0) {
        return canonicalCount;
      }
    }

    return null;
  }

  static buildAudioTagWriteMap(tags: ManagedTag[], extension?: string): Record<string, string> {
    const output: Record<string, string> = {};
    const rawExtension = String(extension || "").toLowerCase().trim();
    // TrackFiles stores extensions without a leading dot while direct callers
    // generally pass path.extname(). Normalize both shapes so MP4/M4A freeform
    // atoms, ID3 frames, and the APE safety guard use the intended mapping.
    const ext = rawExtension && !rawExtension.startsWith(".") ? `.${rawExtension}` : rawExtension;

    // .opus is Ogg-container Vorbis comments, same scheme as FLAC/OGG
    // (matches Xiph tag-type handling, which covers Opus identically).
    const isFlac = ext === ".flac" || ext === ".ogg" || ext === ".opus";
    const isMp3 = ext === ".mp3";
    const isM4a = ext === ".m4a" || ext === ".mp4";
    const isWma = ext === ".wma";
    const isApe = ext === ".ape";

    const flacMap: Record<string, string> = {
      lyrics: "LYRICS",
      title: "TITLE",
      artist: "ARTIST",
      album_artist: "ALBUMARTIST",
      album: "ALBUM",
      track: "track",
      track_number: "TRACKNUMBER",
      track_count: "TRACKTOTAL",
      disc: "disc",
      disc_number: "DISCNUMBER",
      disc_count: "DISCTOTAL",
      date: "DATE",
      original_date: "ORIGINALDATE",
      media_format: "MEDIA",
      genre: "GENRE",
      isrc: "ISRC",
      copyright: "COPYRIGHT",
      barcode: "BARCODE",
      label: "LABEL",
      provider_url: "PROVIDER_URL",
      musicbrainz_recordingid: "MUSICBRAINZ_TRACKID",
      musicbrainz_albumid: "MUSICBRAINZ_ALBUMID",
      musicbrainz_artistid: "MUSICBRAINZ_ARTISTID",
      musicbrainz_albumartistid: "MUSICBRAINZ_ALBUMARTISTID",
      musicbrainz_releasegroupid: "MUSICBRAINZ_RELEASEGROUPID",
      musicbrainz_releasetrackid: "MUSICBRAINZ_RELEASETRACKID",
      acoustid_id: "ACOUSTID_ID",
      acoustid_fingerprint: "ACOUSTID_FINGERPRINT",
      release_country: "RELEASECOUNTRY",
      release_status: "RELEASESTATUS",
      release_type: "RELEASETYPE",
      initialkey: "INITIALKEY",
    };

    const mp3Map: Record<string, string> = {
      lyrics: "lyrics-eng",
      title: "title",
      artist: "artist",
      album_artist: "album_artist",
      album: "album",
      track: "track",
      track_number: "TXXX:Track Number",
      track_count: "TXXX:Track Count",
      disc: "disc",
      disc_number: "TXXX:Disc Number",
      disc_count: "TXXX:Disc Count",
      date: "date",
      original_date: "TXXX:Original Release Date",
      media_format: "TMED",
      genre: "genre",
      isrc: "isrc",
      copyright: "copyright",
      barcode: "TXXX:Barcode",
      label: "publisher",
      provider_url: "TXXX:PROVIDER_URL",
      musicbrainz_recordingid: "TXXX:MusicBrainz Track Id",
      musicbrainz_albumid: "TXXX:MusicBrainz Album Id",
      musicbrainz_artistid: "TXXX:MusicBrainz Artist Id",
      musicbrainz_albumartistid: "TXXX:MusicBrainz Album Artist Id",
      musicbrainz_releasegroupid: "TXXX:MusicBrainz Release Group Id",
      musicbrainz_releasetrackid: "TXXX:MusicBrainz Release Track Id",
      acoustid_id: "TXXX:Acoustid Id",
      acoustid_fingerprint: "TXXX:Acoustid Fingerprint",
      release_country: "TXXX:MusicBrainz Album Release Country",
      release_status: "TXXX:MusicBrainz Album Status",
      release_type: "TXXX:MusicBrainz Album Type",
      initialkey: "TKEY",
    };

    const m4aMap: Record<string, string> = {
      lyrics: "lyrics-eng",
      title: "title",
      artist: "artist",
      album_artist: "album_artist",
      album: "album",
      track: "track",
      track_number: "----:com.apple.iTunes:Track Number",
      track_count: "----:com.apple.iTunes:Track Count",
      disc: "disc",
      disc_number: "----:com.apple.iTunes:Disc Number",
      disc_count: "----:com.apple.iTunes:Disc Count",
      date: "date",
      original_date: "----:com.apple.iTunes:Original Date",
      media_format: "----:com.apple.iTunes:MEDIA",
      genre: "genre",
      isrc: "isrc",
      copyright: "copyright",
      barcode: "----:com.apple.iTunes:Barcode",
      label: "----:com.apple.iTunes:LABEL",
      provider_url: "----:com.apple.iTunes:PROVIDER_URL",
      musicbrainz_recordingid: "----:com.apple.iTunes:MusicBrainz Track Id",
      musicbrainz_albumid: "----:com.apple.iTunes:MusicBrainz Album Id",
      musicbrainz_artistid: "----:com.apple.iTunes:MusicBrainz Artist Id",
      musicbrainz_albumartistid: "----:com.apple.iTunes:MusicBrainz Album Artist Id",
      musicbrainz_releasegroupid: "----:com.apple.iTunes:MusicBrainz Release Group Id",
      musicbrainz_releasetrackid: "----:com.apple.iTunes:MusicBrainz Release Track Id",
      acoustid_id: "----:com.apple.iTunes:Acoustid Id",
      acoustid_fingerprint: "----:com.apple.iTunes:Acoustid Fingerprint",
      release_country: "----:com.apple.iTunes:MusicBrainz Album Release Country",
      release_status: "----:com.apple.iTunes:MusicBrainz Album Status",
      release_type: "----:com.apple.iTunes:MusicBrainz Album Type",
      initialkey: "----:com.apple.iTunes:initialkey",
    };

    // ASF/WMA descriptor names:
    // standard fields use the "WM/" namespace, MusicBrainz identifiers use
    // the separate "MusicBrainz/" namespace for ASF.
    const wmaMap: Record<string, string> = {
      lyrics: "WM/Lyrics",
      title: "title",
      artist: "artist",
      album_artist: "WM/AlbumArtist",
      album: "album",
      track: "track",
      track_number: "WM/TrackNumber",
      track_count: "WM/TrackCount",
      disc: "disc",
      disc_number: "WM/PartOfSet",
      disc_count: "WM/DiscCount",
      date: "WM/Year",
      original_date: "WM/OriginalReleaseTime",
      media_format: "WM/Media",
      genre: "WM/Genre",
      isrc: "WM/ISRC",
      copyright: "copyright",
      barcode: "WM/Barcode",
      label: "WM/Publisher",
      provider_url: "WM/PROVIDER_URL",
      musicbrainz_recordingid: "MusicBrainz/Track Id",
      musicbrainz_albumid: "MusicBrainz/Album Id",
      musicbrainz_artistid: "MusicBrainz/Artist Id",
      musicbrainz_albumartistid: "MusicBrainz/Album Artist Id",
      musicbrainz_releasegroupid: "MusicBrainz/Release Group Id",
      musicbrainz_releasetrackid: "MusicBrainz/Release Track Id",
      acoustid_id: "Acoustid/Id",
      acoustid_fingerprint: "Acoustid/Fingerprint",
      release_country: "MusicBrainz/Album Release Country",
      release_status: "MusicBrainz/Album Status",
      release_type: "MusicBrainz/Album Type",
      initialkey: "WM/InitialKey",
    };

    // APE (Monkey's Audio) uses APEv2 tags, nearly identical field naming to
    // Xiph/Vorbis mapping (same MUSICBRAINZ_* field names).
    const apeMap: Record<string, string> = {
      ...flacMap,
      album_artist: "Album Artist",
      copyright: "Copyright",
      isrc: "ISRC",
    };

    const getFormatKey = (tag: ManagedTag): string => {
      if (isFlac) {
        return flacMap[tag.key] || tag.ffmpegKey.toUpperCase();
      }
      if (isMp3) {
        const mapped = mp3Map[tag.key];
        if (mapped) return mapped;
        if (tag.ffmpegKey.toUpperCase().startsWith("TXXX:")) return tag.ffmpegKey;
        const standardId3Keys = new Set(["title", "artist", "album_artist", "album", "track", "disc", "date", "genre", "comment", "isrc", "copyright"]);
        if (standardId3Keys.has(tag.key)) {
          return tag.ffmpegKey;
        }
        return `TXXX:${tag.ffmpegKey}`;
      }
      if (isM4a) {
        const mapped = m4aMap[tag.key];
        if (mapped) return mapped;
        if (tag.ffmpegKey.startsWith("----:com.apple.iTunes:")) return tag.ffmpegKey;
        const standardMp4Keys = new Set(["title", "artist", "album_artist", "album", "track", "disc", "date", "genre", "comment", "isrc", "copyright"]);
        if (standardMp4Keys.has(tag.key)) {
          return tag.ffmpegKey;
        }
        return `----:com.apple.iTunes:${tag.ffmpegKey}`;
      }
      if (isWma) {
        return wmaMap[tag.key] || `MusicBrainz/${tag.ffmpegKey}`;
      }
      if (isApe) {
        return apeMap[tag.key] || tag.ffmpegKey.toUpperCase();
      }
      return tag.ffmpegKey;
    };

    for (const tag of tags) {
      const value = normalizeComparableValue(tag.targetValue);
      if (!value) {
        continue;
      }

      const formatKey = getFormatKey(tag);
      output[formatKey] = value;

      if (!extension) {
        for (const alias of tag.writeAliases || []) {
          const key = String(alias || "").trim();
          if (key) {
            output[key] = value;
          }
        }
      }
    }

    return output;
  }

  static buildAudioTagRemovalKeys(tags: ManagedTag[], extension?: string): string[] {
    const mappedKeys = Object.keys(this.buildAudioTagWriteMap(
      tags.map((tag) => ({ ...tag, targetValue: "__remove__" })),
      extension,
    ));
    // Releases prior to 2.3.3 passed database extensions without a leading
    // dot, causing generic ffmpeg keys to be written into MP4/M4A files rather
    // than their mapped freeform atoms. Remove both shapes during repair.
    const legacyKeys = tags.flatMap((tag) => [tag.ffmpegKey, ...(tag.aliases || [])]);
    return Array.from(new Set([...mappedKeys, ...legacyKeys].map((key) => key.trim()).filter(Boolean)));
  }

  static buildManagedTagRemovals(config: MetadataConfig): ManagedTag[] {
    const removals: ManagedTag[] = [
      {
        key: "legacy_upc",
        label: "Legacy UPC",
        ffmpegKey: "UPC",
        targetValue: "",
        aliases: ["upc"],
      },
      {
        key: "legacy_ean",
        label: "Legacy EAN",
        ffmpegKey: "EAN",
        targetValue: "",
        aliases: ["ean"],
      },
    ];

    if (config.embed_replaygain === false) {
      removals.push(
        {
          key: "replaygain_track_gain",
          label: "ReplayGain Track Gain",
          ffmpegKey: "REPLAYGAIN_TRACK_GAIN",
          targetValue: "",
          aliases: ["replaygain_track_gain"],
        },
        {
          key: "replaygain_track_peak",
          label: "ReplayGain Track Peak",
          ffmpegKey: "REPLAYGAIN_TRACK_PEAK",
          targetValue: "",
          aliases: ["replaygain_track_peak"],
        },
      );
    }
    return removals;
  }

  private static buildRowManagedTagRemovals(row: RetagTrackRow, config: MetadataConfig): ManagedTag[] {
    const removals = this.buildManagedTagRemovals(config);
    if (config.embed_replaygain !== false) {
      if (row.media_replay_gain === null || row.media_replay_gain === undefined) {
        removals.push({
          key: "replaygain_track_gain",
          label: "ReplayGain Track Gain",
          ffmpegKey: "REPLAYGAIN_TRACK_GAIN",
          targetValue: "",
          aliases: ["replaygain_track_gain"],
        });
      }
      if (row.media_peak === null || row.media_peak === undefined) {
        removals.push({
          key: "replaygain_track_peak",
          label: "ReplayGain Track Peak",
          ffmpegKey: "REPLAYGAIN_TRACK_PEAK",
          targetValue: "",
          aliases: ["replaygain_track_peak"],
        });
      }
    }
    return removals;
  }

  static buildDesiredTagsForTrackFileIdsForTest(ids: number[], config: Partial<MetadataConfig> = {}): ManagedTag[] {
    const rows = this.getTrackRowsByIds(ids);
    if (rows.length === 0) {
      return [];
    }

    return this.buildDesiredTags(rows[0], {
      write_audio_tags_policy: "all_files",
      write_tidal_url: false,
      embed_replaygain: false,
      ...config,
    } as MetadataConfig);
  }

  private static async enrichMusicBrainzMetadata(row: RetagTrackRow, config: MetadataConfig): Promise<RetagTrackRow> {
    let nextRow = { ...row };

    if (nextRow.album_upc && (!nextRow.album_mbid || !nextRow.album_mb_release_group_id || !nextRow.artist_mbid)) {
      const releases = await lookupMusicBrainzReleasesByBarcode(nextRow.album_upc);
      let bestReleaseMatch: MusicBrainzReleaseMatch | null = null;

      for (const release of releases) {
        const candidate = evaluateMusicBrainzReleaseMatch(nextRow, release);
        if (!isAcceptableReleaseMatch(candidate)) {
          continue;
        }

        if (!bestReleaseMatch || candidate.score > bestReleaseMatch.score) {
          bestReleaseMatch = candidate;
        }
      }

      if (bestReleaseMatch) {
        const primaryArtistCredit = bestReleaseMatch.release.artistCredits[0];
        db.prepare(`
          UPDATE TrackFiles
          SET canonical_release_mbid = COALESCE(canonical_release_mbid, ?),
              canonical_release_group_mbid = COALESCE(canonical_release_group_mbid, ?)
          WHERE id = ?
        `).run(bestReleaseMatch.release.id, bestReleaseMatch.release.releaseGroupId, nextRow.id);

        if (primaryArtistCredit?.id) {
          db.prepare(`
            UPDATE Artists
            SET mbid = COALESCE(mbid, ?)
            WHERE id = ?
          `).run(primaryArtistCredit.id, nextRow.artist_id);
          this.refreshArtistPathFromTemplateIfNeeded(nextRow.artist_id);
        }

        nextRow = {
          ...nextRow,
          album_mbid: nextRow.album_mbid || bestReleaseMatch.release.id,
          album_mb_release_group_id: nextRow.album_mb_release_group_id || bestReleaseMatch.release.releaseGroupId,
          artist_mbid: nextRow.artist_mbid || primaryArtistCredit?.id || null,
        };
      }
    }

    if (nextRow.media_isrc && !nextRow.media_mbid) {
      const recordings = await lookupMusicBrainzRecordingsByIsrc(nextRow.media_isrc);
      let bestIsrcMatch: FingerprintRecordingMatch | null = null;

      for (const recording of recordings) {
        const candidate = evaluateFingerprintRecordingMatch(nextRow, recording);
        if (!isAcceptableFingerprintMatch(candidate)) {
          continue;
        }

        if (!bestIsrcMatch || candidate.score > bestIsrcMatch.score) {
          bestIsrcMatch = candidate;
        }
      }

      if (bestIsrcMatch) {
        const primaryArtistCredit = bestIsrcMatch.recording.artistCredits?.[0];
        db.prepare(`
          UPDATE TrackFiles
          SET canonical_recording_mbid = COALESCE(canonical_recording_mbid, ?)
          WHERE id = ?
        `).run(bestIsrcMatch.recording.id, nextRow.id);

        if (primaryArtistCredit?.id) {
          db.prepare(`
            UPDATE Artists
            SET mbid = COALESCE(mbid, ?)
            WHERE id = ?
          `).run(primaryArtistCredit.id, nextRow.artist_id);
          this.refreshArtistPathFromTemplateIfNeeded(nextRow.artist_id);
        }

        nextRow = {
          ...nextRow,
          media_mbid: bestIsrcMatch.recording.id,
          artist_mbid: nextRow.artist_mbid || primaryArtistCredit?.id || null,
        };
      }
    }

    // Canonical imports already carry their MusicBrainz recording identity.
    // Fingerprinting is only for unknown/mistagged files; attempting fpcalc on
    // Atmos E-AC-3 can fail and used to hold the import finalizer at 94%.
    if (nextRow.media_mbid) return nextRow;

    if (!config.enable_fingerprinting) {
      return nextRow;
    }

    const resolvedPath = resolveStoredLibraryPath({
      filePath: nextRow.file_path,
      libraryRoot: nextRow.library_root,
      relativePath: nextRow.relative_path,
    });

    if (!fs.existsSync(resolvedPath)) {
      return nextRow;
    }

    let fingerprint = nextRow.file_fingerprint || nextRow.media_acoustid_fingerprint;
    let fingerprintDuration = Number(nextRow.file_fingerprint_duration || nextRow.media_fingerprint_duration || nextRow.media_duration || 0) || null;

    if (!fingerprint) {
      try {
        const fingerprintResult = await generateFingerprint(resolvedPath);
        fingerprint = fingerprintResult.fingerprint;
        fingerprintDuration = fingerprintResult.duration || fingerprintDuration;

        db.prepare(`
          UPDATE TrackFiles
          SET fingerprint = ?, fingerprint_duration = ?, verified_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(fingerprint, fingerprintDuration, nextRow.id);
      } catch (error) {
        console.warn(`[Retag] Failed to fingerprint ${resolvedPath}:`, error);
        return nextRow;
      }
    }

    if (!fingerprint || !fingerprintDuration) {
      return {
        ...nextRow,
        file_fingerprint: fingerprint,
        media_duration: fingerprintDuration ?? nextRow.media_duration,
      };
    }

    let acoustidMatches: AcoustIdLookupResult[] = [];
    if (!nextRow.media_acoustid_id && !nextRow.file_acoustid_id) {
      acoustidMatches = await lookupAcoustIdMatches(fingerprint, fingerprintDuration);
    }

    const matchedKnownAcoustId = nextRow.media_mbid
      ? acoustidMatches.find((match) => match.id && match.recordingIds.includes(String(nextRow.media_mbid)))
      : null;
    const resolvedAcoustId = nextRow.media_acoustid_id || nextRow.file_acoustid_id || matchedKnownAcoustId?.id || null;

    if (nextRow.media_mbid) {
      db.prepare(`
        UPDATE TrackFiles
        SET acoustid_id = COALESCE(?, acoustid_id),
            fingerprint = COALESCE(fingerprint, ?),
            fingerprint_duration = COALESCE(fingerprint_duration, ?),
            verified_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(resolvedAcoustId, fingerprint, fingerprintDuration, nextRow.id);

      return {
        ...nextRow,
        file_fingerprint: fingerprint,
        file_acoustid_id: resolvedAcoustId,
        media_acoustid_id: resolvedAcoustId,
        media_acoustid_fingerprint: nextRow.media_acoustid_fingerprint || fingerprint,
        media_duration: fingerprintDuration ?? nextRow.media_duration,
      };
    }

    let bestFingerprintMatch: FingerprintRecordingMatch | null = null;
    let bestFingerprintAcoustId: string | null = null;
    for (const acoustid of acoustidMatches) {
      for (const recordingId of acoustid.recordingIds.slice(0, 5)) {
        const recording = await lookupMusicBrainzRecording(recordingId);
        if (!recording) {
          continue;
        }

        const candidate = evaluateFingerprintRecordingMatch(nextRow, recording);
        if (!isAcceptableFingerprintMatch(candidate)) {
          continue;
        }

        if (!bestFingerprintMatch || candidate.score > bestFingerprintMatch.score) {
          bestFingerprintMatch = candidate;
          bestFingerprintAcoustId = acoustid.id || null;
        }
      }
    }

    if (!bestFingerprintMatch) {
      return {
        ...nextRow,
        file_fingerprint: fingerprint,
        media_duration: fingerprintDuration ?? nextRow.media_duration,
      };
    }

    const fallbackIsrc = !nextRow.media_isrc && bestFingerprintMatch.recording.isrcs.length > 0
      ? bestFingerprintMatch.recording.isrcs[0]
      : null;
    const primaryArtistCredit = bestFingerprintMatch.recording.artistCredits?.[0];

    db.prepare(`
      UPDATE TrackFiles
      SET canonical_recording_mbid = COALESCE(canonical_recording_mbid, ?),
          acoustid_id = COALESCE(?, acoustid_id),
          fingerprint = COALESCE(fingerprint, ?),
          fingerprint_duration = COALESCE(fingerprint_duration, ?),
          verified_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(bestFingerprintMatch.recording.id, bestFingerprintAcoustId, fingerprint, fingerprintDuration, nextRow.id);

    if (primaryArtistCredit?.id) {
      db.prepare(`
        UPDATE Artists
        SET mbid = COALESCE(mbid, ?)
        WHERE id = ?
      `).run(primaryArtistCredit.id, nextRow.artist_id);
      this.refreshArtistPathFromTemplateIfNeeded(nextRow.artist_id);
    }

    return {
      ...nextRow,
      file_fingerprint: fingerprint,
      file_acoustid_id: bestFingerprintAcoustId || nextRow.file_acoustid_id,
      media_duration: fingerprintDuration ?? nextRow.media_duration,
      media_mbid: bestFingerprintMatch.recording.id,
      media_acoustid_id: bestFingerprintAcoustId || nextRow.media_acoustid_id,
      media_acoustid_fingerprint: nextRow.media_acoustid_fingerprint || fingerprint,
      media_isrc: nextRow.media_isrc || fallbackIsrc,
      artist_mbid: nextRow.artist_mbid || primaryArtistCredit?.id || null,
    };
  }

  private static buildDesiredTags(row: RetagTrackRow, config: MetadataConfig): ManagedTag[] {
    const fallbackArtistName = String(row.primary_artist_name || "").trim() || "Unknown Artist";
    const artistNames = this.getTrackArtistNames(row, fallbackArtistName);
    const albumArtistNames = this.getAlbumArtistNames(row, fallbackArtistName);
    const discNumber = Number(row.media_volume_number || 1);
    const discCount = Number(row.album_num_volumes || 1);
    const trackCount = this.getTrackCountForDisc(row.album_id, discNumber, row.canonical_release_mbid || row.album_mbid);
    const releaseDate = normalizeReleaseDate(row.media_release_date || row.album_release_date);

    // Resolve the MusicBrainz release track ID from the canonical Tracks table
    let releaseTrackMbid: string | null = row.canonical_track_mbid;
    if (!releaseTrackMbid && row.album_mbid && row.media_mbid) {
      const trackRow = db.prepare(`
        SELECT mbid FROM Tracks
        WHERE release_mbid = ?
          AND recording_mbid = ?
          AND medium_position = COALESCE(?, 1)
          AND position = COALESCE(?, 1)
        LIMIT 1
      `).get(
        row.album_mbid,
        row.media_mbid,
        row.media_volume_number,
        row.media_track_number
      ) as { mbid: string } | undefined;

      if (trackRow) {
        releaseTrackMbid = trackRow.mbid;
      } else {
        const fallbackRow = db.prepare(`
          SELECT mbid FROM Tracks
          WHERE release_mbid = ? AND recording_mbid = ?
          LIMIT 1
        `).get(row.album_mbid, row.media_mbid) as { mbid: string } | undefined;
        if (fallbackRow) {
          releaseTrackMbid = fallbackRow.mbid;
        }
      }
    }

    const tags: ManagedTag[] = [];

    if (resolveTagPolicy(config) !== "no") {
      tags.push(
        {
          key: "title",
          label: "Title",
          ffmpegKey: "title",
          targetValue: buildFullTitle(row.media_title, row.media_version),
        },
        {
          key: "artist",
          label: "Artist",
          ffmpegKey: "artist",
          targetValue: artistNames.join(", "),
        },
        {
          key: "album_artist",
          label: "Album Artist",
          ffmpegKey: "album_artist",
          targetValue: albumArtistNames.join(", "),
        },
        {
          key: "album",
          label: "Album",
          ffmpegKey: "album",
          targetValue: buildFullTitle(row.album_title || "Unknown Album", row.album_version),
        },
      );

      const trackPosition = formatPosition(row.media_track_number, trackCount);
      if (trackPosition) {
        tags.push({
          key: "track",
          label: "Track",
          ffmpegKey: "track",
          targetValue: trackPosition,
        });
      }
      const trackNumber = formatPositiveNumber(row.media_track_number);
      if (trackNumber) {
        tags.push({
          key: "track_number",
          label: "Track Number",
          ffmpegKey: "TRACKNUMBER",
          targetValue: trackNumber,
          aliases: ["tracknumber"],
          writeAliases: ["tracknumber"],
        });
      }
      const trackTotal = formatPositiveNumber(trackCount);
      if (trackTotal) {
        tags.push({
          key: "track_count",
          label: "Track Count",
          ffmpegKey: "TRACKTOTAL",
          targetValue: trackTotal,
          aliases: ["tracktotal", "totaltracks"],
          writeAliases: ["TOTALTRACKS", "totaltracks"],
        });
      }

      const discPosition = formatPosition(discNumber, discCount);
      if (discPosition) {
        tags.push({
          key: "disc",
          label: "Disc",
          ffmpegKey: "disc",
          targetValue: discPosition,
        });
      }
      const discNumberValue = formatPositiveNumber(discNumber);
      if (discNumberValue) {
        tags.push({
          key: "disc_number",
          label: "Disc Number",
          ffmpegKey: "DISCNUMBER",
          targetValue: discNumberValue,
          aliases: ["discnumber"],
          writeAliases: ["discnumber"],
        });
      }
      const discTotal = formatPositiveNumber(discCount);
      if (discTotal) {
        tags.push({
          key: "disc_count",
          label: "Disc Count",
          ffmpegKey: "DISCTOTAL",
          targetValue: discTotal,
          aliases: ["disctotal", "totaldiscs"],
          writeAliases: ["TOTALDISCS", "totaldiscs"],
        });
      }

      if (releaseDate) {
        tags.push({
          key: "date",
          label: "Date",
          ffmpegKey: "date",
          targetValue: releaseDate,
        });
      }

      const originalDate = String(row.album_original_date || "").trim();
      if (originalDate) {
        tags.push({
          key: "original_date",
          label: "Original Release Date",
          ffmpegKey: "original_date",
          targetValue: originalDate,
          aliases: [
            "originaldate",
            "original_date",
            "original year",
            "originalreleaseyear",
            "tdor",
            "tory",
            "original date",
            "Original Release Date",
          ],
          writeAliases: [
            "ORIGINALDATE",
            "ORIGINALYEAR",
          ],
        });
      }

      const mediaFormat = String(row.media_format || "Digital Media").trim();
      if (mediaFormat) {
        tags.push({
          key: "media_format",
          label: "Media Format",
          ffmpegKey: "media_format",
          targetValue: mediaFormat,
          aliases: ["media_format", "media", "tmed", "Media Format"],
          writeAliases: ["MEDIA"],
        });
      }

      // Kodi/Jellyfin/Picard read genre from embedded tags (not album.nfo for
      // Jellyfin). Join with " / " — Kodi's default multi-value divider.
      const albumGenres = parseJsonStringList(row.album_genres);
      if (albumGenres.length > 0) {
        tags.push({
          key: "genre",
          label: "Genre",
          ffmpegKey: "genre",
          targetValue: albumGenres.join(" / "),
        });
      }

      if (row.media_isrc) {
        tags.push({
          key: "isrc",
          label: "ISRC",
          ffmpegKey: "isrc",
          targetValue: String(row.media_isrc),
        });
      }

      if (row.media_copyright) {
        tags.push({
          key: "copyright",
          label: "Copyright",
          ffmpegKey: "copyright",
          targetValue: String(row.media_copyright),
        });
      }

      if (row.album_upc) {
        tags.push({
          key: "barcode",
          label: "Barcode",
          ffmpegKey: "BARCODE",
          targetValue: String(row.album_upc),
          aliases: ["barcode"],
        });
      }

      // Picard/Kodi LABEL / publisher — first label from AlbumEditions.label JSON.
      const albumLabels = parseJsonStringList(row.album_label);
      if (albumLabels.length > 0) {
        tags.push({
          key: "label",
          label: "Label",
          ffmpegKey: "LABEL",
          targetValue: albumLabels[0],
          aliases: ["publisher"],
        });
      }

      if (config.write_tidal_url) {
        tags.push({
          key: "provider_url",
          label: "provider URL",
          ffmpegKey: "PROVIDER_URL",
          targetValue: buildProviderTrackUrl(row),
          aliases: ["provider_url", "tidal_url", "url", "purl"],
        });
      }

      if (row.media_mbid) {
        tags.push({
          key: "musicbrainz_recordingid",
          label: "MusicBrainz Recording ID",
          ffmpegKey: "musicbrainz_recordingid",
          targetValue: String(row.media_mbid),
          aliases: [
            "musicbrainz_recordingid",
            "musicbrainzrecordingid",
            "musicbrainz recording id",
            "musicbrainz track id",
            "musicbrainz_trackid",
            "musicbrainztrackid",
            "MusicBrainz Track Id",
          ],
        });
      }

      if (row.album_mbid) {
        tags.push({
          key: "musicbrainz_albumid",
          label: "MusicBrainz Release ID",
          ffmpegKey: "musicbrainz_albumid",
          targetValue: String(row.album_mbid),
          aliases: [
            "musicbrainz_albumid",
            "musicbrainzalbumid",
            "musicbrainz album id",
            "MusicBrainz Album Id",
          ],
        });
      }

      if (row.artist_mbid) {
        tags.push({
          key: "musicbrainz_albumartistid",
          label: "MusicBrainz Album Artist ID",
          ffmpegKey: "musicbrainz_albumartistid",
          targetValue: String(row.artist_mbid),
          aliases: [
            "musicbrainz_albumartistid",
            "musicbrainzalbumartistid",
            "musicbrainz album artist id",
            "MusicBrainz Album Artist Id",
          ],
        });
        tags.push({
          key: "musicbrainz_artistid",
          label: "MusicBrainz Artist ID",
          ffmpegKey: "musicbrainz_artistid",
          targetValue: String(row.artist_mbid),
          aliases: [
            "musicbrainz_artistid",
            "musicbrainzartistid",
            "musicbrainz artist id",
            "MusicBrainz Artist Id",
          ],
        });
      }

      if (row.album_mb_release_group_id) {
        tags.push({
          key: "musicbrainz_releasegroupid",
          label: "MusicBrainz Release Group ID",
          ffmpegKey: "musicbrainz_releasegroupid",
          targetValue: String(row.album_mb_release_group_id),
          aliases: [
            "musicbrainz_releasegroupid",
            "musicbrainzreleasegroupid",
            "musicbrainz release group id",
            "MusicBrainz Release Group Id",
          ],
        });
      }

      if (releaseTrackMbid) {
        tags.push({
          key: "musicbrainz_releasetrackid",
          label: "MusicBrainz Release Track ID",
          ffmpegKey: "MUSICBRAINZ_RELEASETRACKID",
          targetValue: String(releaseTrackMbid),
          aliases: [
            "musicbrainz_releasetrackid",
            "musicbrainzreleasetrackid",
            "musicbrainz release track id",
            "MusicBrainz Release Track Id",
          ],
          writeAliases: [
            "musicbrainz_releasetrackid",
            "musicbrainzreleasetrackid",
            "MusicBrainz Release Track Id",
          ],
        });
      }

      if (row.release_country) {
        const releaseCountry = formatReleaseCountryTag(row.release_country);
        if (releaseCountry) {
          tags.push({
            key: "release_country",
            label: "Release Country",
            ffmpegKey: "release_country",
            targetValue: releaseCountry,
            aliases: [
              "releasecountry",
              "release_country",
              "musicbrainz album release country",
              "MusicBrainz Album Release Country",
            ],
          });
        }
      }

      const musicalKey = String(row.media_musical_key || "").trim();
      if (musicalKey) {
        tags.push({
          key: "initialkey",
          label: "Initial Key",
          ffmpegKey: "INITIALKEY",
          targetValue: musicalKey,
          aliases: ["initialkey", "initial_key", "tkey", "key"],
        });
      }

      if (row.release_status) {
        tags.push({
          key: "release_status",
          label: "Release Status",
          ffmpegKey: "release_status",
          targetValue: String(row.release_status).toLowerCase(),
          aliases: [
            "releasestatus",
            "release_status",
            "musicbrainz album status",
            "MusicBrainz Album Status",
          ],
        });
      }

      let releaseType: string | null = null;
      if (row.release_primary_type) {
        let secondaryList: string[] = [];
        if (row.release_secondary_types) {
          try {
            secondaryList = JSON.parse(row.release_secondary_types)
              .map((t: string) => t.toLowerCase())
              .filter(Boolean);
          } catch {
            // ignore
          }
        }
        // When secondary release types exist (e.g. live, compilation, soundtrack, remix),
        // use "album" as the primary type so Plex and media servers categorize the
        // release properly into categories (e.g. "album; live" instead of "ep; live").
        const primary = secondaryList.length > 0
          ? "album"
          : row.release_primary_type.toLowerCase();

        const typeSet = new Set<string>([primary, ...secondaryList]);
        releaseType = Array.from(typeSet).join("; ");
      }
      if (releaseType) {
        tags.push({
          key: "release_type",
          label: "Release Type",
          ffmpegKey: "release_type",
          targetValue: releaseType,
          aliases: [
            "releasetype",
            "release_type",
            "musicbrainz album type",
            "MusicBrainz Album Type",
            "musicbrainz_albumtype",
            "MUSICBRAINZ_ALBUMTYPE",
          ],
          writeAliases: [
            "RELEASETYPE",
            "MUSICBRAINZ_ALBUMTYPE",
          ],
        });
      }

      // AcoustID id/fingerprint are deliberately NOT embedded: we write only
      // MusicBrainz IDs (what media servers typically read) and use fpcalc/
      // AcoustID purely as INTERNAL import-match evidence — never as a written
      // tag. The fingerprint stays in TrackFiles for
      // matching/verification but is not surfaced as an embedded tag.

      if (row.media_explicit !== null && row.media_explicit !== undefined) {
        tags.push({
          key: "itunesadvisory",
          label: "iTunes Advisory",
          ffmpegKey: "ITUNESADVISORY",
          targetValue: String(Number(row.media_explicit) ? 1 : 0),
          aliases: ["itunesadvisory", "rtng", "rating"],
        });
      }

      if (config.embed_album_review && row.album_review_text) {
        const portableReviewText = cleanProviderText(row.album_review_text);
        const reviewText = portableReviewText.length > 4096
          ? portableReviewText.slice(0, 4093) + "..."
          : portableReviewText;
        tags.push({
          key: "comment",
          label: "Comment (Album Review)",
          ffmpegKey: "comment",
          targetValue: reviewText,
          aliases: ["comment", "\xa9cmt"],
        });
      }

      // Role credits (Vocalist, Composer, Producer, etc.) — same convention as Orpheus.
      if (row.media_credits) {
        try {
          const credits = JSON.parse(row.media_credits) as Array<{ type?: unknown; contributors?: Array<{ name?: unknown }> }>;
          for (const credit of credits) {
            const role = String(credit.type || "").trim().replace(/[:\\/*?"<>|$]/g, "");
            if (!role) continue;
            const contributors = (credit.contributors ?? [])
              .map((c) => String(c.name || "").trim())
              .filter(Boolean)
              .join(", ");
            if (!contributors) continue;
            tags.push({
              key: `credit_${role.toLowerCase()}`,
              label: role,
              ffmpegKey: role,
              targetValue: contributors,
            });
          }
        } catch {
          // malformed credits JSON — skip silently
        }
      }
    }

    if (config.embed_replaygain) {
      const replayGain = formatReplayGain(row.media_replay_gain);
      if (replayGain) {
        tags.push({
          key: "replaygain_track_gain",
          label: "ReplayGain Track Gain",
          ffmpegKey: "REPLAYGAIN_TRACK_GAIN",
          targetValue: replayGain,
          aliases: ["replaygain_track_gain"],
        });
      }

      const replayPeak = formatReplayPeak(row.media_peak);
      if (replayPeak) {
        tags.push({
          key: "replaygain_track_peak",
          label: "ReplayGain Track Peak",
          ffmpegKey: "REPLAYGAIN_TRACK_PEAK",
          targetValue: replayPeak,
          aliases: ["replaygain_track_peak"],
        });
      }
    }

    return tags.filter((tag) => Boolean(normalizeComparableValue(tag.targetValue)));
  }

  private static async evaluateRow(
    row: RetagTrackRow,
    config: MetadataConfig,
    options: RetagEvaluationOptions = {},
  ): Promise<RetagPreviewItem> {
    const resolvedPath = resolveStoredLibraryPath({
      filePath: row.file_path,
      libraryRoot: row.library_root,
      relativePath: row.relative_path,
    });

    if (!fs.existsSync(resolvedPath)) {
      return {
        id: row.id,
        artistId: row.artist_id,
        albumId: row.album_id,
        mediaId: row.media_id,
        path: resolvedPath,
        missing: true,
        changes: [],
      };
    }

    const desiredTags = this.buildDesiredTags(row, config);

    const quality = getConfigSection("quality");
    if (options.includeExternalMetadata !== false && quality.embed_lyrics && row.file_provider_id) {
      const lyrics = await resolveLyricsForRetagRow(row, true, options.lyricsByProviderMedia);
      const lyricTag = buildEmbeddedLyricsManagedTag(lyrics);
      if (lyricTag) desiredTags.push(lyricTag);
    }

    const removals = this.buildRowManagedTagRemovals(row, config);
    if (desiredTags.length === 0 && removals.length === 0) {
      return {
        id: row.id,
        artistId: row.artist_id,
        albumId: row.album_id,
        mediaId: row.media_id,
        path: resolvedPath,
        missing: false,
        changes: [],
      };
    }

    try {
      const metadata = await mm.parseFile(resolvedPath, { skipCovers: false, duration: false });
      const lookup = buildNativeLookup(metadata);
      mergeMp4KeyedNativeLookup(metadata, lookup, resolvedPath);
      const changes = desiredTags.reduce<RetagDifference[]>((result, tag) => {
        const currentValue = getCurrentTagValue(metadata, lookup, tag);
        if (normalizeComparableValue(currentValue) !== normalizeComparableValue(tag.targetValue)) {
          result.push({
            field: tag.label,
            oldValue: currentValue,
            newValue: tag.targetValue,
          });
        }
        return result;
      }, []);
      for (const tag of removals) {
        const currentValue = getCurrentTagValue(metadata, lookup, tag);
        if (normalizeComparableValue(currentValue)) {
          changes.push({
            field: tag.label,
            oldValue: currentValue,
            newValue: null,
          });
        }
      }

      if (quality.embed_cover) {
        // Compare the embedded cover exactly as the apply does, reusing the
        // picture from the single metadata parse above (covr-atom fallback for
        // MP4 inside compareEmbeddedAudioCover). This keeps the preview honest —
        // files whose art music-metadata can't read (Atmos M4A) are no longer
        // flagged for embedding forever — with no subprocess. A local cover
        // context is created only when the batch did not supply a shared one.
        const ownsContext = !options.embeddedCoverContext;
        const coverContext = options.embeddedCoverContext
          ?? { byAlbum: new Map(), temporaryDirectories: [] };
        const preferredCover = await resolvePreferredEmbeddedCover(row, config, resolvedPath, coverContext);
        if (preferredCover) {
          const currentPicture = metadata.common?.picture?.[0]?.data ?? null;
          const comparison = await compareEmbeddedAudioCover(resolvedPath, preferredCover, currentPicture);
          if (!shouldSkipCoverEmbed(comparison)) {
            changes.push({
              field: "Cover Art",
              oldValue: formatCoverInfo(comparison.current),
              newValue: formatCoverInfo(comparison.target),
            });
          }
        }
        if (ownsContext) {
          for (const tempDir of coverContext.temporaryDirectories) {
            try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
          }
        }
      }

      return {
        id: row.id,
        artistId: row.artist_id,
        albumId: row.album_id,
        mediaId: row.media_id,
        path: resolvedPath,
        missing: false,
        changes,
      };
    } catch (error) {
      return {
        id: row.id,
        artistId: row.artist_id,
        albumId: row.album_id,
        mediaId: row.media_id,
        path: resolvedPath,
        missing: false,
        error: error instanceof Error ? error.message : "Metadata read failed",
        changes: [{
          field: "Metadata",
          oldValue: "Unreadable",
          newValue: "Re-tag file",
        }],
      };
    }
  }

  private static async evaluateRows(
    rows: RetagTrackRow[],
    config: MetadataConfig,
    options: RetagEvaluationOptions = {},
  ): Promise<RetagPreviewItem[]> {
    // One cover context for the whole batch so an album's embedded-cover
    // rendition is resolved/downloaded once, not per track.
    const embeddedCoverContext: EmbeddedCoverContext = options.embeddedCoverContext
      ?? { byAlbum: new Map(), temporaryDirectories: [] };
    const scopedOptions: RetagEvaluationOptions = { ...options, embeddedCoverContext };

    // Read files concurrently (Lidarr-style) instead of one-at-a-time — the
    // per-file disk read/parse is the dominant cost of a preview, so a bounded
    // fan-out cuts wall-clock roughly linearly. Promise.all preserves row order.
    const limit = pLimit(RETAG_EVALUATION_CONCURRENCY);
    try {
      return await Promise.all(
        rows.map((row) => limit(() => this.evaluateRow(row, config, scopedOptions))),
      );
    } finally {
      if (!options.embeddedCoverContext) {
        for (const tempDir of embeddedCoverContext.temporaryDirectories) {
          try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
        }
      }
    }
  }

  static async preview(options: RetagScopeOptions = {}): Promise<RetagPreviewItem[]> {
    const config = getConfigSection("metadata") as MetadataConfig;
    if (!isRetagMaintenanceEnabled(config)) {
      return [];
    }

    const rows = this.getTrackRows(options, true);
    // Preview must not network-fetch lyrics (status already disables this).
    // Disk tag reads alone decide what would change on Apply.
    const items = await this.evaluateRows(rows, config, { includeExternalMetadata: false });
    return items.filter((item) => item.missing || item.changes.length > 0);
  }

  static async getStatus(options: RetagScopeOptions = {}, sampleLimit = 10): Promise<RetagStatusSummary> {
    const config = getConfigSection("metadata") as MetadataConfig;
    const total = this.getTrackCount(options);

    if (!isRetagMaintenanceEnabled(config)) {
      return {
        enabled: false,
        total,
        scanned: 0,
        limited: false,
        retagNeeded: 0,
        missing: 0,
        sample: [],
      };
    }

    const scanLimit = Math.max(1, Math.min(1000, options.limit ?? 25));
    const rows = this.getTrackRows({ ...options, limit: scanLimit, offset: 0 }, true);
    const items = await this.evaluateRows(rows, config, { includeExternalMetadata: false });
    const actionable = items.filter((item) => item.missing || item.changes.length > 0);

    return {
      enabled: true,
      total,
      scanned: items.length,
      limited: total > items.length,
      retagNeeded: actionable.filter((item) => !item.missing && item.changes.length > 0).length,
      missing: items.filter((item) => item.missing).length,
      sample: actionable.slice(0, Math.max(0, sampleLimit)),
    };
  }

  private static async syncEmbeddedCoverForRow(
    row: RetagTrackRow,
    config: MetadataConfig,
    mediaPath: string,
    context: EmbeddedCoverContext,
  ): Promise<EmbeddedCoverSyncOutcome> {
    const quality = getConfigSection("quality");
    if (quality.embed_cover === false) return "unchanged";
    const coverPath = await resolvePreferredEmbeddedCover(row, config, mediaPath, context);
    if (!coverPath) return "unchanged";
    if (shouldSkipCoverEmbed(await compareEmbeddedAudioCover(mediaPath, coverPath))) {
      return "unchanged";
    }
    return await embedAudioCover(mediaPath, coverPath) ? "embedded" : "failed";
  }

  /**
   * Reconcile only embedded artwork for tracked files. This is the sole
   * backfill/import entry point and shares the same cached-master + 1200px cap
   * as normal retagging; it never downloads artwork or rewrites other tags.
   */
  static async syncEmbeddedCovers(ids: number[]): Promise<RetagApplyResult> {
    const uniqueIds = Array.from(new Set(
      ids.map((id) => Number(id)).filter((id) => Number.isFinite(id)),
    ));
    const result: RetagApplyResult = {
      retagged: 0,
      skipped: 0,
      missing: 0,
      errors: [],
    };
    if (uniqueIds.length === 0) return result;

    const config = getConfigSection("metadata") as MetadataConfig;
    const rowsById = new Map(this.getTrackRowsByIds(uniqueIds).map((row) => [row.id, row]));
    const context: EmbeddedCoverContext = {
      byAlbum: new Map(),
      temporaryDirectories: [],
    };
    const updated: Array<[number, string, number]> = [];

    try {
      for (const id of uniqueIds) {
        const row = rowsById.get(id);
        if (!row) {
          result.missing++;
          continue;
        }
        const mediaPath = resolveStoredLibraryPath({
          filePath: row.file_path,
          libraryRoot: row.library_root,
          relativePath: row.relative_path,
        });
        if (!fs.existsSync(mediaPath)) {
          result.missing++;
          continue;
        }
        try {
          const outcome = await this.syncEmbeddedCoverForRow(row, config, mediaPath, context);
          if (outcome === "embedded") {
            const stat = fs.statSync(mediaPath);
            updated.push([stat.size, stat.mtime.toISOString(), id]);
            result.retagged++;
          } else if (outcome === "failed") {
            result.errors.push({ id, error: "Embedded cover write failed" });
          } else {
            result.skipped++;
          }
        } catch (error) {
          result.errors.push({
            id,
            error: error instanceof Error ? error.message : "Embedded cover sync failed",
          });
        }
      }
    } finally {
      for (const tempDir of context.temporaryDirectories) {
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ }
      }
    }

    if (updated.length > 0) {
      const update = db.prepare(`
        UPDATE TrackFiles
        SET file_size = ?, modified_at = ?, verified_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `);
      db.transaction(() => {
        for (const values of updated) update.run(...values);
      })();
    }
    return result;
  }

  static async apply(ids: number[], options: RetagApplyOptions = {}): Promise<RetagApplyResult> {
    const config = getConfigSection("metadata") as MetadataConfig;
    if (!isRetagMaintenanceEnabled(config)) {
      throw new Error("Enable fingerprinting, imported audio tag correction, or ReplayGain tagging before applying retag operations.");
    }

    const result: RetagApplyResult = {
      retagged: 0,
      skipped: 0,
      missing: 0,
      errors: [],
    };

    if (!ids || ids.length === 0) {
      return result;
    }

    const rowsById = new Map(this.getTrackRowsByIds(ids).map((row) => [row.id, row]));
    const updateFileRecord = db.prepare(`
      UPDATE TrackFiles
      SET file_size = ?, modified_at = ?, verified_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);

    const pendingUpdates: Array<[number, string, number]> = []; // [size, mtime, id]
    const lyricsByProviderMedia = options.lyricsByProviderMedia ?? new Map<string, ResolvedLyrics | null>();
    const quality = getConfigSection("quality");
    const embeddedCoverContext: EmbeddedCoverContext = {
      byAlbum: new Map(),
      temporaryDirectories: [],
    };

    const applyPreferredCover = async (row: RetagTrackRow, mediaPath: string, id: number): Promise<boolean> => {
      const outcome = await this.syncEmbeddedCoverForRow(
        row,
        config,
        mediaPath,
        embeddedCoverContext,
      );
      if (outcome === "failed") {
        result.errors.push({ id, error: "Embedded cover write failed" });
      }
      return outcome === "embedded";
    };

    let processedCount = 0;
    for (const id of ids) {
      processedCount++;
      options.onProgress?.(processedCount, ids.length);

      const row = rowsById.get(id);
      if (!row) {
        result.skipped++;
        continue;
      }

      const enrichedRow = await this.enrichMusicBrainzMetadata(row, config);

      const resolvedPath = resolveStoredLibraryPath({
        filePath: enrichedRow.file_path,
        libraryRoot: enrichedRow.library_root,
        relativePath: enrichedRow.relative_path,
      });

      if (!fs.existsSync(resolvedPath)) {
        result.missing++;
        continue;
      }

      const preview = await this.evaluateRow(enrichedRow, config, {
        includeExternalMetadata: options.includeExternalLyrics !== false,
        lyricsByProviderMedia,
      });
      if (!preview.missing && preview.changes.length === 0) {
        const coverUpdated = await applyPreferredCover(enrichedRow, resolvedPath, id);
        if (coverUpdated) {
          const stat = fs.statSync(resolvedPath);
          pendingUpdates.push([stat.size, stat.mtime.toISOString(), id]);
          result.retagged++;
        } else {
          result.skipped++;
        }
        continue;
      }

      const desiredTagsArr = this.buildDesiredTags(enrichedRow, config);

      if (options.includeExternalLyrics !== false && quality.embed_lyrics && enrichedRow.file_provider_id) {
        const lyrics = await resolveLyricsForRetagRow(enrichedRow, true, lyricsByProviderMedia);
        const lyricTag = buildEmbeddedLyricsManagedTag(lyrics);
        if (lyricTag) desiredTagsArr.push(lyricTag);
      }

      const desiredTags = this.buildAudioTagWriteMap(desiredTagsArr, enrichedRow.extension);
      const removalKeys = this.buildAudioTagRemovalKeys(this.buildRowManagedTagRemovals(enrichedRow, config), enrichedRow.extension);

      if (shouldSkipEmbeddedAudioTagWrite(enrichedRow)) {
        console.warn(`[Retag] Skipping embedded tag rewrite for ${resolvedPath}; ${enrichedRow.extension || "file"} ${enrichedRow.file_codec || "spatial"} is not safely writable with ffmpeg stream copy.`);
        result.skipped++;
        continue;
      }

      // Scrub all existing tags before writing
      if (config.scrub_audio_tags) {
        const scrubbed = await removeAllTags(resolvedPath);
        if (!scrubbed) {
          result.errors.push({ id, error: "Tag scrub failed" });
          continue;
        }
      }

      const success = await writeMetadata(resolvedPath, desiredTags, removalKeys);
      if (!success) {
        result.errors.push({ id, error: "Metadata write failed" });
        continue;
      }

      await applyPreferredCover(enrichedRow, resolvedPath, id);
      const stat = fs.statSync(resolvedPath);
      pendingUpdates.push([stat.size, stat.mtime.toISOString(), id]);
      result.retagged++;
    }

    for (const tempDir of embeddedCoverContext.temporaryDirectories) {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best-effort temp cleanup */ }
    }

    // Commit all DB updates in a single transaction
    if (pendingUpdates.length > 0) {
      db.transaction(() => {
        for (const [size, mtime, id] of pendingUpdates) {
          updateFileRecord.run(size, mtime, id);
        }
      })();
    }

    return result;
  }

  static async applyForMediaIds(
    mediaIds: Array<string | number>,
    options: RetagMediaIdOptions = {},
  ): Promise<RetagApplyResult> {
    const uniqueMediaIds = Array.from(new Set(mediaIds.map((id) => String(id).trim()).filter(Boolean)));
    if (uniqueMediaIds.length === 0) {
      return {
        retagged: 0,
        skipped: 0,
        missing: 0,
        errors: [],
      };
    }

    // Imported track files are usually matched by provider track id. Keep this
    // tolerant because organizer results from older/local import paths may carry
    // canonical track or recording MBIDs instead, and provider_entity_type can be
    // absent on rows created before the current provider-id-only pipeline.
    const placeholders = uniqueMediaIds.map(() => "?").join(",");
    const requestedProvider = String(options.provider || "").trim();
    const providerClause = requestedProvider ? "AND provider = ?" : "";
    const libraryFileIds = db.prepare(`
      SELECT id
      FROM TrackFiles
      WHERE file_type = 'track'
        AND (
          provider_id IN (${placeholders})
          OR canonical_track_mbid IN (${placeholders})
          OR canonical_recording_mbid IN (${placeholders})
        )
        ${providerClause}
    `).all(
      ...uniqueMediaIds,
      ...uniqueMediaIds,
      ...uniqueMediaIds,
      ...(requestedProvider ? [requestedProvider] : []),
    ) as Array<{ id: number }>;

    return this.apply(libraryFileIds.map((row) => row.id), {
      includeExternalLyrics: options.includeExternalLyrics ?? false,
      lyricsByProviderMedia: options.lyricsByProviderMedia,
      onProgress: options.onProgress,
    });
  }

  static async applyByQuery(options: RetagScopeOptions = {}): Promise<RetagApplyResult> {
    const config = getConfigSection("metadata") as MetadataConfig;
    if (!isRetagMaintenanceEnabled(config)) {
      throw new Error("Enable fingerprinting, imported audio tag correction, or ReplayGain tagging before applying retag operations.");
    }

    const items = await this.evaluateRows(this.getTrackRows(options, false), config);
    const ids = items
      .filter((item) => !item.missing && item.changes.length > 0)
      .map((item) => item.id);

    return this.apply(ids, { onProgress: options.onProgress });
  }

  /**
   * Lidarr-style strip tags: remove embedded metadata from audio files without
   * rewriting catalog tags. Skips Atmos/spatial files that are not safely writable.
   */
  static async stripTags(ids: number[]): Promise<RetagApplyResult> {
    const uniqueIds = Array.from(new Set(ids.map((id) => Number(id)).filter((id) => Number.isFinite(id))));
    const result: RetagApplyResult = {
      retagged: 0,
      skipped: 0,
      missing: 0,
      errors: [],
    };
    if (uniqueIds.length === 0) return result;

    const rows = this.getTrackRowsByIds(uniqueIds);
    const found = new Set(rows.map((row) => row.id));
    for (const id of uniqueIds) {
      if (!found.has(id)) result.missing++;
    }

    for (const row of rows) {
      const resolvedPath = resolveStoredLibraryPath({
        filePath: row.file_path,
        libraryRoot: row.library_root,
      });
      if (!fs.existsSync(resolvedPath)) {
        result.missing++;
        continue;
      }
      if (shouldSkipEmbeddedAudioTagWrite(row)) {
        result.skipped++;
        continue;
      }
      const scrubbed = await removeAllTags(resolvedPath);
      if (!scrubbed) {
        result.errors.push({ id: row.id, error: "Tag strip failed" });
        continue;
      }
      result.retagged++;
    }

    return result;
  }

  static async stripTagsByScope(options: RetagScopeOptions = {}): Promise<RetagApplyResult> {
    const rows = this.getTrackRows(options, false);
    return this.stripTags(rows.map((row) => row.id));
  }
}



