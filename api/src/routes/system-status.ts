import { Router } from "express";
import { collectHealthDiagnosticsSnapshot } from "../services/commands/health.js";
import { ProviderArtistIdentityService } from "../services/metadata/provider-artist-identity-service.js";
import {
  applyManualArtistMatch,
  ignoreProviderArtist,
  listManualMatchCandidates,
} from "../services/metadata/provider-artist-manual-match.js";

const router = Router();

router.get("/", (_req, res) => {
  try {
    // Compose the import diagnostics here rather than inside
    // collectHealthDiagnosticsSnapshot: the same snapshot backs the container's
    // /health probe, which should stay a pure liveness check without catalog
    // queries.
    res.json({
      ...collectHealthDiagnosticsSnapshot(),
      imports: {
        unmatchedArtists: ProviderArtistIdentityService.listUnmatched(),
      },
    });
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

// Manual remediation for unmatched provider-import artists (the rows the GET
// above lists): ranked MusicBrainz candidates with evidence, apply a match, or
// hide an entry that has nothing to match.
router.get("/unmatched-artists/:provider/:providerId/candidates", async (req, res) => {
  try {
    res.json(await listManualMatchCandidates(String(req.params.provider), String(req.params.providerId)));
  } catch (error: any) {
    res.status(error?.message?.startsWith("Unknown provider artist") ? 404 : 500).json({ detail: error.message });
  }
});

router.post("/unmatched-artists/:provider/:providerId/match", async (req, res) => {
  try {
    const mbid = String((req.body as Record<string, unknown> | undefined)?.mbid || "").trim();
    if (!mbid) {
      return res.status(400).json({ detail: "mbid is required" });
    }
    res.json(await applyManualArtistMatch(String(req.params.provider), String(req.params.providerId), mbid));
  } catch (error: any) {
    const message = String(error?.message || "Failed to apply match");
    const status = message.startsWith("Unknown provider artist") ? 404
      : message.startsWith("Not a valid MusicBrainz") ? 400
        : 500;
    res.status(status).json({ detail: message });
  }
});

router.post("/unmatched-artists/:provider/:providerId/ignore", (req, res) => {
  try {
    res.json(ignoreProviderArtist(String(req.params.provider), String(req.params.providerId)));
  } catch (error: any) {
    res.status(error?.message?.startsWith("Unknown or already matched") ? 404 : 500).json({ detail: error.message });
  }
});

// Backup & Restore endpoints (matching Lidarr system backup/restore semantics)
router.get("/backups", (_req, res) => {
  try {
    const fsModule = require("fs");
    const pathModule = require("path");
    const { CONFIG_DIR } = require("../services/config/config.js");
    const backupsDir = pathModule.join(CONFIG_DIR, "Backups");
    if (!fsModule.existsSync(backupsDir)) {
      return res.json([]);
    }
    const files = fsModule.readdirSync(backupsDir)
      .filter((f: string) => f.startsWith("discogenius_backup_") && f.endsWith(".db"))
      .map((f: string) => {
        const filePath = pathModule.join(backupsDir, f);
        const stat = fsModule.statSync(filePath);
        return {
          name: f,
          size: stat.size,
          time: stat.mtime.toISOString(),
        };
      })
      .sort((a: any, b: any) => new Date(b.time).getTime() - new Date(a.time).getTime());

    res.json(files);
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

router.post("/backups", async (_req, res) => {
  try {
    const pathModule = require("path");
    const { executeDatabaseBackup } = require("../services/commands/runtime-maintenance.js");
    const result = await executeDatabaseBackup();
    res.json({
      success: true,
      fileName: pathModule.basename(result.backupPath),
      backupPath: result.backupPath,
      prunedCount: result.prunedCount,
    });
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

router.get("/backups/:fileName/download", (req, res) => {
  try {
    const fsModule = require("fs");
    const pathModule = require("path");
    const { CONFIG_DIR } = require("../services/config/config.js");
    const fileName = pathModule.basename(String(req.params.fileName));
    const filePath = pathModule.join(CONFIG_DIR, "Backups", fileName);
    if (!fsModule.existsSync(filePath)) {
      return res.status(404).json({ detail: "Backup file not found" });
    }
    res.download(filePath, fileName);
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

router.delete("/backups/:fileName", (req, res) => {
  try {
    const fsModule = require("fs");
    const pathModule = require("path");
    const { CONFIG_DIR } = require("../services/config/config.js");
    const fileName = pathModule.basename(String(req.params.fileName));
    const filePath = pathModule.join(CONFIG_DIR, "Backups", fileName);
    if (!fsModule.existsSync(filePath)) {
      return res.status(404).json({ detail: "Backup file not found" });
    }
    fsModule.rmSync(filePath, { force: true });
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

export default router;
