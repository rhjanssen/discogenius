import {
  expectArray,
  expectNullableString,
  expectNumber,
  expectOptionalNumber,
  expectRecord,
  expectString,
  expectOneOf,
} from "./runtime.js";

export const HISTORY_EVENT_TYPES = [
  "Unknown",
  "Grabbed",
  "TrackFileImported",
  "DownloadFailed",
  "TrackFileDeleted",
  "TrackFileRenamed",
  "AlbumImportIncomplete",
  "DownloadImported",
  "TrackFileRetagged",
  "DownloadIgnored",
] as const;

export type HistoryEventTypeContract = typeof HISTORY_EVENT_TYPES[number];

export interface HistoryEventItemContract {
  id: number;
  artistId: number | null;
  albumId: number | null;
  mediaId: number | null;
  libraryFileId: number | null;
  eventType: HistoryEventTypeContract;
  quality: string | null;
  sourceTitle: string | null;
  data: Record<string, unknown> | null;
  date: string;
}

export interface ListHistoryEventsResponseContract {
  items: HistoryEventItemContract[];
  total: number;
  limit: number;
  offset: number;
}

function expectNullableNumber(value: unknown, label: string): number | null {
  if (value === undefined) {
    return null;
  }
  if (value === null) {
    return null;
  }
  return expectNumber(value, label);
}

function parseHistoryData(value: unknown, label: string): Record<string, unknown> | null {
  if (value === null || value === undefined) {
    return null;
  }

  const record = expectRecord(value, label);
  return record;
}

function parseHistoryEventItemContract(value: unknown, index: number): HistoryEventItemContract {
  const label = `history.items[${index}]`;
  const record = expectRecord(value, label);

  return {
    id: expectNumber(record.id, `${label}.id`),
    artistId: expectNullableNumber(record.artistId, `${label}.artistId`),
    albumId: expectNullableNumber(record.albumId, `${label}.albumId`),
    mediaId: expectNullableNumber(record.mediaId, `${label}.mediaId`),
    libraryFileId: expectNullableNumber(record.libraryFileId, `${label}.libraryFileId`),
    eventType: expectOneOf(record.eventType, HISTORY_EVENT_TYPES, `${label}.eventType`),
    quality: expectNullableString(record.quality, `${label}.quality`) ?? null,
    sourceTitle: expectNullableString(record.sourceTitle, `${label}.sourceTitle`) ?? null,
    data: parseHistoryData(record.data, `${label}.data`),
    date: expectString(record.date, `${label}.date`),
  };
}

export function parseHistoryEventsResponseContract(value: unknown): ListHistoryEventsResponseContract {
  const record = expectRecord(value, "history");
  return {
    items: expectArray(record.items, "history.items", parseHistoryEventItemContract),
    total: expectNumber(record.total, "history.total"),
    limit: expectNumber(record.limit, "history.limit"),
    offset: expectNumber(record.offset, "history.offset"),
  };
}
