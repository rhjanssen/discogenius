import { createHash } from "node:crypto";
import { db, runGatedChunkedWrite, withSqliteWriteGate } from "../../database.js";
import {
  RemoteOperationError,
  type RemoteOperationContext,
} from "../../utils/remote-operation-error.js";
import type { MusicBrainzReleaseGroupForMatching } from "./provider-release-group-matcher.js";
import { MediaCoverService } from "./media-cover-service.js";
import { MusicBrainzArtistCreditService } from "./musicbrainz-artist-credit-service.js";
import { getDiscogeniusUserAgent } from "../config/user-agent.js";
import pLimit from "p-limit";

/** Servarr metadata-server rating (≈ Lidarr's RatingResource). */
export interface ServarrMetadataRating {
  Count?: number;
  Value?: number;
  count?: number;
  value?: number;
}

export interface LidarrArtist {
  id: string;
  artistname: string;
  sortname: string;
  artistaliases?: string[];
  artistAliases?: string[];
  links?: Array<{ target?: string; url?: string; type?: string } | string>;
  disambiguation?: string;
  type?: string;
  images: Array<{ Url?: string; url?: string; CoverType?: string; coverType?: string; remoteUrl?: string }>;
  overview?: string;
  // Popularity rating from the Servarr metadata server. Lidarr maps this to
  // Artist.Ratings; we fold value (0–10) into our 0–100 popularity score.
  rating?: ServarrMetadataRating;
  Rating?: ServarrMetadataRating;
  Albums: LidarrAlbum[];
}

/**
 * Derive a 0–100 popularity score from the Servarr metadata-server rating,
 * mirroring how Lidarr surfaces artist popularity from the same source. The
 * rating value is on a 0–10 scale; we scale it to 0–100 to match the existing
 * provider-sourced popularity range. Returns null when there are no votes, so
 * an unrated artist never overwrites an existing provider popularity with 0.
 */
export function deriveServarrMetadataPopularity(rating: ServarrMetadataRating | undefined | null): number | null {
  if (!rating) return null;
  const count = Number(rating.Count ?? rating.count ?? 0);
  const value = Number(rating.Value ?? rating.value ?? 0);
  if (!Number.isFinite(count) || count <= 0 || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return Math.max(0, Math.min(100, Math.round(value * 10)));
}

export interface LidarrAlbum {
  Id: string;
  Title: string;
  Type?: string;
  SecondaryTypes?: string[];
  ReleaseDate?: string;
  Disambiguation?: string;
  Images?: Array<{ Url?: string; url?: string; CoverType?: string; coverType?: string; remoteUrl?: string }>;
  images?: Array<{ Url?: string; url?: string; CoverType?: string; coverType?: string; remoteUrl?: string }>;
  Releases?: any[];
  releases?: any[];
}

export interface LidarrReleaseGroupDetail {
  id: string;
  artistid?: string;
  artistId?: string;
  title: string;
  type?: string;
  secondarytypes?: string[];
  releasedate?: string;
  ReleaseDate?: string;
  disambiguation?: string;
  overview?: string | null;
  links?: Array<{ type?: string; target?: string; url?: string }>;
  genres?: string[];
  aliases?: string[];
  rating?: { Count?: number; Value?: number; count?: number; value?: number } | null;
  Images?: Array<{ Url?: string; url?: string; CoverType?: string; coverType?: string; remoteUrl?: string }>;
  images?: Array<{ Url?: string; url?: string; CoverType?: string; coverType?: string; remoteUrl?: string }>;
  Releases: LidarrRelease[];
}

export interface LidarrRelease {
  Id: string;
  Title: string;
  Status: string;
  Country: string[];
  Barcode?: string;
  barcode?: string;
  Label: string[];
  Media: Array<{ Position: number; Format: string; Name: string }>;
  ReleaseDate: string;
  TrackCount: number;
  MediumCount?: number;
  MediaCount?: number;
  Disambiguation: string;
  ExternalUrls?: string[];
  Tracks: LidarrTrack[];
}

export interface LidarrTrack {
  Id: string;
  RecordingId: string;
  TrackName: string;
  TrackNumber: string;
  TrackPosition: number;
  MediumNumber: number;
  DurationMs: number;
  Isrcs?: string[];
  isrcs?: string[];
  /**
   * MusicBrainz's `recording.comment` — "live", "dolby atmos mix", "explicit".
   * Present in MB-local mode only; the Servarr Metadata Server does not expose
   * it, which is why the upsert below must never overwrite a stored value with
   * null.
   */
  RecordingDisambiguation?: string | null;
  /** True when the MusicBrainz recording is flagged as video. */
  IsVideo?: boolean;
}

export interface MediaCover {
  url: string;
  coverType: string;
  remoteUrl: string;
  extension?: string;
}

export interface ServarrMetadataServiceOptions {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  sleep?: (delayMs: number) => Promise<void>;
  requestConcurrency?: number;
  maxAttempts?: number;
  requestTimeoutMs?: number;
}

const DEFAULT_SERVARR_REQUEST_CONCURRENCY = 2;
const DEFAULT_SERVARR_MAX_ATTEMPTS = 3;
const DEFAULT_SERVARR_REQUEST_TIMEOUT_MS = 12_000;
const MAX_SERVARR_RETRY_DELAY_MS = 30_000;

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(parsed)));
}

function retryAfterDelayMs(response: Response): number | null {
  const raw = response.headers?.get?.("retry-after")?.trim();
  if (!raw) return null;

  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(MAX_SERVARR_RETRY_DELAY_MS, Math.ceil(seconds * 1_000));
  }

  const date = Date.parse(raw);
  if (!Number.isFinite(date)) return null;
  return Math.min(MAX_SERVARR_RETRY_DELAY_MS, Math.max(0, date - Date.now()));
}

/** Host only — a base URL may carry a key in its query string. */
function safeHost(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).host || null;
  } catch {
    return null;
  }
}

function isRetryableServarrStatus(status: number): boolean {
  return status === 408
    || status === 425
    || status === 429
    || status === 500
    || status === 502
    || status === 503
    || status === 504;
}

class ServarrMetadataRequestError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs: number | null = null,
    options?: ErrorOptions,
    /**
     * The structured provenance behind `message`. Kept alongside the string so
     * a caller can read the host/status/phase rather than re-parsing prose —
     * flattening to `.message` was throwing that away.
     */
    readonly context?: RemoteOperationContext,
  ) {
    super(message, options);
    this.name = "ServarrMetadataRequestError";
  }
}

/**
 * Cheap change-key over a remote metadata payload. Refresh compares this to the
 * stored `content_hash` to decide whether a row actually changed — Lidarr's
 * diff-reconcile (UpdateMany writes only changed rows). SHA-1 is plenty: this is
 * a change detector, not a security primitive, and it's the cheapest hash that
 * won't collide across a library's worth of payloads.
 */
export function computeContentHash(payload: unknown): string {
  return createHash("sha1").update(JSON.stringify(payload)).digest("hex");
}

export function mapServarrMetadataImages(images?: any[] | null): MediaCover[] {
  if (!images || !Array.isArray(images)) {
    return [];
  }
  return images.map((img: any) => {
    const rawUrl = img.url || img.Url || img.remoteUrl || "";
    const coverType = img.coverType || img.CoverType || "unknown";

    let extension = "";
    if (rawUrl) {
      try {
        const parsed = new URL(rawUrl);
        const pathname = parsed.pathname;
        const lastDot = pathname.lastIndexOf(".");
        if (lastDot !== -1 && pathname.length - lastDot <= 5) {
          extension = pathname.slice(lastDot);
        }
      } catch {
        extension = "";
      }
    }

    const normalizedType = coverType.charAt(0).toUpperCase() + coverType.slice(1).toLowerCase();

    return {
      url: rawUrl,
      coverType: normalizedType,
      remoteUrl: rawUrl,
      ...(extension ? { extension } : {}),
    };
  });
}

/**
 * Collect external URLs from a curated `links` JSON column. The metadata-server
 * `links` array uses `{ type, target }` (target = the URL). This is the
 * matching-evidence reader for the curated columns, replacing the old recursive
 * walk over the raw `data` blob now that the blob is being retired.
 */
export function extractLinkUrls(linksJson?: string | null): string[] {
  if (!linksJson) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(linksJson);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const urls = new Set<string>();
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    for (const value of Object.values(entry as Record<string, unknown>)) {
      if (typeof value === "string" && /^https?:\/\//i.test(value.trim())) {
        urls.add(value.trim());
      }
    }
  }
  return Array.from(urls);
}

export class ServarrMetadataService {
  private readonly baseUrl: string;
  private readonly fetchOverride?: typeof globalThis.fetch;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly requestLimit: ReturnType<typeof pLimit>;
  private readonly maxAttempts: number;
  private readonly requestTimeoutMs: number;

  constructor(options: ServarrMetadataServiceOptions = {}) {
    this.baseUrl = options.baseUrl ?? "https://api.lidarr.audio/api/v0.4";
    this.fetchOverride = options.fetch;
    this.sleep = options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
    this.requestLimit = pLimit(boundedInteger(
      options.requestConcurrency ?? process.env.DISCOGENIUS_SERVARR_REQUEST_CONCURRENCY,
      DEFAULT_SERVARR_REQUEST_CONCURRENCY,
      1,
      4,
    ));
    this.maxAttempts = boundedInteger(
      options.maxAttempts ?? process.env.DISCOGENIUS_SERVARR_MAX_ATTEMPTS,
      DEFAULT_SERVARR_MAX_ATTEMPTS,
      1,
      5,
    );
    this.requestTimeoutMs = boundedInteger(
      options.requestTimeoutMs ?? process.env.DISCOGENIUS_SERVARR_REQUEST_TIMEOUT_MS,
      DEFAULT_SERVARR_REQUEST_TIMEOUT_MS,
      1_000,
      60_000,
    );
  }

  private normalizeSearchText(value: string): string {
    return value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  private rankSearchArtist(query: string, artist: LidarrArtist): number {
    const normalizedQuery = this.normalizeSearchText(query);
    const normalizedName = this.normalizeSearchText(artist.artistname || "");
    const albumCount = Array.isArray(artist.Albums) ? artist.Albums.length : 0;
    let score = 0;

    if (normalizedName === normalizedQuery) {
      score += 10_000;
    } else if (normalizedName.startsWith(normalizedQuery)) {
      score += 5_000;
    } else if (normalizedName.includes(normalizedQuery)) {
      score += 1_000;
    }

    if (String(artist.type || "").toLowerCase() === "group") {
      score += 25;
    }

    return score + Math.min(albumCount, 500);
  }

  private async fetchJson<T>(path: string): Promise<T> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const res = await this.requestLimit(() => (
          (this.fetchOverride ?? globalThis.fetch)(`${this.baseUrl}${path}`, {
            headers: {
              Accept: "application/json",
              "User-Agent": getDiscogeniusUserAgent("metadata service"),
            },
            signal: AbortSignal.timeout(this.requestTimeoutMs),
          })
        ));
        if (!res.ok) {
          // Carry the service, host and status so command history names the
          // dependency instead of reporting a bare status line.
          const context: RemoteOperationContext = {
            phase: "canonical.artist",
            service: "servarr-metadata",
            host: safeHost(this.baseUrl),
            method: "GET",
            status: res.status,
            retryable: isRetryableServarrStatus(res.status),
          };
          throw new ServarrMetadataRequestError(
            new RemoteOperationError(context, `${path} ${res.statusText}`.trim()).message,
            isRetryableServarrStatus(res.status),
            retryAfterDelayMs(res),
            undefined,
            context,
          );
        }

        try {
          return await res.json() as T;
        } catch (error) {
          throw new ServarrMetadataRequestError(
            `Servarr metadata API ${path} returned malformed JSON`,
            false,
            null,
            { cause: error },
          );
        }
      } catch (error) {
        lastError = error;
        const requestError = error instanceof ServarrMetadataRequestError
          ? error
          : new ServarrMetadataRequestError(
            `Servarr metadata API ${path} request failed: ${error instanceof Error ? error.message : String(error)}`,
            true,
            null,
            { cause: error },
          );
        if (!requestError.retryable || attempt >= this.maxAttempts) {
          throw requestError;
        }

        const delayMs = requestError.retryAfterMs
          ?? Math.min(MAX_SERVARR_RETRY_DELAY_MS, 500 * (2 ** (attempt - 1)));
        await this.sleep(delayMs);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(`Servarr metadata API ${path} failed after ${this.maxAttempts} attempts`);
  }

  async getArtistInfo(mbid: string): Promise<LidarrArtist> {
    return this.fetchJson<LidarrArtist>(`/artist/${encodeURIComponent(mbid)}`);
  }


  async searchForNewArtist(query: string, limit = 20): Promise<LidarrArtist[]> {
    const trimmed = query.trim();
    if (!trimmed) {
      return [];
    }

    const results = await this.fetchJson<LidarrArtist[]>(
      `/search?type=artist&query=${encodeURIComponent(trimmed)}`,
    );

    return results
      .filter((artist) => artist?.id && artist?.artistname)
      .sort((left, right) => this.rankSearchArtist(trimmed, right) - this.rankSearchArtist(trimmed, left))
      .slice(0, limit);
  }


  async searchAll(query: string, limit = 40): Promise<any[]> {
    const trimmed = query.trim();
    if (!trimmed) {
      return [];
    }
    try {
      const results = await this.fetchJson<any[]>(
        `/search?type=all&query=${encodeURIComponent(trimmed)}`
      );
      if (Array.isArray(results)) {
        return results
          .sort((left, right) => {
            if (left?.artist && right?.artist) {
              return this.rankSearchArtist(trimmed, right.artist) - this.rankSearchArtist(trimmed, left.artist);
            }
            if (left?.artist) return -1;
            if (right?.artist) return 1;
            return 0;
          })
          .slice(0, limit);
      }
    } catch (e) {
      console.error("Servarr Metadata Server searchAll failed:", e);
    }
    return [];
  }

  async getAlbumInfo(releaseGroupMbid: string): Promise<LidarrReleaseGroupDetail> {
    return this.fetchJson<LidarrReleaseGroupDetail>(`/album/${encodeURIComponent(releaseGroupMbid)}`);
  }


  getArtistImageUrl(artist: LidarrArtist, preferredCoverType = "Poster"): string | null {
    return MediaCoverService.getArtistImageUrl(artist, preferredCoverType);
  }

  getAlbumImageUrl(album: LidarrAlbum, preferredCoverType = "Cover"): string | null {
    return MediaCoverService.getAlbumImageUrl(album, preferredCoverType);
  }

  getCachedReleaseGroupsForArtist(artistMbid: string): MusicBrainzReleaseGroupForMatching[] {
    const rows = db.prepare(`
      SELECT DISTINCT rg.mbid, rg.title, rg.primary_type, rg.secondary_types, rg.first_release_date, rg.disambiguation, rg.links
      FROM Albums rg
      LEFT JOIN ArtistReleaseGroups scope ON scope.release_group_mbid = rg.mbid
      WHERE rg.artist_mbid = ? OR scope.artist_mbid = ?
    `).all(artistMbid, artistMbid) as Array<{
      mbid: string;
      title: string;
      primary_type: string | null;
      secondary_types: string | null;
      first_release_date: string | null;
      disambiguation: string | null;
      links: string | null;
    }>;

    // External-link matching evidence lives on the release GROUP (`links`), not
    // the release — sourced from the curated column, replacing the old
    // extractLinkUrls(Albums.links) reads the curated relation column instead
    // of walking the retired raw metadata blob.
    const externalUrlsByReleaseGroup = new Map<string, string[]>(
      rows.map((row) => [row.mbid, extractLinkUrls(row.links)]),
    );

    const releaseRows = rows.length === 0
      ? []
      : db.prepare(`
        SELECT
          r.mbid,
          r.release_group_mbid,
          r.title,
          r.disambiguation,
          r.barcode,
          r.date,
          r.track_count,
          r.media_count,
          rec.isrcs AS recording_isrcs
        FROM AlbumEditions r
        LEFT JOIN Tracks t ON t.release_mbid = r.mbid
        LEFT JOIN Recordings rec ON rec.mbid = t.recording_mbid
        WHERE r.release_group_mbid IN (${rows.map(() => "?").join(",")})
      `).all(...rows.map((row) => row.mbid)) as Array<{
        mbid: string;
        release_group_mbid: string;
        title: string | null;
        disambiguation: string | null;
        barcode: string | null;
        date: string | null;
        track_count: number | null;
        media_count: number | null;
        recording_isrcs: string | null;
      }>;
    const releasesByReleaseGroup = new Map<string, Array<NonNullable<MusicBrainzReleaseGroupForMatching["releases"]>[number]>>();
    const releaseEvidenceByMbid = new Map<string, {
      releaseGroupMbid: string;
      mbid: string;
      title: string | null;
      disambiguation: string | null;
      barcode: string | null;
      date: string | null;
      trackCount: number | null;
      mediaCount: number | null;
      externalUrls: Set<string>;
      isrcs: Set<string>;
    }>();
    for (const release of releaseRows) {
      const evidence = releaseEvidenceByMbid.get(release.mbid) || {
        releaseGroupMbid: release.release_group_mbid,
        mbid: release.mbid,
        title: release.title,
        disambiguation: release.disambiguation,
        barcode: release.barcode,
        date: release.date,
        trackCount: release.track_count,
        mediaCount: release.media_count,
        externalUrls: new Set<string>(),
        isrcs: new Set<string>(),
      };
      for (const url of externalUrlsByReleaseGroup.get(release.release_group_mbid) ?? []) {
        evidence.externalUrls.add(url);
      }
      const rawIsrcs = String(release.recording_isrcs || "").trim();
      const values = rawIsrcs.startsWith("[") ? [rawIsrcs] : rawIsrcs.split(",");
      for (const value of values) {
        try {
          const parsed = JSON.parse(value || "[]");
          if (Array.isArray(parsed)) {
            parsed.forEach((isrc) => {
              const normalized = String(isrc || "").trim();
              if (normalized) evidence.isrcs.add(normalized);
            });
          }
        } catch {
          const normalized = String(value || "").trim();
          if (normalized) evidence.isrcs.add(normalized);
        }
      }
      releaseEvidenceByMbid.set(release.mbid, evidence);
    }

    for (const release of releaseEvidenceByMbid.values()) {
      const list = releasesByReleaseGroup.get(release.releaseGroupMbid) || [];
      list.push({
        mbid: release.mbid,
        title: release.title,
        disambiguation: release.disambiguation,
        barcode: release.barcode,
        date: release.date,
        trackCount: release.trackCount,
        mediaCount: release.mediaCount,
        externalUrls: Array.from(release.externalUrls),
        isrcs: Array.from(release.isrcs),
      });
      releasesByReleaseGroup.set(release.releaseGroupMbid, list);
    }

    return rows.map((row) => {
      let secondaryTypes: string[] = [];
      try {
        const parsed = JSON.parse(row.secondary_types || "[]");
        secondaryTypes = Array.isArray(parsed) ? parsed.map((type) => String(type)) : [];
      } catch {
        secondaryTypes = [];
      }

      return {
        mbid: row.mbid,
        title: row.title,
        primaryType: row.primary_type,
        secondaryTypes,
        firstReleaseDate: row.first_release_date,
        disambiguation: row.disambiguation,
        releases: releasesByReleaseGroup.get(row.mbid) || [],
      };
    });
  }

  async syncArtist(mbid: string): Promise<LidarrArtist> {
    // Fetch via the ACTIVE catalog source (Servarr or MB-local Postgres). Both
    // return the same LidarrArtist DTO, so the write logic below is unchanged.
    // Dynamic import avoids the servarr↔catalog module cycle at init time.
    const { catalogProviderRegistry } = await import("../catalog/index.js");
    const artist = await catalogProviderRegistry.getActive().getArtist(mbid);

    // Diff-reconcile: if the remote payload is byte-for-byte what we last stored,
    // the artist row and every release-group row it owns are already current —
    // skip the whole write (artist + N album upserts) instead of rewriting rows
    // to identical values. This is the throughput fix for re-refreshes: an
    // unchanged artist costs one hash + one indexed read, not hundreds of upserts.
    const contentHash = computeContentHash(artist);
    const existingHash = (db.prepare("SELECT content_hash FROM ArtistMetadata WHERE mbid = ?")
      .get(artist.id) as { content_hash?: string | null } | undefined)?.content_hash ?? null;
    if (existingHash && existingHash === contentHash) {
      return artist;
    }

    // Supplemental Servarr artist metadata: MB serves no artist art / overview /
    // popularity, so when the active source returned none, fetch Servarr purely as
    // an image + overview + popularity source (it aggregates fanart.tv /
    // TheAudioDB artist art). Never overrides MB identity (name/sort/type stay from
    // `artist`); failure-tolerant. Skipped in Servarr mode since `artist` already
    // carries images.
    let enrich: LidarrArtist = artist;
    if (!Array.isArray(artist.images) || artist.images.length === 0) {
      try {
        const supplemental = await this.getArtistInfo(mbid);
        if (supplemental) enrich = supplemental;
      } catch {
        // supplemental only — proceed without it
      }
    }

    const imagesList = mapServarrMetadataImages(enrich.images);
    const popularity = deriveServarrMetadataPopularity(enrich.rating ?? enrich.Rating);
    const raw = enrich as Record<string, any>;

    // Serialize SQLite commits across concurrent RefreshArtist workers so
    // catalog fetches can overlap (local-MB) without write-lock storms.
    // Network artwork resolution stays outside the gate.
    const { insertRg, albums } = await withSqliteWriteGate(() => {
      db.prepare(`
        INSERT INTO ArtistMetadata (
          mbid, name, sort_name, disambiguation, type, overview, status, popularity,
          images, links, genres, ratings, aliases, old_foreign_ids, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(mbid) DO UPDATE SET
          name = excluded.name,
          sort_name = excluded.sort_name,
          disambiguation = excluded.disambiguation,
          type = excluded.type,
          overview = excluded.overview,
          status = excluded.status,
          -- Keep the Servarr rating when present; otherwise preserve whatever
          -- popularity a provider sync already stored.
          popularity = COALESCE(excluded.popularity, ArtistMetadata.popularity),
          images = excluded.images,
          links = excluded.links,
          genres = excluded.genres,
          ratings = excluded.ratings,
          aliases = excluded.aliases,
          old_foreign_ids = excluded.old_foreign_ids,
          updated_at = CURRENT_TIMESTAMP
      `).run(
        artist.id,
        artist.artistname,
        artist.sortname,
        artist.disambiguation || null,
        artist.type || null,
        raw.overview ?? null,
        raw.status ?? null,
        popularity,
        JSON.stringify(imagesList),
        JSON.stringify(raw.links ?? []),
        JSON.stringify(raw.genres ?? []),
        JSON.stringify(raw.rating ?? raw.Rating ?? null),
        JSON.stringify(raw.artistaliases ?? raw.aliases ?? []),
        JSON.stringify(raw.oldids ?? raw.oldIds ?? []),
      );

      // The artist payload carries only summary album entries (no images, links,
      // genres, or full release detail). On conflict, update only the shallow
      // scalar fields it actually has and NEVER overwrite the detail-sourced
      // columns (images, links, genres, overview, content_hash) — those are
      // owned by syncReleaseGroup when it fetches the full release-group detail.
      // (This replaces the old read-existing-blob-then-merge dance.)
      const insertRg = db.prepare(`
        INSERT INTO Albums (mbid, artist_mbid, title, primary_type, secondary_types, first_release_date, disambiguation, images, ratings, old_foreign_ids, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(mbid) DO UPDATE SET
          title = excluded.title,
          primary_type = excluded.primary_type,
          secondary_types = excluded.secondary_types,
          first_release_date = excluded.first_release_date,
          disambiguation = excluded.disambiguation,
          ratings = excluded.ratings,
          old_foreign_ids = excluded.old_foreign_ids,
          updated_at = CURRENT_TIMESTAMP
      `);

      return { insertRg, albums: (artist.Albums || []).filter((album) => album.Id) };
    }, "servarr:artist-metadata");

    // Chunk the per-album upserts, taking the gate per chunk: a large artist
    // (hundreds of release groups) would otherwise hold BOTH the SQLite write
    // lock and the process-global gate for its entire catalog — measured at 63s
    // with four workers queued behind it.
    await runGatedChunkedWrite(albums, (album) => {
        const rawAlbum = album as Record<string, any>;
        const albumImages = mapServarrMetadataImages(album.images || album.Images);

        insertRg.run(
          album.Id,
          artist.id,
          album.Title,
          album.Type || null,
          JSON.stringify(album.SecondaryTypes || []),
          album.ReleaseDate || null,
          album.Disambiguation || null,
          JSON.stringify(albumImages),
          JSON.stringify(rawAlbum.Rating ?? rawAlbum.rating ?? null),
          JSON.stringify(rawAlbum.OldIds ?? rawAlbum.oldids ?? []),
        );
        MusicBrainzArtistCreditService.ensurePrimaryScope(album.Id, artist.id, artist.artistname);
    }, 50, "servarr:artist-albums");

    // Match Lidarr's refresh invariant: mark the parent current only after its
    // children have been processed successfully. If an album batch throws, the
    // previous hash remains and the next refresh retries the whole diff.
    await withSqliteWriteGate(() => {
      db.prepare(`
        UPDATE ArtistMetadata
        SET content_hash = ?, updated_at = CURRENT_TIMESTAMP
        WHERE mbid = ?
      `).run(contentHash, artist.id);
    }, "servarr:artist-content-hash");

    await MediaCoverService.resolveArtistArtwork({
      artistMbid: artist.id,
      servarrMetadataData: enrich,
      preferredCoverTypes: ["Poster", "Headshot"],
    });

    return artist;
  }

  async syncReleaseGroup(releaseGroupMbid: string, artistMbid: string): Promise<void> {
    const { catalogProviderRegistry } = await import("../catalog/index.js");
    const detail = await catalogProviderRegistry.getActive().getReleaseGroup(releaseGroupMbid);
    // reconcileReleaseGroupDetail takes the write gate itself, at the smallest
    // atomic boundary (header transaction, then per-chunk tracks).
    await this.reconcileReleaseGroupDetail(releaseGroupMbid, artistMbid, detail);
  }

  /**
   * Fetch full detail for many of an artist's release groups in ONE bulk call
   * (the "one fetch per artist" path that removes the per-RG N+1 during refresh),
   * then reconcile each with the identical write path. Falls back to per-RG
   * getReleaseGroup for providers that can't batch (hosted Servarr).
   */
  async syncArtistReleaseGroups(artistMbid: string, releaseGroupMbids: string[]): Promise<void> {
    const mbids = Array.from(new Set(releaseGroupMbids.map((mbid) => String(mbid || "").trim()).filter(Boolean)));
    if (mbids.length === 0) {
      return;
    }
    const { catalogProviderRegistry } = await import("../catalog/index.js");
    const provider = catalogProviderRegistry.getActive();
    if (typeof provider.getReleaseGroupDetails === "function") {
      const details = await provider.getReleaseGroupDetails(mbids);
      // Each release group is independently consistent, and reconcile takes the
      // gate itself per header transaction and per track chunk, so a prolific
      // artist's catalogue never serialises behind one long acquisition.
      for (const entry of details) {
        try {
          await this.reconcileReleaseGroupDetail(entry.releaseGroupMbid, artistMbid, entry.detail);
        } catch (error) {
          console.warn(`[ServarrMetadata] Failed to reconcile release group ${entry.releaseGroupMbid}:`, error);
        }
      }
    } else {
      // Hosted Servarr exposes one album-detail endpoint per release group, as
      // Lidarr itself uses. Fetch a small bounded group concurrently, then
      // reconcile serially so network latency overlaps without multiplying
      // writers across RefreshArtist jobs.
      const limit = pLimit(4);
      const details = await Promise.all(mbids.map((mbid) => limit(async () => {
        try {
          return { mbid, detail: await provider.getReleaseGroup(mbid) };
        } catch (error) {
          console.warn(`[ServarrMetadata] Failed to fetch release group ${mbid}:`, error);
          return null;
        }
      })));
      for (const entry of details) {
        if (!entry) continue;
        try {
          await this.reconcileReleaseGroupDetail(entry.mbid, artistMbid, entry.detail);
        } catch (error) {
          console.warn(`[ServarrMetadata] Failed to reconcile release group ${entry.mbid}:`, error);
        }
      }
    }
  }

  /**
   * Reconcile one release group's full detail into the catalog (RG + releases +
   * tracks + recordings). Shared by the single and bulk sync paths so the write
   * behaviour is identical regardless of how the detail was fetched.
   */
  private async reconcileReleaseGroupDetail(releaseGroupMbid: string, artistMbid: string, detail: LidarrReleaseGroupDetail): Promise<void> {
    const ownerArtistMbid = String(detail.artistid || detail.artistId || artistMbid).trim();

    // Diff-reconcile: skip rewriting an unchanged release group's entire
    // tracklist (a popular RG is many editions × many tracks → the dominant
    // write cost). Only skip when the remote payload is unchanged AND the
    // releases are actually present locally — so a hash match never suppresses
    // re-hydration of a release group whose child rows were pruned/never written.
    const contentHash = computeContentHash(detail);
    const existing = db.prepare(`
      SELECT
        rg.content_hash AS contentHash,
        EXISTS(SELECT 1 FROM AlbumEditions ar WHERE ar.release_group_mbid = rg.mbid) AS hasReleases
      FROM Albums rg
      WHERE rg.mbid = ?
    `).get(releaseGroupMbid) as { contentHash?: string | null; hasReleases?: number } | undefined;
    if (existing?.contentHash && existing.contentHash === contentHash && existing.hasReleases) {
      return;
    }

    const insertRg = db.prepare(`
      INSERT INTO Albums (
        mbid, artist_mbid, title, primary_type, secondary_types, first_release_date,
        disambiguation, overview, images, links, genres, ratings, aliases,
        old_foreign_ids, content_hash, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(mbid) DO UPDATE SET
        title = excluded.title,
        primary_type = excluded.primary_type,
        secondary_types = excluded.secondary_types,
        first_release_date = excluded.first_release_date,
        disambiguation = excluded.disambiguation,
        overview = excluded.overview,
        images = excluded.images,
        links = excluded.links,
        genres = excluded.genres,
        ratings = excluded.ratings,
        aliases = excluded.aliases,
        old_foreign_ids = excluded.old_foreign_ids,
        content_hash = excluded.content_hash,
        updated_at = CURRENT_TIMESTAMP
    `);

    const insertRelease = db.prepare(`
      INSERT INTO AlbumEditions (
        mbid, release_group_mbid, artist_mbid, title, status, country,
        date, barcode, disambiguation, media_count, track_count,
        label, media, old_foreign_ids, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(mbid) DO UPDATE SET
        title = excluded.title,
        status = excluded.status,
        country = excluded.country,
        date = excluded.date,
        -- Servarr strips UPC; keep any barcode already filled (e.g. from MB-local).
        barcode = COALESCE(excluded.barcode, AlbumEditions.barcode),
        disambiguation = excluded.disambiguation,
        media_count = excluded.media_count,
        track_count = excluded.track_count,
        label = excluded.label,
        media = excluded.media,
        old_foreign_ids = excluded.old_foreign_ids,
        updated_at = CURRENT_TIMESTAMP
    `);

    const insertRecording = db.prepare(`
      INSERT INTO Recordings (mbid, title, length_ms, disambiguation, isrcs, is_video, artist_mbid, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(mbid) DO UPDATE SET
        title = excluded.title,
        length_ms = excluded.length_ms,
        -- Servarr omits the comment; a refresh in that mode must not erase what
        -- MB-local stored, exactly as with isrcs and barcode above.
        disambiguation = COALESCE(excluded.disambiguation, Recordings.disambiguation),
        isrcs = COALESCE(excluded.isrcs, Recordings.isrcs),
        is_video = CASE WHEN excluded.is_video = 1 THEN 1 ELSE Recordings.is_video END,
        artist_mbid = COALESCE(Recordings.artist_mbid, excluded.artist_mbid),
        updated_at = CURRENT_TIMESTAMP
    `);

    const insertTrack = db.prepare(`
      INSERT INTO Tracks (mbid, release_mbid, recording_mbid, medium_position, position, number, title, length_ms, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(release_mbid, medium_position, position) DO UPDATE SET
        mbid = excluded.mbid,
        recording_mbid = excluded.recording_mbid,
        number = excluded.number,
        title = excluded.title,
        length_ms = excluded.length_ms,
        updated_at = CURRENT_TIMESTAMP
    `);

    const releases = detail.Releases || [];

    const albumImages = mapServarrMetadataImages(detail.images || detail.Images);

    // Release group + its release rows are bounded and share one transaction —
    // the smallest atomic unit here, since a release row referencing an Albums
    // row that was never written is not a state any reader should observe.
    await withSqliteWriteGate(() => {
      db.transaction(() => {
        MusicBrainzArtistCreditService.ensureArtist(ownerArtistMbid);

        const rawDetail = detail as Record<string, any>;
        insertRg.run(
          releaseGroupMbid,
          ownerArtistMbid,
          detail.title || "",
          detail.type || null,
          JSON.stringify(detail.secondarytypes || []),
          detail.releasedate || rawDetail.ReleaseDate || null,
          detail.disambiguation || null,
          detail.overview ?? rawDetail.overview ?? null,
          JSON.stringify(albumImages),
          JSON.stringify(detail.links ?? rawDetail.links ?? []),
          JSON.stringify(detail.genres ?? rawDetail.genres ?? []),
          JSON.stringify(detail.rating ?? rawDetail.rating ?? rawDetail.Rating ?? null),
          JSON.stringify(detail.aliases ?? rawDetail.aliases ?? []),
          JSON.stringify(rawDetail.oldids ?? rawDetail.oldIds ?? []),
          contentHash,
        );
        MusicBrainzArtistCreditService.ensurePrimaryScope(releaseGroupMbid, ownerArtistMbid);

        for (const release of releases) {
          const rawRelease = release as Record<string, any>;
          insertRelease.run(
            release.Id,
            releaseGroupMbid,
            ownerArtistMbid,
            release.Title,
            release.Status || null,
            JSON.stringify(release.Country || []),
            release.ReleaseDate || null,
            release.Barcode ?? rawRelease.barcode ?? null,
            release.Disambiguation || null,
            release.MediaCount ?? release.MediumCount ?? (release.Media || []).length,
            release.TrackCount ?? (release.Tracks || []).length,
            JSON.stringify(release.Label ?? rawRelease.label ?? []),
            JSON.stringify(release.Media ?? rawRelease.media ?? []),
            JSON.stringify(rawRelease.OldIds ?? rawRelease.oldids ?? []),
          );
        }
        MusicBrainzArtistCreditService.materializeIntegerCreditsForReleaseGroup(releaseGroupMbid);
      })();
    }, "servarr:release-group-header");

    // Tracks/recordings scale with the whole release group (a popular RG can have
    // dozens of editions × many tracks). Chunk them so the write lock isn't held
    // for the entire tracklist while concurrent workers wait — and take the gate
    // per chunk, not around the loop. Reconciling one prolific release group
    // under a single acquisition was measured at 51.9s on the live library, with
    // peers waiting 45.2s behind a queue eight deep: the chunking bounded
    // SQLite's own lock but the gate serialised the whole tracklist anyway.
    // Each chunk is idempotent upserts, so committing between them is safe.
    const trackRows: Array<{ release: typeof releases[number]; track: any }> = [];
    for (const release of releases) {
      for (const track of release.Tracks || []) {
        trackRows.push({ release, track });
      }
    }
    await runGatedChunkedWrite(trackRows, ({ release, track }) => {
      const isrcs = Array.isArray(track.Isrcs)
        ? track.Isrcs
        : Array.isArray(track.isrcs)
          ? track.isrcs
          : [];
      const isrcJson = isrcs.length > 0 ? JSON.stringify(isrcs.map(String).filter(Boolean)) : null;
      const isVideo = track.IsVideo === true || track.isVideo === true || track.video === true ? 1 : 0;
      const disambiguation = typeof track.RecordingDisambiguation === "string"
        && track.RecordingDisambiguation.trim() !== ""
        ? track.RecordingDisambiguation.trim()
        : null;
      insertRecording.run(
        track.RecordingId,
        track.TrackName,
        track.DurationMs,
        disambiguation,
        isrcJson,
        isVideo,
        ownerArtistMbid || null,
      );
      insertTrack.run(
        track.Id,
        release.Id,
        track.RecordingId,
        track.MediumNumber,
        track.TrackPosition,
        track.TrackNumber,
        track.TrackName,
        track.DurationMs,
      );
    }, 50, "servarr:release-group-tracks");
    await withSqliteWriteGate(() => {
      MusicBrainzArtistCreditService.materializeIntegerCreditsForReleaseGroup(releaseGroupMbid);
    }, "servarr:release-group-credits");
  }
}

export const servarrMetadata = new ServarrMetadataService();
