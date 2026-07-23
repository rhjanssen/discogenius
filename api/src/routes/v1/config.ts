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

const { Client: PgClient } = pg;
import type { PublicAppConfigContract } from "../../contracts/config.js";
import { previewNamingConfig, validateNamingConfig } from "../../services/config/naming.js";
import { queueCurationPass } from "../../services/commands/scheduler.js";

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

router.post("/account", (req, res) => {
  try {
    const updates = parseAccountConfigUpdate(getObjectBody(req.body), Config.getAccountConfig());
    updateConfig("account", updates);
    res.json({ success: true });
  } catch (error: any) {
    if (isRequestValidationError(error)) {
      return res.status(400).json({ detail: error.message });
    }
    res.status(500).json({ detail: error.message });
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

router.post("/app", (req, res) => {
  try {
    const updates = parsePublicAppConfigUpdate(getObjectBody(req.body), {
      acoustid_api_key: getConfigSection("app").acoustid_api_key,
    });
    updateConfig("app", updates);
    res.json({ success: true });
  } catch (error: any) {
    if (isRequestValidationError(error)) {
      return res.status(400).json({ detail: error.message });
    }
    res.status(500).json({ detail: error.message });
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
    updateConfig("quality", updates);
    await syncDownloadBackends();

    // Trigger upgrade check asynchronously if enabled
    const finalConfig = getConfigSection("quality");
    if (finalConfig.upgrade_existing_files) {
      UpgraderService.checkUpgrades().catch(err => {
        console.error("❌ [UPGRADER] Error checking upgrades:", err);
      });
    }

    res.json({ success: true });
  } catch (error: any) {
    if (isRequestValidationError(error)) {
      return res.status(400).json({ detail: error.message });
    }
    res.status(500).json({ detail: error.message });
  }
});

router.get("/catalog", (_, res) => {
  try {
    res.json(getConfigSection("catalog"));
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

router.post("/catalog", (req, res) => {
  try {
    const updates = parseCatalogConfigUpdate(getObjectBody(req.body), getConfigSection("catalog"));
    updateConfig("catalog", updates);
    // Re-resolve the active catalog source so the change takes effect immediately.
    catalogProviderRegistry.refreshFromConfig();
    res.json({ success: true, activeSource: catalogProviderRegistry.getActiveId() });
  } catch (error: any) {
    if (isRequestValidationError(error)) {
      return res.status(400).json({ detail: error.message });
    }
    res.status(500).json({ detail: error.message });
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

const updateFilteringConfig = (req: any, res: any) => {
  try {
    const updates = parseFilteringConfigUpdate(getObjectBody(req.body), getConfigSection("filtering"));
    updateConfig("filtering", updates);
    const commandId = queueCurationPass({ trigger: CommandTrigger.Manual });
    res.json({ success: true, commandId });
  } catch (error: any) {
    if (isRequestValidationError(error)) {
      return res.status(400).json({ detail: error.message });
    }
    res.status(500).json({ detail: error.message });
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
    updateConfig("metadata", updates);
    await syncDownloadBackends();

    if (updates.artwork_preference && updates.artwork_preference !== previousPreference) {
      import("../../services/metadata/media-cover-service.js").then(({ refreshAllMediaCoversOnPreferenceChange }) => {
        refreshAllMediaCoversOnPreferenceChange();
      });
    }

    // Queue a config prune job to clean up orphaned metadata sidecars
    import("../../services/commands/command-queue-manager.js").then(({ CommandNames, CommandQueueManager }) => {
      CommandQueueManager.push(CommandNames.ConfigPrune, {}, 'system', 0, 1);
    });

    res.json({ success: true });
  } catch (error: any) {
    if (isRequestValidationError(error)) {
      return res.status(400).json({ detail: error.message });
    }
    res.status(500).json({ detail: error.message });
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

router.post("/naming", (req, res) => {
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
    updateConfig("naming", updates);
    res.json({ success: true });
  } catch (error: any) {
    if (isRequestValidationError(error)) {
      return res.status(400).json({ detail: error.message });
    }
    res.status(500).json({ detail: error.message });
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

router.post("/path", (req, res) => {
  try {
    const updates = parsePathConfigUpdate(getObjectBody(req.body), getConfigSection("path"));
    updateConfig("path", updates);
    res.json({ success: true });
  } catch (error: any) {
    if (isRequestValidationError(error)) {
      return res.status(400).json({ detail: error.message });
    }
    res.status(500).json({ detail: error.message });
  }
});

export default router;
