import type Database from "better-sqlite3";
import type { QueueListResponseContract } from "../../contracts/status.js";

export interface QueueCursor {
  /** 0 = running ('started'), 1 = pending (unclaimed or 'queued') */
  s: 0 | 1;
  /** DownloadQueue.queue_order */
  o: number;
  /** DownloadQueue.id */
  i: number;
}

export interface QueuePageQuery {
  limit: number;
  offset?: number;
  cursor?: string;
  status?: string;
  provider?: string;
  album?: string;
}

export interface WaitQueueJoinedRow {
  id: number;
  ref_key: string;
  media_kind: string;
  command_name: string;
  plan_id: number | null;
  edition_id: number | null;
  provider: string | null;
  provider_id: string | null;
  artist_id: string | null;
  album_id: string | null;
  title: string | null;
  artist: string | null;
  cover: string | null;
  quality: string | null;
  slot: string | null;
  wait_payload: unknown;
  queue_order: number;
  command_id: number | null;
  created_at: string;
  updated_at: string;
  command_status: string | null;
  command_payload?: unknown;
  command_progress: number | null;
  command_error: string | null;
  started_at: string | null;
  completed_at: string | null;
  command_updated_at: string | null;
}

export interface QueuePageRawResult {
  rows: WaitQueueJoinedRow[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  nextCursor: string | null;
  queuePositionEntries: Array<[number, number]>;
}

export function encodeQueueCursor(cursor: QueueCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeQueueCursor(raw?: string | null): QueueCursor | null {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(Buffer.from(trimmed, "base64url").toString("utf8")) as Record<string, unknown>;
    const s = parsed.s === 0 ? 0 : parsed.s === 1 ? 1 : null;
    const o = typeof parsed.o === "number" && Number.isFinite(parsed.o) ? parsed.o : null;
    const i = typeof parsed.i === "number" && Number.isInteger(parsed.i) && parsed.i > 0 ? parsed.i : null;
    if (s === null || o === null || i === null) return null;
    return { s, o, i };
  } catch {
    return null;
  }
}

const WAIT_QUEUE_LIST_SQL = `
  SELECT
    dq.id,
    dq.ref_key,
    dq.media_kind,
    dq.command_name,
    dq.plan_id,
    dq.edition_id,
    dq.provider,
    dq.provider_id,
    dq.artist_id,
    dq.album_id,
    dq.title,
    dq.artist,
    dq.cover,
    dq.quality,
    dq.slot,
    dq.payload AS wait_payload,
    dq.queue_order,
    dq.command_id,
    dq.created_at,
    dq.updated_at,
    c.status AS command_status,
    c.progress AS command_progress,
    c.error AS command_error,
    c.started_at,
    c.completed_at,
    c.updated_at AS command_updated_at
  FROM DownloadQueue dq
  LEFT JOIN commands c ON c.id = dq.command_id
`;

const WAIT_QUEUE_ORDER_SQL = `
  ORDER BY
    CASE
      WHEN c.status = 'started' THEN 0
      ELSE 1
    END,
    dq.queue_order ASC,
    dq.id ASC
`;

function normalizeStatusFilter(status?: string): "all" | "queued" | "started" | "empty" {
  const normalized = String(status || "").trim().toLowerCase();
  if (!normalized || normalized === "all") return "all";
  if (normalized === "queued") return "queued";
  if (normalized === "started" || normalized === "downloading") return "started";
  if (normalized === "completed" || normalized === "failed" || normalized === "cancelled") return "empty";
  return "all";
}

function buildFilterClauses(params: QueuePageQuery): { sql: string; bindParams: Record<string, unknown>; hasFilter: boolean } {
  const clauses: string[] = [];
  const bindParams: Record<string, unknown> = {};
  const provider = String(params.provider || "").trim();
  const album = String(params.album || "").trim();

  if (provider) {
    clauses.push("LOWER(dq.provider) = LOWER(@provider)");
    bindParams.provider = provider;
  }
  if (album) {
    clauses.push("dq.album_id = @album");
    bindParams.album = album;
  }

  return {
    sql: clauses.length > 0 ? ` AND ${clauses.join(" AND ")}` : "",
    bindParams,
    hasFilter: clauses.length > 0,
  };
}

function attachStartedCommandPayloads(database: Database.Database, rows: WaitQueueJoinedRow[]): void {
  const commandIds = [...new Set(
    rows
      .filter((row) => row.command_status === "started" && row.command_id != null)
      .map((row) => Number(row.command_id)),
  )];
  if (commandIds.length === 0) return;
  const marks = commandIds.map(() => "?").join(",");
  const payloads = database.prepare(`
    SELECT id, payload FROM commands WHERE id IN (${marks})
  `).all(...commandIds) as Array<{ id: number; payload: unknown }>;
  const byId = new Map(payloads.map((row) => [Number(row.id), row.payload]));
  for (const row of rows) {
    if (row.command_id != null) {
      row.command_payload = byId.get(Number(row.command_id)) ?? null;
    }
  }
}

function computePendingPositions(
  database: Database.Database,
  rows: WaitQueueJoinedRow[],
  hasFilter: boolean,
): Array<[number, number]> {
  const pendingUnclaimed = rows.filter(
    (row) => row.command_status !== "started" && row.command_id == null,
  );
  if (pendingUnclaimed.length === 0) {
    return [];
  }

  if (!hasFilter) {
    // Unfiltered pending rows on the page are contiguous in (queue_order, id).
    // Compute the anchor position once using idx_download_queue_unclaimed_order
    // instead of running N correlated subqueries.
    const first = pendingUnclaimed[0];
    const anchor = database.prepare(`
      SELECT COUNT(*) AS pos
      FROM DownloadQueue ahead
      WHERE ahead.command_id IS NULL
        AND (
          ahead.queue_order < ?
          OR (ahead.queue_order = ? AND ahead.id <= ?)
        )
    `).get(first.queue_order, first.queue_order, first.id) as { pos?: number } | undefined;
    const basePos = Number(anchor?.pos || 1);
    return pendingUnclaimed.map((row, index) => [Number(row.id), basePos + index]);
  }

  // Filtered pages are typically small; bound per-row lookups.
  const targetRows = pendingUnclaimed.slice(0, 25);
  const ids = targetRows.map((r) => Number(r.id));
  const idPlaceholders = ids.map(() => "?").join(",");
  const posRows = database.prepare(`
    SELECT
      page.id,
      (
        SELECT COUNT(*)
        FROM DownloadQueue ahead
        WHERE ahead.command_id IS NULL
          AND (
            ahead.queue_order < page.queue_order
            OR (ahead.queue_order = page.queue_order AND ahead.id <= page.id)
          )
      ) AS queuePosition
    FROM DownloadQueue page
    WHERE page.id IN (${idPlaceholders})
  `).all(...ids) as Array<{ id: number; queuePosition: number }>;

  return posRows.map((row) => [Number(row.id), Number(row.queuePosition)]);
}

export function readQueuePage(database: Database.Database, params: QueuePageQuery): QueuePageRawResult {
  const limit = Math.max(1, Math.min(1000, Math.floor(Number(params.limit) || 100)));
  const offset = Math.max(0, Math.floor(Number(params.offset) || 0));
  const statusFilter = normalizeStatusFilter(params.status);

  if (statusFilter === "empty") {
    return {
      rows: [],
      total: 0,
      limit,
      offset,
      hasMore: false,
      nextCursor: null,
      queuePositionEntries: [],
    };
  }

  const filter = buildFilterClauses(params);
  const cursor = decodeQueueCursor(params.cursor);
  const fetchLimit = limit + 1;

  const runningPredicate = statusFilter === "queued"
    ? "0 = 1"
    : `c.status = 'started'${filter.sql}`;
  const pendingPredicate = statusFilter === "started"
    ? "0 = 1"
    : `(dq.command_id IS NULL OR dq.command_id IN (SELECT id FROM commands WHERE status = 'queued'))${filter.sql}`;

  const totalRow = database.prepare(`
    SELECT (
      ${statusFilter === "queued" ? "0" : `(SELECT COUNT(*) FROM commands c JOIN DownloadQueue dq ON dq.command_id = c.id WHERE ${runningPredicate})`}
      +
      ${statusFilter === "started" ? "0" : `(SELECT COUNT(*) FROM DownloadQueue dq WHERE ${pendingPredicate})`}
    ) AS count
  `).get(filter.bindParams) as { count?: number } | undefined;
  const total = Number(totalRow?.count || 0);

  let rows: WaitQueueJoinedRow[];
  if (cursor) {
    const runningKeyset = cursor.s === 0
      ? "AND (dq.queue_order > @cursorOrder OR (dq.queue_order = @cursorOrder AND dq.id > @cursorId))"
      : "AND 0 = 1";
    const pendingKeyset = cursor.s === 1
      ? "AND (dq.queue_order > @cursorOrder OR (dq.queue_order = @cursorOrder AND dq.id > @cursorId))"
      : "";

    const sql = `
      WITH running AS MATERIALIZED (
        SELECT dq.id FROM commands c
        JOIN DownloadQueue dq ON dq.command_id = c.id
        WHERE ${runningPredicate} ${runningKeyset}
        ORDER BY dq.queue_order, dq.id
        LIMIT @fetchLimit
      ), pending AS MATERIALIZED (
        SELECT dq.id FROM DownloadQueue dq
        WHERE ${pendingPredicate} ${pendingKeyset}
        ORDER BY dq.queue_order, dq.id
        LIMIT MAX(0, @fetchLimit - (SELECT COUNT(*) FROM running))
      )
      ${WAIT_QUEUE_LIST_SQL}
      WHERE dq.id IN (SELECT id FROM running UNION ALL SELECT id FROM pending)
      ${WAIT_QUEUE_ORDER_SQL}
    `;
    rows = database.prepare(sql).all({
      ...filter.bindParams,
      fetchLimit,
      cursorOrder: cursor.o,
      cursorId: cursor.i,
    }) as WaitQueueJoinedRow[];
  } else {
    const sql = `
      WITH running AS MATERIALIZED (
        SELECT dq.id FROM commands c
        JOIN DownloadQueue dq ON dq.command_id = c.id
        WHERE ${runningPredicate}
        ORDER BY dq.queue_order, dq.id
        LIMIT @fetchLimit OFFSET @offset
      ), running_count AS MATERIALIZED (
        SELECT COUNT(*) AS n FROM commands c
        JOIN DownloadQueue dq ON dq.command_id = c.id
        WHERE ${runningPredicate}
      ), pending AS MATERIALIZED (
        SELECT dq.id FROM DownloadQueue dq
        WHERE ${pendingPredicate}
        ORDER BY dq.queue_order, dq.id
        LIMIT MAX(0, @fetchLimit - (SELECT COUNT(*) FROM running))
        OFFSET MAX(0, @offset - (SELECT n FROM running_count))
      )
      ${WAIT_QUEUE_LIST_SQL}
      WHERE dq.id IN (SELECT id FROM running UNION ALL SELECT id FROM pending)
      ${WAIT_QUEUE_ORDER_SQL}
    `;
    rows = database.prepare(sql).all({
      ...filter.bindParams,
      fetchLimit,
      offset,
    }) as WaitQueueJoinedRow[];
  }

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  attachStartedCommandPayloads(database, pageRows);

  const lastRow = pageRows[pageRows.length - 1];
  const nextCursor = hasMore && lastRow
    ? encodeQueueCursor({
      s: lastRow.command_status === "started" ? 0 : 1,
      o: Number(lastRow.queue_order),
      i: Number(lastRow.id),
    })
    : null;

  const queuePositionEntries = computePendingPositions(database, pageRows, filter.hasFilter);

  return {
    rows: pageRows,
    total,
    limit,
    offset,
    hasMore,
    nextCursor,
    queuePositionEntries,
  };
}

export type { QueueListResponseContract };
