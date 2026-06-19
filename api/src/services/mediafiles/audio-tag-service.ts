import fs from "fs";
import * as mm from "music-metadata";
import { db } from "../../database.js";
import { type MetadataConfig, type WriteAudioTagsPolicy, getConfigSection } from "../config/config.js";
import { writeMetadata, removeAllTags } from "./audioUtils.js";
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
  album_title: string | null;
  album_version: string | null;
  album_release_date: string | null;
  album_num_volumes: number | null;
  album_upc: string | null;
  album_review_text: string | null;
  media_credits: string | null;
  media_mbid: string | null;
  media_acoustid_id: string | null;
  media_acoustid_fingerprint: string | null;
  media_fingerprint_duration: number | null;
  media_explicit: number | null;
  album_mbid: string | null;
  album_mb_release_group_id: string | null;
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

export type ManagedTag = {
  key: string;
  label: string;
  ffmpegKey: string;
  targetValue: string;
  aliases?: string[];
  writeAliases?: string[];
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

export type RetagScopeOptions = {
  artistId?: string;
  albumId?: string;
  limit?: number;
  offset?: number;
};

function buildFullTitle(title: string | null | undefined, version: string | null | undefined): string {
  const baseTitle = String(title || "").trim() || "Unknown Track";
  const normalizedVersion = String(version || "").trim();

  if (!normalizedVersion) {
    return baseTitle;
  }

  return baseTitle.toLowerCase().includes(normalizedVersion.toLowerCase())
    ? baseTitle
    : `${baseTitle} (${normalizedVersion})`;
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
  void row;
  return false;
}

/**
 * Resolve the effective tag write policy from config, supporting both the
 * legacy boolean `write_audio_metadata` and the new Lidarr-aligned enum
 * `write_audio_tags_policy`.
 */
function resolveTagPolicy(config: MetadataConfig): WriteAudioTagsPolicy {
  if (config.write_audio_tags_policy) return config.write_audio_tags_policy;
  return config.write_audio_metadata === true ? "all_files" : "no";
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
      const credits = parsed["artist-credit"] || parsed.artistCredits || parsed.artist_credits;
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

function formatPosition(no: number | null | undefined, of: number | null | undefined): string | null {
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

function formatPositiveNumber(value: number | null | undefined): string | null {
  const numeric = Number(value || 0);
  return numeric > 0 ? String(numeric) : null;
}

function formatReplayGain(value: number | null | undefined): string | null {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }

  const prefix = numeric >= 0 ? "+" : "";
  return `${prefix}${numeric.toFixed(2)} dB`;
}

function formatReplayPeak(value: number | null | undefined): string | null {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }

  return numeric.toFixed(6);
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
      where.push("lf.album_id = ?");
      params.push(options.albumId);
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
      where.push("lf.album_id = ?");
      params.push(options.albumId);
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
        lf.album_id,
        lf.media_id,
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
          provider_track.duration
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
          CASE WHEN json_valid(provider_track.data) THEN json_extract(provider_track.data, '$.copyright') END
        ) AS media_copyright,
        canonical_recording.replay_gain AS media_replay_gain,
        canonical_recording.peak AS media_peak,
        COALESCE(canonical_group.title, canonical_release.title, alb.title, provider_album.title) AS album_title,
        CASE WHEN COALESCE(lf.canonical_release_group_mbid, provider_album.release_group_mbid, provider_track.release_group_mbid) IS NOT NULL THEN NULL ELSE provider_album.version END AS album_version,
        COALESCE(canonical_release.date, ar.date, provider_album.release_date) AS album_release_date,
        canonical_release.media_count AS album_num_volumes,
        COALESCE(canonical_release.barcode, provider_album.upc) AS album_upc,
        COALESCE(
          canonical_group.review_text,
          alb.review_text,
          CASE WHEN json_valid(provider_album.data) THEN json_extract(provider_album.data, '$.review_text') END,
          CASE WHEN json_valid(provider_album.data) THEN json_extract(provider_album.data, '$.review') END
        ) AS album_review_text,
        COALESCE(canonical_recording.credits, provider_recording.credits) AS media_credits,
        COALESCE(lf.canonical_recording_mbid, canonical_track.recording_mbid, provider_canonical_track.recording_mbid, provider_track.recording_mbid, provider_recording.mbid) AS media_mbid,
        lf.acoustid_id AS media_acoustid_id,
        lf.fingerprint AS media_acoustid_fingerprint,
        lf.fingerprint_duration AS media_fingerprint_duration,
        provider_track.explicit AS media_explicit,
        COALESCE(lf.canonical_release_mbid, canonical_track.release_mbid, provider_canonical_track.release_mbid, provider_track.release_mbid, provider_album.release_mbid) AS album_mbid,
        COALESCE(lf.canonical_release_group_mbid, provider_track.release_group_mbid, provider_album.release_group_mbid) AS album_mb_release_group_id,
        COALESCE(lf.canonical_artist_mbid, canonical_recording.artist_mbid, provider_recording.artist_mbid, provider_track.artist_mbid, provider_album.artist_mbid, artist.mbid) AS artist_mbid,
        COALESCE(canonical_release.status, ar.status) AS release_status,
        COALESCE(canonical_release.country, ar.country) AS release_country,
        COALESCE(canonical_group.primary_type, alb.primary_type) AS release_primary_type,
        COALESCE(canonical_group.secondary_types, alb.secondary_types) AS release_secondary_types,
        COALESCE(lf.canonical_release_mbid, canonical_track.release_mbid, provider_canonical_track.release_mbid, provider_track.release_mbid, provider_album.release_mbid) AS canonical_release_mbid,
        COALESCE(lf.canonical_track_mbid, canonical_track.mbid, provider_canonical_track.mbid, provider_track.track_mbid) AS canonical_track_mbid,
        COALESCE(lf.canonical_recording_mbid, canonical_track.recording_mbid, provider_canonical_track.recording_mbid, provider_track.recording_mbid, provider_recording.mbid) AS canonical_recording_mbid,
        COALESCE(canonical_recording.artist_credit, provider_recording.artist_credit) AS recording_artist_credit,
        COALESCE(canonical_recording.data, provider_recording.data) AS recording_data
      FROM TrackFiles lf
      JOIN Artists artist ON artist.id = lf.artist_id
      LEFT JOIN Tracks canonical_track ON canonical_track.mbid = lf.canonical_track_mbid
      LEFT JOIN AlbumReleases canonical_release ON canonical_release.mbid = lf.canonical_release_mbid
      LEFT JOIN Albums canonical_group ON canonical_group.mbid = lf.canonical_release_group_mbid
      LEFT JOIN Recordings canonical_recording
        ON canonical_recording.mbid = COALESCE(lf.canonical_recording_mbid, canonical_track.recording_mbid)
      LEFT JOIN ProviderItems provider_track
        ON provider_track.rowid = (
          SELECT candidate.rowid
          FROM ProviderItems candidate
          WHERE candidate.entity_type = 'track'
            AND (
              (
                COALESCE(CASE WHEN lf.provider_entity_type = 'track' THEN lf.provider_id END, lf.media_id) IS NOT NULL
                AND CAST(candidate.provider_id AS TEXT) = CAST(COALESCE(CASE WHEN lf.provider_entity_type = 'track' THEN lf.provider_id END, lf.media_id) AS TEXT)
                AND (lf.provider IS NULL OR candidate.provider = lf.provider)
              )
              OR (
                COALESCE(CASE WHEN lf.provider_entity_type = 'track' THEN lf.provider_id END, lf.media_id) IS NULL
                AND (
                  (lf.canonical_track_mbid IS NOT NULL AND candidate.track_mbid = lf.canonical_track_mbid)
                  OR (lf.canonical_recording_mbid IS NOT NULL AND candidate.recording_mbid = lf.canonical_recording_mbid)
                  OR (canonical_track.mbid IS NOT NULL AND candidate.track_mbid = canonical_track.mbid)
                  OR (canonical_recording.mbid IS NOT NULL AND candidate.recording_mbid = canonical_recording.mbid)
                  OR (canonical_recording.id IS NOT NULL AND candidate.recording_id = canonical_recording.id)
                )
              )
            )
          ORDER BY
            CASE candidate.library_slot WHEN 'stereo' THEN 0 WHEN 'spatial' THEN 1 ELSE 2 END,
            candidate.updated_at DESC,
            candidate.provider_id ASC
          LIMIT 1
        )
      LEFT JOIN Tracks provider_canonical_track
        ON provider_canonical_track.mbid = provider_track.track_mbid
        OR (provider_track.track_id IS NOT NULL AND provider_canonical_track.id = provider_track.track_id)
      LEFT JOIN Recordings provider_recording
        ON provider_recording.mbid = COALESCE(provider_track.recording_mbid, provider_canonical_track.recording_mbid)
        OR (provider_track.recording_id IS NOT NULL AND provider_recording.id = provider_track.recording_id)
      LEFT JOIN ProviderItems provider_album
        ON provider_album.rowid = (
          SELECT album_candidate.rowid
          FROM ProviderItems album_candidate
          WHERE album_candidate.entity_type = 'album'
            AND (
              (
                COALESCE(CASE WHEN lf.provider_entity_type = 'album' THEN lf.provider_id END, lf.album_id, provider_track.album_id) IS NOT NULL
                AND CAST(album_candidate.provider_id AS TEXT) = CAST(COALESCE(CASE WHEN lf.provider_entity_type = 'album' THEN lf.provider_id END, lf.album_id, provider_track.album_id) AS TEXT)
                AND (COALESCE(lf.provider, provider_track.provider) IS NULL OR album_candidate.provider = COALESCE(lf.provider, provider_track.provider))
              )
              OR (
                COALESCE(CASE WHEN lf.provider_entity_type = 'album' THEN lf.provider_id END, lf.album_id, provider_track.album_id) IS NULL
                AND (
                  (lf.canonical_release_mbid IS NOT NULL AND album_candidate.release_mbid = lf.canonical_release_mbid)
                  OR (lf.canonical_release_group_mbid IS NOT NULL AND album_candidate.release_group_mbid = lf.canonical_release_group_mbid)
                  OR (canonical_release.mbid IS NOT NULL AND album_candidate.release_mbid = canonical_release.mbid)
                  OR (canonical_group.mbid IS NOT NULL AND album_candidate.release_group_mbid = canonical_group.mbid)
                  OR (provider_track.release_mbid IS NOT NULL AND album_candidate.release_mbid = provider_track.release_mbid)
                  OR (provider_track.release_group_mbid IS NOT NULL AND album_candidate.release_group_mbid = provider_track.release_group_mbid)
                )
              )
            )
          ORDER BY
            CASE album_candidate.library_slot WHEN 'stereo' THEN 0 WHEN 'spatial' THEN 1 ELSE 2 END,
            album_candidate.updated_at DESC,
            album_candidate.provider_id ASC
          LIMIT 1
        )
      LEFT JOIN AlbumReleases ar ON ar.mbid = COALESCE(provider_album.release_mbid, provider_track.release_mbid)
      LEFT JOIN Albums alb ON alb.mbid = COALESCE(provider_album.release_group_mbid, provider_track.release_group_mbid)
      WHERE ${whereClause}
        AND (provider_track.provider_id IS NOT NULL OR canonical_track.mbid IS NOT NULL OR provider_canonical_track.mbid IS NOT NULL OR canonical_recording.mbid IS NOT NULL OR provider_recording.mbid IS NOT NULL)
      ORDER BY lf.artist_id, lf.album_id, COALESCE(canonical_track.medium_position, provider_canonical_track.medium_position, 1), COALESCE(canonical_track.position, provider_canonical_track.position, 0), lf.id
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
    const ext = String(extension || "").toLowerCase().trim();

    const isFlac = ext === ".flac" || ext === ".ogg";
    const isMp3 = ext === ".mp3";
    const isM4a = ext === ".m4a" || ext === ".mp4";

    const flacMap: Record<string, string> = {
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
      isrc: "ISRC",
      copyright: "COPYRIGHT",
      barcode: "BARCODE",
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
    };

    const mp3Map: Record<string, string> = {
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
      isrc: "isrc",
      copyright: "copyright",
      barcode: "TXXX:Barcode",
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
    };

    const m4aMap: Record<string, string> = {
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
      isrc: "isrc",
      copyright: "copyright",
      barcode: "----:com.apple.iTunes:Barcode",
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
    return Object.keys(this.buildAudioTagWriteMap(
      tags.map((tag) => ({ ...tag, targetValue: "__remove__" })),
      extension,
    ));
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

  static buildDesiredTagsForTrackFileIdsForTest(ids: number[], config: Partial<MetadataConfig> = {}): ManagedTag[] {
    const rows = this.getTrackRowsByIds(ids);
    if (rows.length === 0) {
      return [];
    }

    return this.buildDesiredTags(rows[0], {
      write_audio_metadata: true,
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

    if (nextRow.media_mbid) {
      const isSpatialOrVideo = nextRow.library_slot === "spatial" || nextRow.library_slot === "video";
      if (!isSpatialOrVideo) {
        return nextRow;
      }
    }

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
            "musicbrainz_trackid",
            "musicbrainztrackid",
          ],
        });
      }

      if (row.album_mbid) {
        tags.push({
          key: "musicbrainz_albumid",
          label: "MusicBrainz Release ID",
          ffmpegKey: "musicbrainz_albumid",
          targetValue: String(row.album_mbid),
          aliases: ["musicbrainz_albumid", "musicbrainzalbumid", "musicbrainz album id"],
        });
      }

      if (row.artist_mbid) {
        tags.push({
          key: "musicbrainz_albumartistid",
          label: "MusicBrainz Album Artist ID",
          ffmpegKey: "musicbrainz_albumartistid",
          targetValue: String(row.artist_mbid),
          aliases: ["musicbrainz_albumartistid", "musicbrainzalbumartistid", "musicbrainz album artist id"],
        });
        tags.push({
          key: "musicbrainz_artistid",
          label: "MusicBrainz Artist ID",
          ffmpegKey: "musicbrainz_artistid",
          targetValue: String(row.artist_mbid),
          aliases: ["musicbrainz_artistid", "musicbrainzartistid", "musicbrainz artist id"],
        });
      }

      if (row.album_mb_release_group_id) {
        tags.push({
          key: "musicbrainz_releasegroupid",
          label: "MusicBrainz Release Group ID",
          ffmpegKey: "musicbrainz_releasegroupid",
          targetValue: String(row.album_mb_release_group_id),
          aliases: ["musicbrainz_releasegroupid", "musicbrainzreleasegroupid", "musicbrainz release group id"],
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
        tags.push({
          key: "release_country",
          label: "Release Country",
          ffmpegKey: "release_country",
          targetValue: String(row.release_country),
          aliases: ["releasecountry", "release_country"],
        });
      }

      if (row.release_status) {
        tags.push({
          key: "release_status",
          label: "Release Status",
          ffmpegKey: "release_status",
          targetValue: String(row.release_status).toLowerCase(),
          aliases: ["releasestatus", "release_status"],
        });
      }

      let releaseType: string | null = null;
      if (row.release_primary_type) {
        const primary = row.release_primary_type.toLowerCase();
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
        releaseType = [primary, ...secondaryList].join("; ");
      }
      if (releaseType) {
        tags.push({
          key: "release_type",
          label: "Release Type",
          ffmpegKey: "release_type",
          targetValue: releaseType,
          aliases: ["releasetype", "release_type"],
        });
      }

      const acoustidId = row.media_acoustid_id || row.file_acoustid_id;
      if (acoustidId) {
        tags.push({
          key: "acoustid_id",
          label: "AcoustID",
          ffmpegKey: "acoustid_id",
          targetValue: String(acoustidId),
          aliases: ["acoustid_id", "acoustid id", "acoustid"],
        });
      }

      const acoustidFingerprint = row.media_acoustid_fingerprint || row.file_fingerprint;
      if (acoustidFingerprint) {
        tags.push({
          key: "acoustid_fingerprint",
          label: "AcoustID Fingerprint",
          ffmpegKey: "acoustid_fingerprint",
          targetValue: String(acoustidFingerprint),
          aliases: ["acoustid_fingerprint", "acoustid fingerprint", "fingerprint"],
        });
      }

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
        const reviewText = row.album_review_text.length > 4096
          ? row.album_review_text.slice(0, 4093) + "..."
          : row.album_review_text;
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

  private static async evaluateRow(row: RetagTrackRow, config: MetadataConfig): Promise<RetagPreviewItem> {
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
    const removals = this.buildManagedTagRemovals(config);
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
      const metadata = await mm.parseFile(resolvedPath, { skipCovers: true, duration: false });
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

  private static async evaluateRows(rows: RetagTrackRow[], config: MetadataConfig): Promise<RetagPreviewItem[]> {
    const results: RetagPreviewItem[] = [];

    for (const row of rows) {
      results.push(await this.evaluateRow(row, config));
    }

    return results;
  }

  static async preview(options: RetagScopeOptions = {}): Promise<RetagPreviewItem[]> {
    const config = getConfigSection("metadata") as MetadataConfig;
    if (!isRetagMaintenanceEnabled(config)) {
      return [];
    }

    const rows = this.getTrackRows(options, true);
    const items = await this.evaluateRows(rows, config);
    return items.filter((item) => item.missing || item.changes.length > 0);
  }

  static async getStatus(options: RetagScopeOptions = {}, sampleLimit = 10): Promise<RetagStatusSummary> {
    const config = getConfigSection("metadata") as MetadataConfig;
    const total = this.getTrackCount(options);

    if (!isRetagMaintenanceEnabled(config)) {
      return {
        enabled: false,
        total,
        retagNeeded: 0,
        missing: 0,
        sample: [],
      };
    }

    const items = await this.evaluateRows(this.getTrackRows(options, false), config);
    const actionable = items.filter((item) => item.missing || item.changes.length > 0);

    return {
      enabled: true,
      total,
      retagNeeded: actionable.filter((item) => !item.missing && item.changes.length > 0).length,
      missing: items.filter((item) => item.missing).length,
      sample: actionable.slice(0, Math.max(0, sampleLimit)),
    };
  }

  static async apply(ids: number[]): Promise<RetagApplyResult> {
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

    for (const id of ids) {
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

      const preview = await this.evaluateRow(enrichedRow, config);
      if (!preview.missing && preview.changes.length === 0) {
        result.skipped++;
        continue;
      }

      const desiredTags = this.buildAudioTagWriteMap(this.buildDesiredTags(enrichedRow, config), enrichedRow.extension);
      const removalKeys = this.buildAudioTagRemovalKeys(this.buildManagedTagRemovals(config), enrichedRow.extension);

      if (shouldSkipEmbeddedAudioTagWrite(enrichedRow)) {
        console.warn(`[Retag] Skipping embedded tag rewrite for ${resolvedPath}; ${enrichedRow.extension || "file"} ${enrichedRow.file_codec || "spatial"} is not safely writable with ffmpeg stream copy.`);
        result.skipped++;
        continue;
      }

      // Scrub all existing tags before writing (Lidarr's ScrubAudioTags)
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

      const stat = fs.statSync(resolvedPath);
      pendingUpdates.push([stat.size, stat.mtime.toISOString(), id]);
      result.retagged++;
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

  static async applyForMediaIds(mediaIds: Array<string | number>): Promise<RetagApplyResult> {
    const uniqueMediaIds = Array.from(new Set(mediaIds.map((id) => String(id).trim()).filter(Boolean)));
    if (uniqueMediaIds.length === 0) {
      return {
        retagged: 0,
        skipped: 0,
        missing: 0,
        errors: [],
      };
    }

    const placeholders = uniqueMediaIds.map(() => "?").join(",");
    const libraryFileIds = db.prepare(`
      SELECT id
      FROM TrackFiles
      WHERE file_type = 'track'
        AND (
          media_id IN (${placeholders})
          OR (provider_entity_type = 'track' AND provider_id IN (${placeholders}))
        )
    `).all(...uniqueMediaIds, ...uniqueMediaIds) as Array<{ id: number }>;

    return this.apply(libraryFileIds.map((row) => row.id));
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

    return this.apply(ids);
  }
}
