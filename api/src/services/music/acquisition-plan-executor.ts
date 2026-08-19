import type Database from "better-sqlite3";
import { CommandNames } from "../commands/command-names.js";
import { CommandTrigger } from "../commands/command-trigger.js";
import { DownloadWaitQueue } from "../download/download-wait-queue.js";
import {
  buildAcquisitionDownloadCommand,
} from "./acquisition-download-command.js";

export {
  buildAcquisitionDownloadCommand,
  type AcquisitionDownloadCommand,
} from "./acquisition-download-command.js";

export function queueAcquisitionPlan(
  db: Database.Database,
  planId: number,
  options: {
    canQueue?: () => boolean;
    onQueued?: (queueItemId: number) => void;
    trackIds?: readonly number[];
    position?: "front" | "back";
    notify?: boolean;
  } = {},
): { queued: boolean; commandId: number | null } {
  const command = buildAcquisitionDownloadCommand(db, planId, { trackIds: options.trackIds });
  if (!command || options.canQueue?.() === false) {
    return { queued: false, commandId: null };
  }

  const queued = DownloadWaitQueue.enqueue({
    refKey: command.refId,
    mediaKind: "album",
    commandName: CommandNames.DownloadAlbum,
    planId,
    trackIds: options.trackIds,
    provider: command.body.provider ?? null,
    providerId: command.body.providerId ?? null,
    albumId: command.body.releaseGroupMbid ?? command.body.albumId ?? null,
    title: command.body.title ?? null,
    artist: command.body.artist ?? null,
    cover: command.body.cover ?? null,
    quality: command.body.quality ?? null,
    slot: command.body.slot ?? null,
    payload: {
      ...command.body,
    },
    priority: 0,
    trigger: CommandTrigger.Manual,
    position: options.position ?? "front",
    notify: options.notify,
  });

  if (queued.created) {
    options.onQueued?.(queued.id);
  }
  return { queued: true, commandId: queued.id };
}
