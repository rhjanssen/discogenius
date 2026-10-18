import { db } from "../../database.js";
import { CommandNames } from "../commands/command-names.js";
import { CommandTrigger } from "../commands/command-trigger.js";
import { DownloadWaitQueue } from "./download-wait-queue.js";
import { buildStreamingMediaUrl } from "./download-routing.js";
import { isHistoricalAuthFailure } from "../providers/provider-auth-error.js";

const DEFAULT_DAYS = 14;
const MAX_DAYS = 90;

export interface AuthFailedRetryResult {
  days: number;
  requeued: number;
  jobIds: number[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function optionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Requeue albums that already failed because a provider login died, oldest first.
 * Tracks and videos are left alone. One queue notification for the whole batch.
 */
export function retryAuthFailedAlbums(days = DEFAULT_DAYS): AuthFailedRetryResult {
  const window = Math.min(MAX_DAYS, Math.max(1, Math.floor(Number(days)) || DEFAULT_DAYS));
  const since = new Date(Date.now() - window * 86_400_000).toISOString();
  const rows = db.prepare(`
    SELECT id, ref_id, payload, priority, trigger, error
    FROM commands
    WHERE status = 'failed'
      AND name = ?
      AND completed_at >= ?
    ORDER BY completed_at ASC, id ASC
  `).all(CommandNames.DownloadAlbum, since) as Array<{
    id: number;
    ref_id: string | null;
    payload: string;
    priority: number;
    trigger: number;
    error: string | null;
  }>;

  const jobIds: number[] = [];
  for (const row of rows) {
    if (!isHistoricalAuthFailure(row.error)) continue;
    let parsed: Record<string, unknown> = {};
    try {
      parsed = asRecord(JSON.parse(row.payload));
    } catch {
      parsed = {};
    }
    const providerId = optionalString(parsed.providerId) ?? optionalString(row.ref_id);
    if (!providerId) continue;
    const rest = { ...parsed };
    delete rest.downloadState;
    const payload = {
      ...rest,
      providerId,
      type: "album",
      url: optionalString(parsed.url) ?? buildStreamingMediaUrl("album", providerId),
    };
    const queued = DownloadWaitQueue.enqueue({
      refKey: providerId,
      mediaKind: "album",
      commandName: CommandNames.DownloadAlbum,
      provider: optionalString(parsed.provider),
      providerId,
      artistId: optionalString(parsed.artist_id) ?? optionalString(parsed.artistId),
      albumId: optionalString(parsed.album_id) ?? optionalString(parsed.albumId),
      title: optionalString(parsed.title),
      artist: optionalString(parsed.artist),
      cover: optionalString(parsed.cover),
      quality: optionalString(parsed.quality),
      slot: optionalString(parsed.slot),
      payload,
      priority: row.priority,
      trigger: row.trigger ?? CommandTrigger.Unspecified,
      position: "back",
      notify: false,
    });
    if (queued.created) jobIds.push(queued.id);
  }
  if (jobIds.length > 0) DownloadWaitQueue.notifyChanged();
  return { days: window, requeued: jobIds.length, jobIds };
}
