import { db } from "../../database.js";
import { CommandTrigger } from "../commands/command-trigger.js";
import {
  CommandNames,
  type CommandName,
} from "../commands/command-names.js";
import { CommandQueueManager } from "../commands/command-queue-manager.js";
import { appEvents, AppEvent } from "../commands/app-events.js";
import {
  buildAcquisitionDownloadCommand,
} from "../music/acquisition-download-command.js";
import type { AnyCommandBody } from "../commands/command-model.js";

export type DownloadWaitMediaKind = "album" | "track" | "video";
export type DownloadWaitPosition = "front" | "back";

export interface DownloadWaitEnqueueInput {
  refKey: string;
  mediaKind: DownloadWaitMediaKind;
  commandName: typeof CommandNames.DownloadAlbum
    | typeof CommandNames.DownloadTrack
    | typeof CommandNames.DownloadVideo;
  planId?: number | null;
  trackIds?: readonly number[];
  provider?: string | null;
  providerId?: string | null;
  artistId?: string | null;
  albumId?: string | null;
  title?: string | null;
  artist?: string | null;
  cover?: string | null;
  quality?: string | null;
  slot?: string | null;
  payload?: Record<string, unknown>;
  priority?: number;
  trigger?: number;
  /** Tidarr: user-initiated items sit before the first waiting row. */
  position?: DownloadWaitPosition;
  /** Set false when the caller will notify once after a batch. */
  notify?: boolean;
}

export interface DownloadWaitEnqueueResult {
  id: number;
  created: boolean;
  commandId: number | null;
}

export interface DownloadWaitRow {
  id: number;
  ref_key: string;
  media_kind: DownloadWaitMediaKind;
  command_name: string;
  plan_id: number | null;
  track_ids: number[];
  provider: string | null;
  provider_id: string | null;
  artist_id: string | null;
  album_id: string | null;
  title: string | null;
  artist: string | null;
  cover: string | null;
  quality: string | null;
  slot: string | null;
  payload: Record<string, unknown>;
  queue_order: number;
  priority: number;
  trigger: number;
  command_id: number | null;
  claimed_at: string | null;
  created_at: string;
  updated_at: string;
}

const QUEUE_RANK_STEP = 1024;
const QUEUE_REBALANCE_WINDOW = 64;
const CUTOVER_NOTIFY = true;

type QueueRankRow = { id: number; queue_order: number };

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function parseTrackIds(value: unknown): number[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is number => Number.isInteger(item) && item > 0);
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is number => Number.isInteger(item) && item > 0)
      : [];
  } catch {
    return [];
  }
}

function hydrateWaitRow(row: Record<string, unknown>): DownloadWaitRow {
  return {
    id: Number(row.id),
    ref_key: String(row.ref_key),
    media_kind: row.media_kind === "video" || row.media_kind === "track" ? row.media_kind : "album",
    command_name: String(row.command_name),
    plan_id: row.plan_id == null ? null : Number(row.plan_id),
    track_ids: parseTrackIds(row.track_ids),
    provider: row.provider == null ? null : String(row.provider),
    provider_id: row.provider_id == null ? null : String(row.provider_id),
    artist_id: row.artist_id == null ? null : String(row.artist_id),
    album_id: row.album_id == null ? null : String(row.album_id),
    title: row.title == null ? null : String(row.title),
    artist: row.artist == null ? null : String(row.artist),
    cover: row.cover == null ? null : String(row.cover),
    quality: row.quality == null ? null : String(row.quality),
    slot: row.slot == null ? null : String(row.slot),
    payload: parseJsonObject(row.payload),
    queue_order: Number(row.queue_order),
    priority: Number(row.priority ?? 0),
    trigger: Number(row.trigger ?? 0),
    command_id: row.command_id == null ? null : Number(row.command_id),
    claimed_at: row.claimed_at == null ? null : String(row.claimed_at),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function allocateFractionalQueueRanks(
  previousRank: number | null,
  nextRank: number | null,
  count: number,
): number[] | null {
  if (count <= 0) return [];

  if (previousRank == null && nextRank == null) {
    return Array.from({ length: count }, (_, index) => QUEUE_RANK_STEP * (index + 1));
  }

  if (previousRank == null && nextRank != null) {
    const first = nextRank - (QUEUE_RANK_STEP * count);
    const ranks = Array.from({ length: count }, (_, index) => first + (QUEUE_RANK_STEP * index));
    return ranks.every((rank) => Number.isFinite(rank) && rank < nextRank) ? ranks : null;
  }

  if (previousRank != null && nextRank == null) {
    const ranks = Array.from({ length: count }, (_, index) => previousRank + (QUEUE_RANK_STEP * (index + 1)));
    return ranks.every((rank) => Number.isFinite(rank) && rank > previousRank) ? ranks : null;
  }

  const previous = previousRank as number;
  const next = nextRank as number;
  const step = (next - previous) / (count + 1);
  if (!Number.isFinite(step) || step <= 0) return null;

  const ranks = Array.from({ length: count }, (_, index) => previous + (step * (index + 1)));
  let last = previous;
  for (const rank of ranks) {
    if (!Number.isFinite(rank) || rank <= last || rank >= next) return null;
    last = rank;
  }
  return ranks;
}

function notifyQueueChanged(): void {
  if (!CUTOVER_NOTIFY) return;
  appEvents.emit(AppEvent.QUEUE_CLEARED);
}

export class DownloadWaitQueue {
  static get(id: number): DownloadWaitRow | null {
    const row = db.prepare(`SELECT * FROM DownloadQueue WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? hydrateWaitRow(row) : null;
  }

  static getByRefKey(refKey: string): DownloadWaitRow | null {
    const row = db.prepare(`
      SELECT * FROM DownloadQueue
      WHERE ref_key = ?
      ORDER BY id
      LIMIT 1
    `).get(refKey) as Record<string, unknown> | undefined;
    return row ? hydrateWaitRow(row) : null;
  }

  private static findExistingTypedJob(input: DownloadWaitEnqueueInput, refKey: string): DownloadWaitRow | null {
    const row = db.prepare(`
      SELECT * FROM DownloadQueue
      WHERE media_kind = ?
        AND ref_key = ?
        AND COALESCE(provider, '') = COALESCE(?, '')
        AND COALESCE(slot, '') = COALESCE(?, '')
      LIMIT 1
    `).get(
      input.mediaKind,
      refKey,
      input.provider ?? null,
      input.slot ?? null,
    ) as Record<string, unknown> | undefined;
    return row ? hydrateWaitRow(row) : null;
  }

  /**
   * Manual video downloads key the wait row by provider id; Download Missing
   * keys it by recording id. Treat the same provider video as already queued
   * either way so a Download Missing pass cannot start a second copy while
   * the first job is still downloading.
   */
  private static findExistingVideoJob(input: DownloadWaitEnqueueInput): DownloadWaitRow | null {
    if (input.mediaKind !== "video") return null;
    const providerId = String(input.providerId || "").trim();
    if (!providerId) return null;
    const row = db.prepare(`
      SELECT * FROM DownloadQueue
      WHERE media_kind = 'video'
        AND COALESCE(provider, '') = COALESCE(?, '')
        AND CAST(provider_id AS TEXT) = CAST(? AS TEXT)
      LIMIT 1
    `).get(input.provider ?? null, providerId) as Record<string, unknown> | undefined;
    return row ? hydrateWaitRow(row) : null;
  }

  static getByCommandId(commandId: number): DownloadWaitRow | null {
    const row = db.prepare(`
      SELECT * FROM DownloadQueue WHERE command_id = ?
    `).get(commandId) as Record<string, unknown> | undefined;
    return row ? hydrateWaitRow(row) : null;
  }

  static getIdByCommandId(commandId: number): number | null {
    const row = db.prepare(`
      SELECT id FROM DownloadQueue WHERE command_id = ?
    `).get(commandId) as { id?: number } | undefined;
    return row?.id != null ? Number(row.id) : null;
  }

  static count(): number {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM DownloadQueue`).get() as { count?: number };
    return Number(row.count || 0);
  }

  static countUnclaimed(): number {
    const row = db.prepare(`
      SELECT COUNT(*) AS count FROM DownloadQueue WHERE command_id IS NULL
    `).get() as { count?: number };
    return Number(row.count || 0);
  }

  static countUnclaimedByCommandName(): Map<string, number> {
    const rows = db.prepare(`
      SELECT command_name AS name, COUNT(*) AS count
      FROM DownloadQueue
      WHERE command_id IS NULL
      GROUP BY command_name
    `).all() as Array<{ name: string; count: number }>;
    return new Map(rows.map((row) => [row.name, Number(row.count)]));
  }

  /**
   * Waiting work lives in DownloadQueue. A queued Download* command with no
   * wait-row claim is leftover cutover/pause debris and must not age /health
   * or jump the wait list.
   */
  static dropUnclaimedDownloadCommands(): number {
    const result = db.prepare(`
      DELETE FROM commands
      WHERE name IN ('DownloadTrack', 'DownloadVideo', 'DownloadAlbum')
        AND status = 'queued'
        AND id NOT IN (
          SELECT command_id FROM DownloadQueue WHERE command_id IS NOT NULL
        )
    `).run();
    return Number(result.changes ?? 0);
  }

  static enqueue(input: DownloadWaitEnqueueInput): DownloadWaitEnqueueResult {
    const refKey = String(input.refKey || "").trim();
    if (!refKey) {
      throw new Error("Download wait queue requires a refKey.");
    }

    const existing = this.findExistingTypedJob(input, refKey)
      ?? this.findExistingVideoJob(input);
    if (existing) {
      return { id: existing.id, created: false, commandId: existing.command_id };
    }

    const position = input.position === "front" ? "front" : "back";
    const payload = input.payload ?? {};
    const trackIds = input.trackIds ?? [];
    const inserted = db.transaction(() => {
      const rank = position === "front" ? this.nextFrontRank() : this.nextAppendRank();
      const info = db.prepare(`
        INSERT INTO DownloadQueue (
          ref_key, media_kind, command_name, plan_id, track_ids,
          provider, provider_id, artist_id, album_id,
          title, artist, cover, quality, slot, payload,
          queue_order, priority, trigger
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        refKey,
        input.mediaKind,
        input.commandName,
        input.planId ?? null,
        trackIds.length > 0 ? JSON.stringify(trackIds) : null,
        input.provider ?? null,
        input.providerId ?? null,
        input.artistId ?? null,
        input.albumId ?? null,
        input.title ?? null,
        input.artist ?? null,
        input.cover ?? null,
        input.quality ?? null,
        input.slot ?? null,
        JSON.stringify(payload),
        rank,
        input.priority ?? 0,
        input.trigger ?? CommandTrigger.Unspecified,
      );
      return Number(info.lastInsertRowid);
    })();

    if (input.notify !== false) {
      notifyQueueChanged();
    }
    return { id: inserted, created: true, commandId: null };
  }

  static notifyChanged(): void {
    notifyQueueChanged();
  }

  static enqueueMany(inputs: readonly DownloadWaitEnqueueInput[]): {
    ids: number[];
    created: number;
  } {
    if (inputs.length === 0) {
      return { ids: [], created: 0 };
    }

    const ids: number[] = [];
    let created = 0;
    const tx = db.transaction(() => {
      for (const input of inputs) {
        const result = this.enqueue(input);
        ids.push(result.id);
        if (result.created) created += 1;
      }
    });
    tx();
    if (created > 0) {
      notifyQueueChanged();
    }
    return { ids, created };
  }

  static remove(id: number): DownloadWaitRow | null {
    const row = this.get(id);
    if (!row) return null;
    db.prepare(`DELETE FROM DownloadQueue WHERE id = ?`).run(id);
    notifyQueueChanged();
    return row;
  }

  static removeByCommandId(commandId: number): boolean {
    return this.finishClaimed(commandId) != null;
  }

  /**
   * Drop the wait row for a finished command and return its public queue id.
   * Capture that id *before* emitting SSE: once the row is gone,
   * `getIdByCommandId` can no longer map the command onto the wait-row jobId
   * the Queue page keys on.
   */
  static finishClaimed(commandId: number): number | null {
    const waitId = this.getIdByCommandId(commandId);
    if (waitId == null) return null;
    db.prepare(`DELETE FROM DownloadQueue WHERE id = ?`).run(waitId);
    notifyQueueChanged();
    return waitId;
  }

  static claimNext(excludeProviders: ReadonlySet<string> = new Set()): {
    wait: DownloadWaitRow;
    commandId: number;
  } | null {
    const candidates = db.prepare(`
      SELECT *
      FROM DownloadQueue
      WHERE command_id IS NULL
      ORDER BY queue_order ASC, id ASC
      LIMIT 40
    `).all() as Array<Record<string, unknown>>;

    for (const raw of candidates) {
      const wait = hydrateWaitRow(raw);
      const provider = (wait.provider || String(wait.payload.provider || "")).toLowerCase();
      if (provider && excludeProviders.has(provider)) {
        continue;
      }

      const claimed = this.claim(wait.id);
      if (claimed) {
        return claimed;
      }
    }

    return null;
  }

  static claim(waitId: number): { wait: DownloadWaitRow; commandId: number } | null {
    const wait = this.get(waitId);
    if (!wait || wait.command_id != null) {
      return wait?.command_id != null
        ? { wait, commandId: wait.command_id }
        : null;
    }

    let commandName: CommandName = wait.command_name as CommandName;
    let body: AnyCommandBody;
    let refId = wait.ref_key;

    if (wait.plan_id != null) {
      let command = buildAcquisitionDownloadCommand(db, wait.plan_id, {
        trackIds: wait.track_ids,
      });
      if (!command && wait.album_id) {
        const current = db.prepare(`
          SELECT plan.id
          FROM SelectedAcquisitionPlans plan
          JOIN LibraryEditions library_release ON library_release.id = plan.library_edition_id
          JOIN Libraries library ON library.id = library_release.library_id
          JOIN quality_profiles quality_profile ON quality_profile.id = library.quality_profile_id
          JOIN AlbumEditions release ON release.id = library_release.edition_id
          JOIN Albums release_group ON release_group.id = release.release_group_id
          WHERE plan.state = 'current'
            AND library.enabled = 1
            AND release_group.mbid = ?
            AND (
              (? = 'spatial' AND EXISTS (
                SELECT 1
                FROM json_each(COALESCE(quality_profile.allowed_source_formats, '[]')) allowed
                WHERE LOWER(CAST(allowed.value AS TEXT)) = 'spatial'
              ))
              OR ((? IS NULL OR ? = 'stereo')
                AND NOT EXISTS (
                  SELECT 1
                  FROM json_each(COALESCE(quality_profile.allowed_source_formats, '[]')) allowed
                  WHERE LOWER(CAST(allowed.value AS TEXT)) = 'spatial'
                )
                AND EXISTS (
                  SELECT 1
                  FROM json_each(COALESCE(quality_profile.allowed_source_formats, '[]')) allowed
                  WHERE LOWER(CAST(allowed.value AS TEXT)) IN ('lossy', 'lossless', 'hires-lossless')
                )
              )
            )
          ORDER BY library.id
          LIMIT 1
        `).get(wait.album_id, wait.slot, wait.slot, wait.slot) as { id: number } | undefined;
        if (current) {
          command = buildAcquisitionDownloadCommand(db, current.id, {
            trackIds: wait.track_ids,
          });
        }
      }
      if (!command) {
        this.remove(wait.id);
        return null;
      }
      commandName = command.name;
      body = command.body;
      refId = command.refId;
    } else {
      body = {
        ...wait.payload,
        type: wait.media_kind,
        provider: wait.provider ?? wait.payload.provider,
        providerId: wait.provider_id ?? wait.payload.providerId,
        title: wait.title ?? wait.payload.title,
        artist: wait.artist ?? wait.payload.artist,
        cover: wait.cover ?? wait.payload.cover,
        quality: wait.quality ?? wait.payload.quality,
        slot: wait.slot ?? wait.payload.slot,
        albumId: wait.album_id ?? wait.payload.albumId,
        album_id: wait.album_id ?? wait.payload.album_id,
      } as AnyCommandBody;
    }

    const commandId = CommandQueueManager.push(
      commandName,
      body,
      refId,
      wait.priority,
      wait.trigger,
    );
    if (commandId <= 0) {
      this.remove(wait.id);
      return null;
    }

    db.prepare(`
      UPDATE DownloadQueue
      SET command_id = ?, claimed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND command_id IS NULL
    `).run(commandId, wait.id);

    const claimed = this.get(wait.id);
    if (!claimed?.command_id) {
      return { wait: { ...wait, command_id: commandId }, commandId };
    }
    return { wait: claimed, commandId: claimed.command_id };
  }

  static reorder(
    waitIds: number[],
    options: {
      beforeJobId?: number;
      afterJobId?: number;
      position?: "top" | "bottom";
    },
  ): number {
    const normalizedJobIds = waitIds.filter((id) => Number.isInteger(id) && id > 0);
    if (normalizedJobIds.length === 0) {
      throw new Error("Queue reorder requires one or more valid pending queue item ids.");
    }

    const distinctJobIds = Array.from(new Set(normalizedJobIds));
    if (distinctJobIds.length !== normalizedJobIds.length) {
      throw new Error("Queue reorder set contains duplicate queue item ids.");
    }

    const { beforeJobId, afterJobId, position } = options;
    const targetCount = Number(beforeJobId != null) + Number(afterJobId != null) + Number(position != null);
    if (targetCount !== 1 || (position != null && position !== "top" && position !== "bottom")) {
      throw new Error("Queue reorder requires exactly one target: beforeJobId, afterJobId, or position.");
    }

    const movingSet = new Set(distinctJobIds);
    const anchorJobId = beforeJobId ?? afterJobId;
    if (anchorJobId == null || movingSet.has(anchorJobId)) {
      if (position == null) {
        throw new Error("Queue reorder anchor must be a different pending queue item.");
      }
    }

    const movingClause = distinctJobIds.map(() => "?").join(",");
    const baseRemainingWhere = `
      command_id IS NULL
      AND queue_order IS NOT NULL
      AND id NOT IN (${movingClause})
    `;

    const selectPrevious = db.prepare(`
      SELECT id, queue_order
      FROM DownloadQueue
      WHERE ${baseRemainingWhere}
        AND queue_order < ?
      ORDER BY queue_order DESC, id DESC
      LIMIT 1
    `);
    const selectNext = db.prepare(`
      SELECT id, queue_order
      FROM DownloadQueue
      WHERE ${baseRemainingWhere}
        AND queue_order > ?
      ORDER BY queue_order ASC, id ASC
      LIMIT 1
    `);
    const selectFirst = db.prepare(`
      SELECT id, queue_order
      FROM DownloadQueue
      WHERE ${baseRemainingWhere}
      ORDER BY queue_order ASC, id ASC
      LIMIT 1
    `);
    const selectLast = db.prepare(`
      SELECT id, queue_order
      FROM DownloadQueue
      WHERE ${baseRemainingWhere}
      ORDER BY queue_order DESC, id DESC
      LIMIT 1
    `);

    const changed = db.transaction(() => {
      db.prepare(`
        UPDATE DownloadQueue
        SET queue_order = queue_order
        WHERE id IN (${movingClause}) AND command_id IS NULL
      `).run(...distinctJobIds);

      const movingRows = db.prepare(`
        SELECT id, queue_order
        FROM DownloadQueue
        WHERE id IN (${movingClause}) AND command_id IS NULL
      `).all(...distinctJobIds) as QueueRankRow[];
      const movingById = new Map(movingRows.map((row) => [row.id, row]));
      const movingInRequestedOrder = distinctJobIds
        .map((id) => movingById.get(id))
        .filter((row): row is QueueRankRow => row != null);
      if (movingInRequestedOrder.length !== distinctJobIds.length) {
        throw new Error("Only waiting download queue items can be reordered.");
      }

      let previousRow: QueueRankRow | undefined;
      let nextRow: QueueRankRow | undefined;
      if (position === "top") {
        nextRow = selectFirst.get(...distinctJobIds) as QueueRankRow | undefined;
      } else if (position === "bottom") {
        previousRow = selectLast.get(...distinctJobIds) as QueueRankRow | undefined;
      } else {
        const anchor = db.prepare(`
          SELECT id, queue_order
          FROM DownloadQueue
          WHERE id = ? AND command_id IS NULL AND queue_order IS NOT NULL
        `).get(anchorJobId) as QueueRankRow | undefined;
        if (!anchor) {
          // Active downloads sit above the wait list. Anchoring on one of
          // them means "before the first waiting item" (Tidarr insert-front).
          const claimedAnchor = db.prepare(`
            SELECT id FROM DownloadQueue WHERE id = ? AND command_id IS NOT NULL
          `).get(anchorJobId) as { id?: number } | undefined;
          if (!claimedAnchor || beforeJobId == null) {
            throw new Error("Queue reorder anchor is not in the pending download queue.");
          }
          nextRow = selectFirst.get(...distinctJobIds) as QueueRankRow | undefined;
        } else if (beforeJobId != null) {
          nextRow = anchor;
          previousRow = selectPrevious.get(...distinctJobIds, anchor.queue_order) as QueueRankRow | undefined;
        } else {
          previousRow = anchor;
          nextRow = selectNext.get(...distinctJobIds, anchor.queue_order) as QueueRankRow | undefined;
        }
      }

      let ranks = allocateFractionalQueueRanks(
        previousRow?.queue_order ?? null,
        nextRow?.queue_order ?? null,
        movingInRequestedOrder.length,
      );
      let rowsToRank: QueueRankRow[] = movingInRequestedOrder;

      if (!ranks) {
        const previousWindow = previousRow
          ? db.prepare(`
              SELECT id, queue_order
              FROM DownloadQueue
              WHERE ${baseRemainingWhere} AND queue_order <= ?
              ORDER BY queue_order DESC, id DESC
              LIMIT ?
            `).all(...distinctJobIds, previousRow.queue_order, QUEUE_REBALANCE_WINDOW) as QueueRankRow[]
          : [];
        const nextWindow = nextRow
          ? db.prepare(`
              SELECT id, queue_order
              FROM DownloadQueue
              WHERE ${baseRemainingWhere} AND queue_order >= ?
              ORDER BY queue_order ASC, id ASC
              LIMIT ?
            `).all(...distinctJobIds, nextRow.queue_order, QUEUE_REBALANCE_WINDOW) as QueueRankRow[]
          : [];
        previousWindow.reverse();
        const localRows = [...previousWindow, ...nextWindow]
          .filter((row, index, rows) => rows.findIndex((candidate) => candidate.id === row.id) === index);
        const insertionIndex = previousRow
          ? localRows.findIndex((row) => row.id === previousRow?.id) + 1
          : 0;
        rowsToRank = [
          ...localRows.slice(0, insertionIndex),
          ...movingInRequestedOrder,
          ...localRows.slice(insertionIndex),
        ];
        const firstLocalRank = localRows[0]?.queue_order ?? null;
        const lastLocalRank = localRows.at(-1)?.queue_order ?? null;
        const outsidePrevious = firstLocalRank == null
          ? undefined
          : selectPrevious.get(...distinctJobIds, firstLocalRank) as QueueRankRow | undefined;
        const outsideNext = lastLocalRank == null
          ? undefined
          : selectNext.get(...distinctJobIds, lastLocalRank) as QueueRankRow | undefined;
        ranks = allocateFractionalQueueRanks(
          outsidePrevious?.queue_order ?? null,
          outsideNext?.queue_order ?? null,
          rowsToRank.length,
        );
        if (!ranks) {
          throw new Error("Queue rank space is exhausted around the requested position; retry after queue activity changes.");
        }
      }

      const minimumRankRow = db.prepare(`
        SELECT MIN(queue_order) AS minimumRank FROM DownloadQueue WHERE queue_order IS NOT NULL
      `).get() as { minimumRank?: number | null } | undefined;
      const minimumRank = minimumRankRow?.minimumRank ?? 0;
      const parkRank = db.prepare(`
        UPDATE DownloadQueue
        SET queue_order = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND command_id IS NULL
      `);
      rowsToRank.forEach((row, index) => {
        parkRank.run(minimumRank - (QUEUE_RANK_STEP * (index + 1)), row.id);
      });
      rowsToRank.forEach((row, index) => {
        parkRank.run(ranks?.[index], row.id);
      });
      return movingInRequestedOrder.length;
    })();

    notifyQueueChanged();
    return changed;
  }

  static recoverOrphanClaims(): number {
    const completedOrGone = db.prepare(`
      DELETE FROM DownloadQueue
      WHERE id IN (
        SELECT dq.id
        FROM DownloadQueue dq
        LEFT JOIN commands c ON c.id = dq.command_id
        WHERE dq.command_id IS NOT NULL
          AND (c.id IS NULL OR c.status IN ('completed', 'cancelled', 'failed'))
      )
    `).run();

    return completedOrGone.changes;
  }

  /**
   * A Download* command should only exist while a slot is running it. Pause
   * (and a crash between claim and start) can leave a queued command attached
   * to a wait row; that pair then ages /health forever. Return the wait row
   * to unclaimed and delete the unused command.
   */
  static releaseUnstartedClaims(): number {
    return db.transaction(() => {
      const rows = db.prepare(`
        SELECT dq.id AS wait_id, c.id AS command_id
        FROM DownloadQueue dq
        JOIN commands c ON c.id = dq.command_id
        WHERE c.status = 'queued'
      `).all() as Array<{ wait_id: number; command_id: number }>;
      for (const row of rows) {
        db.prepare(`
          UPDATE DownloadQueue
          SET command_id = NULL, claimed_at = NULL, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(row.wait_id);
        db.prepare(`
          DELETE FROM commands WHERE id = ? AND status = 'queued'
        `).run(row.command_id);
      }
      return rows.length;
    })();
  }

  private static nextAppendRank(): number {
    const row = db.prepare(`
      SELECT MAX(queue_order) AS queue_order FROM DownloadQueue
    `).get() as { queue_order?: number | null } | undefined;
    return (row?.queue_order ?? 0) + QUEUE_RANK_STEP;
  }

  private static nextFrontRank(): number {
    const row = db.prepare(`
      SELECT MIN(queue_order) AS queue_order
      FROM DownloadQueue
      WHERE command_id IS NULL
    `).get() as { queue_order?: number | null } | undefined;
    if (row?.queue_order == null) {
      return this.nextAppendRank();
    }
    return row.queue_order - QUEUE_RANK_STEP;
  }
}
