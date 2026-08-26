import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import { collectHealthDiagnosticsSnapshot } from "../services/commands/health.js";
import { executeDatabaseBackup } from "../services/commands/runtime-maintenance.js";
import { CONFIG_DIR } from "../services/config/config.js";
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

const backupFilePattern = /^discogenius_backup_[A-Za-z0-9._-]+\.db$/;

function resolveBackupFile(fileNameValue: unknown): { fileName: string; filePath: string } | null {
  const fileName = path.basename(String(fileNameValue));
  if (!backupFilePattern.test(fileName)) {
    return null;
  }
  return { fileName, filePath: path.join(CONFIG_DIR, "Backups", fileName) };
}

// Backup endpoints (matching Lidarr's list/create/download/delete workflow).
router.get("/backups", (_req, res) => {
  try {
    const backupsDir = path.join(CONFIG_DIR, "Backups");
    if (!fs.existsSync(backupsDir)) {
      return res.json([]);
    }
    const files = fs.readdirSync(backupsDir)
      .filter((fileName) => backupFilePattern.test(fileName))
      .map((fileName) => {
        const filePath = path.join(backupsDir, fileName);
        const stat = fs.statSync(filePath);
        return {
          name: fileName,
          size: stat.size,
          time: stat.mtime.toISOString(),
        };
      })
      .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());

    res.json(files);
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

router.post("/backups", async (_req, res) => {
  try {
    const result = await executeDatabaseBackup();
    res.json({
      success: true,
      fileName: path.basename(result.backupPath),
      backupPath: result.backupPath,
      prunedCount: result.prunedCount,
    });
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

router.get("/backups/:fileName/download", (req, res) => {
  try {
    const backupFile = resolveBackupFile(req.params.fileName);
    if (!backupFile || !fs.existsSync(backupFile.filePath)) {
      return res.status(404).json({ detail: "Backup file not found" });
    }
    res.download(backupFile.filePath, backupFile.fileName);
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

router.delete("/backups/:fileName", (req, res) => {
  try {
    const backupFile = resolveBackupFile(req.params.fileName);
    if (!backupFile || !fs.existsSync(backupFile.filePath)) {
      return res.status(404).json({ detail: "Backup file not found" });
    }
    fs.rmSync(backupFile.filePath, { force: true });
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

export default router;
