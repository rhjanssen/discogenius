import { db } from "../database.js";

export const HISTORY_EVENT_TYPES = {
  Unknown: "Unknown",
  Grabbed: "Grabbed",
  TrackFileImported: "TrackFileImported",
  DownloadFailed: "DownloadFailed",
  TrackFileDeleted: "TrackFileDeleted",
  TrackFileRenamed: "TrackFileRenamed",
  AlbumImportIncomplete: "AlbumImportIncomplete",
  DownloadImported: "DownloadImported",
  TrackFileRetagged: "TrackFileRetagged",
  DownloadIgnored: "DownloadIgnored",
} as const;

export type HistoryEventType = typeof HISTORY_EVENT_TYPES[keyof typeof HISTORY_EVENT_TYPES];

export const HISTORY_EVENT_TYPE_VALUES = Object.values(HISTORY_EVENT_TYPES) as HistoryEventType[];

type HistoryEventData = Record<string, unknown>;

export type RecordHistoryEventInput = {
  artistId?: number | string | null;
  albumId?: number | string | null;
  mediaId?: number | string | null;
  libraryFileId?: number | string | null;
  eventType: HistoryEventType;
  quality?: string | null;
  sourceTitle?: string | null;
  data?: HistoryEventData | null;
};

export type HistoryEventItem = {
  id: number;
  artistId: number | null;
  albumId: number | null;
  mediaId: number | null;
  libraryFileId: number | null;
  eventType: HistoryEventType;
  quality: string | null;
  sourceTitle: string | null;
  data: HistoryEventData | null;
  date: string;
};

export type ListHistoryEventsOptions = {
  artistId?: number;
  albumId?: number;
  mediaId?: number;
  eventType?: HistoryEventType;
  limit?: number;
  offset?: number;
};

export type ListHistoryEventsResult = {
  items: HistoryEventItem[];
  total: number;
  limit: number;
  offset: number;
};

export type HistoryEventFeedItem = {
  id: number;
  eventType: HistoryEventType;
  sourceTitle: string | null;
  date: string;
};

const INTEGER_STRING_PATTERN = /^\d+$/;

function toNullableInt(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string" && !INTEGER_STRING_PATTERN.test(value)) {
    return null;
  }

  const numericValue = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(numericValue)) {
    return null;
  }

  return numericValue;
}

function parseData(value: string | null): HistoryEventData | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as HistoryEventData
      : null;
  } catch {
    return null;
  }
}

export function recordHistoryEvent(input: RecordHistoryEventInput): number {
  const dataJson = input.data === undefined || input.data === null ? null : JSON.stringify(input.data);

  const result = db.prepare(`
    INSERT INTO history_events (
      artist_id,
      album_id,
      media_id,
      library_file_id,
      event_type,
      quality,
      source_title,
      data
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    toNullableInt(input.artistId),
    toNullableInt(input.albumId),
    toNullableInt(input.mediaId),
    toNullableInt(input.libraryFileId),
    input.eventType,
    input.quality ?? null,
    input.sourceTitle ?? null,
    dataJson,
  );

  return Number(result.lastInsertRowid || 0);
}

export function listHistoryEvents(options: ListHistoryEventsOptions = {}): ListHistoryEventsResult {
  const limit = Math.min(200, Math.max(1, options.limit ?? 50));
  const offset = Math.max(0, options.offset ?? 0);

  const whereClauses: string[] = [];
  const whereParams: Array<number | string> = [];

  if (options.artistId !== undefined) {
    whereClauses.push("artist_id = ?");
    whereParams.push(options.artistId);
  }

  if (options.albumId !== undefined) {
    whereClauses.push("album_id = ?");
    whereParams.push(options.albumId);
  }

  if (options.mediaId !== undefined) {
    whereClauses.push("media_id = ?");
    whereParams.push(options.mediaId);
  }

  if (options.eventType !== undefined) {
    whereClauses.push("event_type = ?");
    whereParams.push(options.eventType);
  }

  const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

  const totalRow = db.prepare(`
    SELECT COUNT(*) AS count
    FROM history_events
    ${whereSql}
  `).get(...whereParams) as { count?: number } | undefined;

  const rows = db.prepare(`
    SELECT
      id,
      artist_id,
      album_id,
      media_id,
      library_file_id,
      event_type,
      quality,
      source_title,
      data,
      date
    FROM history_events
    ${whereSql}
    ORDER BY date DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(...whereParams, limit, offset) as Array<{
    id: number;
    artist_id: number | null;
    album_id: number | null;
    media_id: number | null;
    library_file_id: number | null;
    event_type: HistoryEventType;
    quality: string | null;
    source_title: string | null;
    data: string | null;
    date: string;
  }>;

  const items: HistoryEventItem[] = rows.map((row) => ({
    id: row.id,
    artistId: row.artist_id,
    albumId: row.album_id,
    mediaId: row.media_id,
    libraryFileId: row.library_file_id,
    eventType: row.event_type,
    quality: row.quality,
    sourceTitle: row.source_title,
    data: parseData(row.data),
    date: row.date,
  }));

  return {
    items,
    total: Number(totalRow?.count || 0),
    limit,
    offset,
  };
}

export function countHistoryEvents(): number {
  const row = db.prepare("SELECT COUNT(*) AS count FROM history_events").get() as { count?: number } | undefined;
  return Number(row?.count || 0);
}

export function listHistoryEventFeedItems(limit: number, offset: number): HistoryEventFeedItem[] {
  const normalizedLimit = Math.max(1, limit);
  const normalizedOffset = Math.max(0, offset);

  const rows = db.prepare(`
    SELECT id, event_type, source_title, date
    FROM history_events
    ORDER BY date DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(normalizedLimit, normalizedOffset) as Array<{
    id: number;
    event_type: HistoryEventType;
    source_title: string | null;
    date: string;
  }>;

  return rows.map((row) => ({
    id: row.id,
    eventType: row.event_type,
    sourceTitle: row.source_title,
    date: row.date,
  }));
}
