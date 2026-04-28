import { Router } from "express";
import { MetadataIdentityService, type MetadataIdentityEntityType } from "../services/metadata-identity-service.js";
import { AudioTagService } from "../services/audio-tag-service.js";
import { libraryMetadataBackfillService } from "../services/library-metadata-backfill.js";

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

async function resolveEntity(entityType: MetadataIdentityEntityType, entityId: string, force: boolean) {
  if (entityType === "artist") {
    return MetadataIdentityService.resolveArtist(entityId, { force });
  }
  if (entityType === "album") {
    return MetadataIdentityService.resolveAlbum(entityId, { force, includeTracks: true });
  }
  if (entityType === "track") {
    return MetadataIdentityService.resolveTrack(entityId, { force });
  }

  return MetadataIdentityService.markVideoKnown(entityId);
}

router.get("/status", (req, res) => {
  try {
    const entityType = parseEntityType(req.query.entityType);
    const entityId = parseEntityId(req.query.entityId);
    res.json(MetadataIdentityService.getStatus(entityType, entityId));
  } catch (error: any) {
    res.status(400).json({ detail: error.message });
  }
});

router.post("/resolve", async (req, res) => {
  try {
    const entityType = parseEntityType(req.body?.entityType);
    const entityId = parseEntityId(req.body?.entityId);
    const force = Boolean(req.body?.force);
    res.json(await resolveEntity(entityType, entityId, force));
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

	    if ((kind === "nfo" || kind === "all") && scope !== "artist") {
	      return res.status(400).json({
	        detail: "NFO regeneration is currently supported for artist scope only; album and video NFOs are regenerated through artist metadata backfill.",
	      });
	    }

	    if ((kind === "tags" || kind === "all") && scope === "video") {
	      return res.status(400).json({ detail: "Audio tag regeneration is only supported for artist, album, or track scope" });
	    }

	    const result: Record<string, unknown> = {};
    if ((kind === "tags" || kind === "all") && (scope === "artist" || scope === "album" || scope === "track")) {
      if (scope === "artist") {
        result.tags = await AudioTagService.applyByQuery({ artistId: entityId });
      } else if (scope === "album") {
        result.tags = await AudioTagService.applyByQuery({ albumId: entityId });
      } else {
        result.tags = await AudioTagService.applyForMediaIds([entityId]);
      }
    }

    if ((kind === "nfo" || kind === "all") && scope === "artist") {
      result.nfo = await libraryMetadataBackfillService.fillMissingMetadataFiles(entityId);
    }

    res.json({ success: true, ...result });
  } catch (error: any) {
    res.status(400).json({ detail: error.message });
  }
});

export default router;
