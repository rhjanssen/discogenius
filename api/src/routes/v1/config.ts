import { CommandTrigger } from "../../services/commands/command-trigger.js";
import { Router } from "express";
import { clearConfigCache, getConfigSection, updateConfig, Config } from "../../services/config/config.js";
import { streamingProviderManager } from "../../services/providers/index.js";
import { UpgraderService } from "../../services/mediafiles/upgrader.js";
import { getAppReleaseInfo } from "../../services/config/app-release.js";
import {
  parseAccountConfigUpdate,
  parseCatalogConfigUpdate,
  parseFilteringConfigUpdate,
  parseMetadataConfigUpdate,
  parseNamingConfigUpdate,
  parsePathConfigUpdate,
  parsePublicAppConfigUpdate,
  parseQualityConfigUpdate,
} from "../../contracts/config-updates.js";
import { catalogProviderRegistry } from "../../services/catalog/index.js";
import { buildMbPostgresDsn, buildMbSearchWebUrl, normalizeMbHost } from "../../services/catalog/mb-connection.js";
import {
  getObjectBody,
  getRequiredString,
  isRequestValidationError,
} from "../../utils/request-validation.js";
import * as TOML from "@iarna/toml";
import pg from "pg";
import fs from "fs";
import { db, isSqliteBusyError, runWithAsyncBusyRetry } from "../../database.js";
import { applyLibrarySettingsFromConfig } from "../../services/music/library-settings-sync.js";

const { Client: PgClient } = pg;
import type { PublicAppConfigContract } from "../../contracts/config.js";
import { previewNamingConfig, validateNamingConfig } from "../../services/config/naming.js";

import {
  queueConfigPrune,
  queueCurationPass,
  queueMetadataRefreshPass,
} from "../../services/commands/scheduler.js";

/** Push Settings quality and media toggles onto the fixed libraries. */
function syncLibrariesFromSettings(): void {
  applyLibrarySettingsFromConfig(db, {
    audioQuality: getConfigSection("quality").audio_quality,
    includeSpatial: getConfigSection("filtering").include_spatial === true,
    includeVideos: getConfigSection("filtering").include_videos === true,
  });
}

/** Same yield-and-retry budget as queue/album writes: settings persist in SQLite. */
function runConfigUserWrite<T>(operation: () => T): Promise<T> {
  return runWithAsyncBusyRetry(operation, 30, 200);
}

function configMutationHttpStatus(error: unknown): number {
  if (isRequestValidationError(error)) return 400;
  if (isSqliteBusyError(error)) return 503;
  return 500;
}

const router = Router();

async function syncDownloadBackends(): Promise<void> {
  await streamingProviderManager.syncProviderSettings();
}

router.get("/account", (_, res) => {
  try {
    const config = Config.getAccountConfig();
    res.json(config);
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

router.post("/account", async (req, res) => {
  try {
    const updates = parseAccountConfigUpdate(getObjectBody(req.body), Config.getAccountConfig());
    await runConfigUserWrite(() => updateConfig("account", updates));
    res.json({ success: true });
  } catch (error: any) {
    res.status(configMutationHttpStatus(error)).json({ detail: error.message });
  }
});

router.get("/app", (_, res) => {
  try {
    const config = getConfigSection("app");
    const response: PublicAppConfigContract = {
      acoustid_api_key: config.acoustid_api_key,
    };
    res.json(response);
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

router.post("/app", async (req, res) => {
  try {
    const updates = parsePublicAppConfigUpdate(getObjectBody(req.body), {
      acoustid_api_key: getConfigSection("app").acoustid_api_key,
    });
    await runConfigUserWrite(() => updateConfig("app", updates));
    res.json({ success: true });
  } catch (error: any) {
    res.status(configMutationHttpStatus(error)).json({ detail: error.message });
  }
});

router.get("/about", async (_, res) => {
  try {
    res.json(await getAppReleaseInfo());
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

router.get("/quality", (_, res) => {
  try {
    const config = getConfigSection("quality");
    res.json(config);
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

router.post("/quality", async (req, res) => {
  try {
    const updates = parseQualityConfigUpdate(getObjectBody(req.body), getConfigSection("quality"));
    await runConfigUserWrite(() => {
      updateConfig("quality", updates);
      // Stereo library profile follows audio_quality (max/high/normal/low).
      syncLibrariesFromSettings();
    });
    await syncDownloadBackends();

    // Trigger upgrade check asynchronously if enabled
    const finalConfig = getConfigSection("quality");
    if (finalConfig.upgrade_existing_files || finalConfig.downconvert_existing_files) {
      UpgraderService.checkUpgrades().catch(err => {
        console.error("❌ [UPGRADER] Error checking upgrades:", err);
      });
    }

    res.json({ success: true });
  } catch (error: any) {
    res.status(configMutationHttpStatus(error)).json({ detail: error.message });
  }
});

router.get("/catalog", (_, res) => {
  try {
    res.json(getConfigSection("catalog"));
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

router.post("/catalog", async (req, res) => {
  try {
    const updates = parseCatalogConfigUpdate(getObjectBody(req.body), getConfigSection("catalog"));
    await runConfigUserWrite(() => updateConfig("catalog", updates));
    // Re-resolve the active catalog source so the change takes effect immediately.
    catalogProviderRegistry.refreshFromConfig();
    res.json({ success: true, activeSource: catalogProviderRegistry.getActiveId() });
  } catch (error: any) {
    res.status(configMutationHttpStatus(error)).json({ detail: error.message });
  }
});

/**
 * Probe the MusicBrainz-docker Postgres connection: connect and resolve a
 * universally-present MBID (The Beatles) so it validates both reachability and
 * that the catalog schema/data is loaded. Also reports whether a co-located
 * Solr web server (full-stack mirror) is reachable for search.
 */
router.post("/catalog/test", async (req, res) => {
  const body = getObjectBody(req.body);
  const requestedHost = typeof body.musicbrainz_host === "string" ? body.musicbrainz_host.trim() : "";
  const host = normalizeMbHost(requestedHost || getConfigSection("catalog").musicbrainz_host);
  const dsn = buildMbPostgresDsn(host);
  const searchWebUrl = buildMbSearchWebUrl(host);

  const client = new PgClient({ connectionString: dsn, statement_timeout: 8000, query_timeout: 8000 });
  try {
    await client.connect();
    const result = await client.query(
      "SELECT name FROM musicbrainz.artist WHERE gid = $1",
      ["b10bbbfc-cf9e-42e0-be17-e2c3e1d2600d"],
    );
    const name = result.rows[0]?.name as string | undefined;
    let searchNote = "";
    try {
      if (!searchWebUrl) {
        throw new Error("No MusicBrainz web URL");
      }
      const solr = await fetch(`${searchWebUrl}/artist?query=test&limit=1&fmt=json`, {
        signal: AbortSignal.timeout(4000),
      });
      searchNote = solr.ok ? " · Solr search available" : " · Postgres search (no Solr)";
    } catch {
      searchNote = " · Postgres search (no Solr)";
    }
    return res.json({
      ok: Boolean(name),
      message: name ? `Connected — resolved "${name}"${searchNote}` : "Connected, but catalog data not loaded",
    });
  } catch (error: any) {
    return res.json({ ok: false, message: error?.message || "Connection failed" });
  } finally {
    await client.end().catch(() => { /* ignore */ });
  }
});

const getFilteringConfig = (_: any, res: any) => {
  try {
    const config = getConfigSection("filtering");
    res.json(config);
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
};

const updateFilteringConfig = async (req: any, res: any) => {
  try {
    const updates = parseFilteringConfigUpdate(getObjectBody(req.body), getConfigSection("filtering"));
    const commandId = await runConfigUserWrite(() => {
      updateConfig("filtering", updates);
      // Spatial and Video library enabled flags follow their Settings toggles.
      syncLibrariesFromSettings();
      return queueCurationPass({ trigger: CommandTrigger.Manual });
    });
    res.json({ success: true, commandId });
  } catch (error: any) {
    res.status(configMutationHttpStatus(error)).json({ detail: error.message });
  }
};

// Preferred UI term: Curation.
router.get("/curation", getFilteringConfig);
router.post("/curation", updateFilteringConfig);

router.get("/metadata", (_, res) => {
  try {
    const config = getConfigSection("metadata");
    res.json(config);
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

router.post("/metadata", async (req, res) => {
  try {
    const previousPreference = getConfigSection("metadata")?.artwork_preference;
    const updates = parseMetadataConfigUpdate(getObjectBody(req.body), getConfigSection("metadata"));
    await runConfigUserWrite(() => updateConfig("metadata", updates));
    await syncDownloadBackends();

    const artworkPreferenceChanged = Boolean(
      updates.artwork_preference
      && updates.artwork_preference !== previousPreference,
    );
    let artworkRefreshCommandId: number | null = null;
    if (artworkPreferenceChanged) {
      // A preference flip can revisit hundreds of catalog entities and perform
      // provider I/O. Run the normal durable refresh/match workflow so canonical
      // artwork is considered first and provider-preferred artwork can replace it
      // during matching, instead of doing untracked network work in this route.
      artworkRefreshCommandId = await runConfigUserWrite(() => queueMetadataRefreshPass({
        trigger: CommandTrigger.Manual,
      }));
    }

    // RefreshMetadata fans out monitored artists at -1 and each subsequent
    // workflow phase gets a higher priority. Keep an artwork reconciliation
    // below both monitored (-1) and credited (-10) workflows so cache
    // acquisition finishes before sidecars and embedded covers are updated.
    await runConfigUserWrite(() => queueConfigPrune({
      trigger: CommandTrigger.Manual,
      priority: artworkPreferenceChanged ? -100 : 0,
      refId: artworkPreferenceChanged
        ? `artwork-preference-backfill:${artworkRefreshCommandId}`
        : "config-prune",
      refreshArtworkPreference: artworkPreferenceChanged,
    }));

    res.json({
      success: true,
      ...(artworkRefreshCommandId != null ? { artworkRefreshCommandId } : {}),
    });
  } catch (error: any) {
    res.status(configMutationHttpStatus(error)).json({ detail: error.message });
  }
});

router.get("/naming", (_, res) => {
  try {
    const config = getConfigSection("naming");
    res.json(config);
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

router.post("/naming/validate", (req, res) => {
  try {
    const current = getConfigSection("naming");
    const updates = parseNamingConfigUpdate(getObjectBody(req.body), current);
    const next = { ...current, ...updates };
    res.json(validateNamingConfig(next));
  } catch (error: any) {
    if (isRequestValidationError(error)) {
      return res.status(400).json({ detail: error.message });
    }
    res.status(500).json({ detail: error.message });
  }
});

router.post("/naming/preview", (req, res) => {
  try {
    const current = getConfigSection("naming");
    const updates = parseNamingConfigUpdate(getObjectBody(req.body), current);
    const next = { ...current, ...updates };
    const validation = validateNamingConfig(next);
    const valid = Object.values(validation).every((result) => result.valid);
    res.json({
      valid,
      validation,
      preview: valid ? previewNamingConfig(next) : null,
    });
  } catch (error: any) {
    if (isRequestValidationError(error)) {
      return res.status(400).json({ detail: error.message });
    }
    res.status(500).json({ detail: error.message });
  }
});

router.post("/naming", async (req, res) => {
  try {
    const updates = parseNamingConfigUpdate(getObjectBody(req.body), getConfigSection("naming"));
    const next = { ...getConfigSection("naming"), ...updates };
    const validation = validateNamingConfig(next);
    const invalid = Object.values(validation).filter((result) => !result.valid);
    if (invalid.length > 0) {
      return res.status(400).json({
        detail: invalid.flatMap((result) => result.errors).join(" "),
        validation,
      });
    }
    await runConfigUserWrite(() => updateConfig("naming", updates));
    res.json({ success: true });
  } catch (error: any) {
    res.status(configMutationHttpStatus(error)).json({ detail: error.message });
  }
});

router.get("/path", (_, res) => {
  try {
    const config = getConfigSection("path");
    res.json(config);
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

router.post("/path", async (req, res) => {
  try {
    const previousLayout = getConfigSection("path").video_folder_layout;
    const updates = parsePathConfigUpdate(getObjectBody(req.body), getConfigSection("path"));
    const commandId = await runConfigUserWrite(() => {
      updateConfig("path", updates);
      if (
        updates.video_folder_layout
        && updates.video_folder_layout !== previousLayout
      ) {
        return queueCurationPass({ trigger: CommandTrigger.Manual });
      }
      return null;
    });
    res.json(commandId ? { success: true, commandId } : { success: true });
  } catch (error: any) {
    res.status(configMutationHttpStatus(error)).json({ detail: error.message });
  }
});

export default router;
