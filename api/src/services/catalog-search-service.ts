import type Database from "better-sqlite3";
import { db as defaultDb } from "../database.js";
import type { ProviderAuthMode } from "../contracts/auth.js";
import type {
  SearchResponseContract,
  SearchResultContract,
  SearchResultsContract,
} from "../contracts/catalog.js";
import { getProviderAuthMode } from "./provider-auth-mode.js";
import {
  getDefaultStreamingCatalogProvider,
  STREAMING_CATALOG_SEARCH_TYPES,
  type StreamingCatalogProvider,
  type StreamingCatalogSearchType,
} from "./streaming-catalog-provider.js";

const SEARCH_TYPE_ALIASES: Record<string, StreamingCatalogSearchType[]> = {
  artist: ["artists"],
  album: ["albums"],
  track: ["tracks"],
  video: ["videos"],
};

const LOCAL_TABLES: Record<StreamingCatalogSearchType, string> = {
  tracks: "media",
  videos: "media",
  artists: "artists",
  albums: "albums",
};

export class CatalogSearchValidationError extends Error {
  readonly status = 400;
}

export interface CatalogSearchQuery {
  query: unknown;
  type?: unknown;
  limit?: unknown;
}

export interface CatalogSearchDependencies {
  database?: Database.Database;
  provider?: StreamingCatalogProvider;
  providerAuthMode?: () => ProviderAuthMode;
  remoteTimeoutMs?: number;
  logger?: Pick<Console, "error">;
}

function createEmptyResults(): SearchResultsContract {
  return {
    artists: [],
    albums: [],
    tracks: [],
    videos: [],
  };
}

function escapeSqlLike(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_");
}

export function parseCatalogSearchLimit(value: unknown): number {
  const parsedLimit = Number.parseInt(String(value ?? ""), 10);
  return Number.isNaN(parsedLimit) ? 20 : Math.min(Math.max(parsedLimit, 1), 200);
}

export function normalizeCatalogSearchTypes(input: unknown): StreamingCatalogSearchType[] {
  const allSearchTypes: StreamingCatalogSearchType[] = [...STREAMING_CATALOG_SEARCH_TYPES];
  const requestedTypes = String(input || "all")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .flatMap<StreamingCatalogSearchType>((value) => {
      if (!value || value === "all") return allSearchTypes;
      if (SEARCH_TYPE_ALIASES[value]) return SEARCH_TYPE_ALIASES[value];
      return STREAMING_CATALOG_SEARCH_TYPES.includes(value as StreamingCatalogSearchType)
        ? [value as StreamingCatalogSearchType]
        : [];
    });

  return requestedTypes.length > 0 ? [...new Set(requestedTypes)] : allSearchTypes;
}

function tableForSearchType(type: StreamingCatalogSearchType): string {
  return LOCAL_TABLES[type];
}

function isMonitored(database: Database.Database, id: string, type: StreamingCatalogSearchType): boolean {
  const row = database.prepare(`SELECT monitor FROM ${tableForSearchType(type)} WHERE id = ?`).get(id) as any;
  return row ? Boolean(row.monitor) : false;
}

function isInLibrary(database: Database.Database, id: string, type: StreamingCatalogSearchType): boolean {
  return Boolean(database.prepare(`SELECT 1 FROM ${tableForSearchType(type)} WHERE id = ?`).get(id));
}

function formatSearchResult(item: any, type: SearchResultContract["type"]): SearchResultContract {
  const result: SearchResultContract = {
    id: item.id?.toString(),
    name: item.name || item.title,
    type,
    monitored: Boolean(item.monitored),
    in_library: Boolean(item.in_library),
    quality: item.quality,
    explicit: item.explicit,
  };

  if (type !== "artist") {
    result.subtitle = item.subtitle || item.artist_name || item.artist?.name || null;
  }

  if (type === "artist") {
    result.imageId = item.picture || null;
  } else if (type === "video") {
    result.imageId = item.image_id || item.imageId || item.image || null;
  } else {
    result.imageId = item.cover_id || item.cover || item.image || item.imageId || null;
  }

  if (item.duration !== undefined) {
    result.duration = item.duration;
  }
  if (item.release_date !== undefined) {
    result.release_date = item.release_date;
  }

  return result;
}

function appendFormattedResult(results: SearchResultsContract, result: SearchResultContract) {
  switch (result.type) {
    case "artist":
      results.artists.push(result);
      break;
    case "album":
      results.albums.push(result);
      break;
    case "track":
      results.tracks.push(result);
      break;
    case "video":
      results.videos.push(result);
      break;
  }
}

function appendLocalResults(
  database: Database.Database,
  results: SearchResultsContract,
  query: string,
  limit: number,
  requestedTypes: Set<StreamingCatalogSearchType>,
) {
  const escapedQuery = escapeSqlLike(query);
  const like = `%${escapedQuery}%`;

  if (requestedTypes.has("artists")) {
    const rows = database.prepare(`
      SELECT id, name, picture, monitor
      FROM artists
      WHERE name LIKE ? ESCAPE '\\'
      ORDER BY popularity DESC
      LIMIT ?
    `).all(like, limit) as any[];

    results.artists.push(...rows.map((row) => formatSearchResult({
      id: row.id,
      name: row.name,
      picture: row.picture,
      monitored: Boolean(row.monitor),
      in_library: true,
    }, "artist")));
  }

  if (requestedTypes.has("albums")) {
    const rows = database.prepare(`
      SELECT a.id, a.title, a.cover, a.monitor, ar.name as artist_name
      FROM albums a
      LEFT JOIN artists ar ON ar.id = a.artist_id
      WHERE a.title LIKE ? ESCAPE '\\'
      ORDER BY a.release_date DESC
      LIMIT ?
    `).all(like, limit) as any[];

    results.albums.push(...rows.map((row) => formatSearchResult({
      id: row.id,
      name: row.title,
      cover_id: row.cover,
      artist_name: row.artist_name,
      monitored: Boolean(row.monitor),
      in_library: true,
    }, "album")));
  }

  if (requestedTypes.has("tracks")) {
    const rows = database.prepare(`
      SELECT m.id, m.title, ar.name as artist_name, m.monitor as monitored, a.cover as album_cover
      FROM media m
      LEFT JOIN artists ar ON ar.id = m.artist_id
      LEFT JOIN albums a ON a.id = m.album_id
      WHERE m.album_id IS NOT NULL
        AND m.title LIKE ? ESCAPE '\\'
      ORDER BY m.title
      LIMIT ?
    `).all(like, limit) as any[];

    results.tracks.push(...rows.map((row) => formatSearchResult({
      id: row.id,
      name: row.title,
      artist_name: row.artist_name,
      cover: row.album_cover,
      monitored: Boolean(row.monitored),
      in_library: true,
    }, "track")));
  }

  if (requestedTypes.has("videos")) {
    const rows = database.prepare(`
      SELECT
        m.id,
        m.title,
        ar.name as artist_name,
        m.monitor as monitored,
        m.cover,
        COALESCE((
          SELECT lf.quality
          FROM library_files lf
          WHERE lf.media_id = m.id
            AND lf.file_type = 'video'
          ORDER BY lf.verified_at DESC, lf.id DESC
          LIMIT 1
        ), m.quality) as current_quality
      FROM media m
      LEFT JOIN artists ar ON ar.id = m.artist_id
      WHERE m.type = 'Music Video'
        AND m.title LIKE ? ESCAPE '\\'
      ORDER BY m.release_date DESC
      LIMIT ?
    `).all(like, limit) as any[];

    results.videos.push(...rows.map((row) => formatSearchResult({
      id: row.id,
      name: row.title,
      artist_name: row.artist_name,
      image_id: row.cover,
      quality: row.current_quality,
      monitored: Boolean(row.monitored),
      in_library: true,
    }, "video")));
  }
}

function resolveRemoteTimeoutMs(dependencies: CatalogSearchDependencies): number {
  if (dependencies.remoteTimeoutMs !== undefined) {
    return Math.max(250, Math.min(dependencies.remoteTimeoutMs, 15000));
  }

  return Math.max(250, Math.min(Number(process.env.DISCOGENIUS_SEARCH_REMOTE_TIMEOUT_MS || 2500), 15000));
}

async function appendRemoteResults(params: {
  database: Database.Database;
  provider: StreamingCatalogProvider;
  results: SearchResultsContract;
  query: string;
  requestedTypes: StreamingCatalogSearchType[];
  limit: number;
  timeoutMs: number;
}) {
  const remoteResults = await Promise.race([
    params.provider.search(params.query, params.requestedTypes, params.limit),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Remote search timeout after ${params.timeoutMs}ms`)), params.timeoutMs)),
  ]);

  if (!Array.isArray(remoteResults)) {
    return;
  }

  const seen = new Set(
    [...params.results.artists, ...params.results.albums, ...params.results.tracks, ...params.results.videos]
      .map((result) => `${result.type}:${result.id}`),
  );

  for (const item of remoteResults) {
    if (item.id === null || item.id === undefined || !item.type) {
      continue;
    }

    const itemType = item.type as SearchResultContract["type"];
    const bucket = `${itemType}s` as StreamingCatalogSearchType;
    if (!STREAMING_CATALOG_SEARCH_TYPES.includes(bucket)) {
      continue;
    }

    const id = String(item.id);
    const dedupeKey = `${itemType}:${id}`;
    if (seen.has(dedupeKey)) {
      continue;
    }

    const formatted = formatSearchResult({
      ...item,
      monitored: isMonitored(params.database, id, bucket),
      in_library: isInLibrary(params.database, id, bucket),
    }, itemType);

    appendFormattedResult(params.results, formatted);
    seen.add(dedupeKey);
  }
}

export async function searchCatalog(
  input: CatalogSearchQuery,
  dependencies: CatalogSearchDependencies = {},
): Promise<SearchResponseContract> {
  const query = String(input.query ?? "").trim();
  if (!query || query.length < 2) {
    throw new CatalogSearchValidationError("Query must be at least 2 characters");
  }

  const database = dependencies.database ?? defaultDb;
  const provider = dependencies.provider ?? getDefaultStreamingCatalogProvider();
  const providerAuthMode = (dependencies.providerAuthMode ?? getProviderAuthMode)();
  const limit = parseCatalogSearchLimit(input.limit);
  const requestedTypes = normalizeCatalogSearchTypes(input.type);
  const requestedTypeSet = new Set(requestedTypes);
  const results = createEmptyResults();

  appendLocalResults(database, results, query, limit, requestedTypeSet);

  const remoteCatalogAvailable = providerAuthMode === "live" && provider.hasRemoteAuth();
  if (remoteCatalogAvailable) {
    try {
      await appendRemoteResults({
        database,
        provider,
        results,
        query,
        requestedTypes,
        limit,
        timeoutMs: resolveRemoteTimeoutMs(dependencies),
      });
    } catch (error: any) {
      (dependencies.logger ?? console).error("[search] Remote search failed:", error.message);
    }
  }

  results.artists = results.artists.slice(0, limit);
  results.albums = results.albums.slice(0, limit);
  results.tracks = results.tracks.slice(0, limit);
  results.videos = results.videos.slice(0, limit);

  return {
    success: true,
    results,
    mode: providerAuthMode,
    remoteCatalogAvailable,
  };
}
