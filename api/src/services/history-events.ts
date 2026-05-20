import { db } from "../database.js";
import { appEvents, AppEvent } from "./app-events.js";

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
  artistId: string | null;
  albumId: string | null;
  mediaId: string | null;
  libraryFileId: string | null;
  eventType: HistoryEventType;
  quality: string | null;
  sourceTitle: string | null;
  data: HistoryEventData | null;
  date: string;
};

export type ListHistoryEventsOptions = {
  artistId?: number | string;
  albumId?: number | string;
  mediaId?: number | string;
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

function toNullableText(value: number | string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const text = String(value).trim();
  if (!text) {
    return null;
  }

  return text;
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
    toNullableText(input.artistId),
    toNullableText(input.albumId),
    toNullableText(input.mediaId),
    toNullableText(input.libraryFileId),
    input.eventType,
    input.quality ?? null,
    input.sourceTitle ?? null,
    dataJson,
  );

  const id = Number(result.lastInsertRowid || 0);
  appEvents.emit(AppEvent.HISTORY_ADDED, {
    id,
    eventType: input.eventType,
    artistId: input.artistId ?? null,
    albumId: input.albumId ?? null,
    mediaId: input.mediaId ?? null,
    libraryFileId: input.libraryFileId ?? null,
    sourceTitle: input.sourceTitle ?? null,
  });

  return id;
}

export function listHistoryEvents(options: ListHistoryEventsOptions = {}): ListHistoryEventsResult {
  const limit = Math.min(200, Math.max(1, options.limit ?? 50));
  const offset = Math.max(0, options.offset ?? 0);

  const whereClauses: string[] = [];
  const whereParams: string[] = [];

  if (options.artistId !== undefined) {
    whereClauses.push("artist_id = ?");
    whereParams.push(String(options.artistId));
  }

  if (options.albumId !== undefined) {
    whereClauses.push("album_id = ?");
    whereParams.push(String(options.albumId));
  }

  if (options.mediaId !== undefined) {
    whereClauses.push("media_id = ?");
    whereParams.push(String(options.mediaId));
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
    artist_id: string | null;
    album_id: string | null;
    media_id: string | null;
    library_file_id: string | null;
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
