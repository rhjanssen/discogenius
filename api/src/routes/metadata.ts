import { Router } from "express";
import { runWithAsyncBusyRetry } from "../database.js";
import { CommandNames } from "../services/commands/command-names.js";
import { CommandQueueManager } from "../services/commands/command-queue-manager.js";
import { CommandTrigger } from "../services/commands/command-trigger.js";
import { MetadataIdentityService, type MetadataIdentityEntityType } from "../services/metadata/metadata-identity-service.js";

const router = Router();

function parseEntityType(value: unknown): MetadataIdentityEntityType {
  const type = String(value || "").trim();
  if (type === "artist" || type === "album" || type === "track" || type === "video") {
    return type;
  }
  throw new Error("entityType must be artist, album, track, or video");
}

function parseEntityId(value: unknown): string {
  const id = String(value || "").trim();
  if (!id) throw new Error("entityId is required");
  return id;
}

function parseOptionalProvider(value: unknown): string | undefined {
  const provider = String(value || "").trim();
  return provider || undefined;
}

async function resolveEntity(
  entityType: MetadataIdentityEntityType,
  entityId: string,
  force: boolean,
  provider?: string,
) {
  if (entityType === "artist") {
    return MetadataIdentityService.resolveArtist(entityId, { force });
  }
  if (entityType === "album") {
    return MetadataIdentityService.resolveAlbum(entityId, { force, provider });
  }
  if (entityType === "track") {
    return MetadataIdentityService.resolveTrack(entityId, { force, provider });
  }

  return MetadataIdentityService.markVideoKnown(entityId, { provider });
}

router.get("/status", (req, res) => {
  try {
    const entityType = parseEntityType(req.query.entityType);
    const entityId = parseEntityId(req.query.entityId);
    const provider = parseOptionalProvider(req.query.provider);
    res.json(MetadataIdentityService.getStatus(entityType, entityId, { provider }));
  } catch (error: any) {
    res.status(400).json({ detail: error.message });
  }
});

router.post("/resolve", async (req, res) => {
  try {
    const entityType = parseEntityType(req.body?.entityType);
    const entityId = parseEntityId(req.body?.entityId);
    const force = Boolean(req.body?.force);
    const provider = parseOptionalProvider(req.body?.provider);
    res.json(await resolveEntity(entityType, entityId, force, provider));
  } catch (error: any) {
    res.status(400).json({ detail: error.message });
  }
});

router.post("/regenerate", async (req, res) => {
  try {
    const scope = String(req.body?.scope || "").trim();
    const entityId = parseEntityId(req.body?.entityId);
    const kind = String(req.body?.kind || "all").trim();

    if (!["tags", "nfo", "all"].includes(kind)) {
      return res.status(400).json({ detail: "kind must be tags, nfo, or all" });
    }

    if (!["artist", "album", "track", "video"].includes(scope)) {
      return res.status(400).json({ detail: "scope must be artist, album, track, or video" });
    }

    if ((kind === "nfo" || kind === "all") && scope !== "artist") {
      return res.status(400).json({
        detail: "NFO regeneration is currently supported for artist scope only; album and video NFOs are regenerated through artist metadata backfill.",
      });
    }

    if ((kind === "tags" || kind === "all") && scope === "video") {
      return res.status(400).json({ detail: "Audio tag regeneration is only supported for artist, album, or track scope" });
    }

    const commandIds = await runWithAsyncBusyRetry(() => {
      const queuedCommandIds: number[] = [];
      if ((kind === "tags" || kind === "all") && scope === "artist") {
        const commandId = CommandQueueManager.push(
          CommandNames.RetagArtist,
          {
            artistId: entityId,
            artistIds: [entityId],
            description: `Regenerate audio tags for artist ${entityId}`,
          },
          entityId,
          1,
          CommandTrigger.Manual,
        );
        queuedCommandIds.push(commandId);
      } else if ((kind === "tags" || kind === "all") && scope === "album") {
        const commandId = CommandQueueManager.push(
          CommandNames.RetagFiles,
          {
            albumId: entityId,
            applyAll: true,
            description: `Regenerate audio tags for album ${entityId}`,
          },
          `retag-files:${JSON.stringify({ albumId: entityId })}`,
          1,
          CommandTrigger.Manual,
        );
        queuedCommandIds.push(commandId);
      } else if ((kind === "tags" || kind === "all") && scope === "track") {
        const commandId = CommandQueueManager.push(
          CommandNames.RetagFiles,
          {
            mediaIds: [entityId],
            applyAll: false,
            description: `Regenerate audio tags for media file ${entityId}`,
          },
          `retag-files:${JSON.stringify({ mediaIds: [entityId] })}`,
          1,
          CommandTrigger.Manual,
        );
        queuedCommandIds.push(commandId);
      }

      if ((kind === "nfo" || kind === "all") && scope === "artist") {
        const commandId = CommandQueueManager.push(
          CommandNames.RescanFolders,
          {
            artistId: entityId,
            skipCuration: true,
            skipDownloadQueue: true,
            trackUnmappedFiles: false,
            description: `Regenerate metadata sidecars for artist ${entityId}`,
          },
          entityId,
          1,
          CommandTrigger.Manual,
        );
        queuedCommandIds.push(commandId);
      }

      return queuedCommandIds;
    }, 30, 200);

    res.status(202).json({
      success: true,
      queued: commandIds.some((id) => id !== -1),
      commandIds,
      message: "Metadata regeneration queued",
    });
  } catch (error: any) {
    res.status(400).json({ detail: error.message });
  }
});

export default router;
