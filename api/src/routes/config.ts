import { Router } from "express";
import { getConfigSection, updateConfig, readConfig, writeConfig, CONFIG_FILE, Config } from "../services/config.js";
import { syncDiscogeniusSettings } from "../services/tidal-dl-ng.js";
import { syncOrpheusSettings } from "../services/orpheus.js";
import { UpgraderService } from "../services/upgrader.js";
import { getAppReleaseInfo } from "../services/app-release.js";
import {
  RequestValidationError,
  getObjectBody,
  getRequiredString,
  isRequestValidationError,
} from "../utils/request-validation.js";
import * as TOML from "@iarna/toml";
import fs from "fs";
import type { PublicAppConfigContract } from "../contracts/config.js";

const router = Router();

async function syncDownloadBackends(): Promise<void> {
  await syncDiscogeniusSettings();
  await syncOrpheusSettings();
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
    updateConfig("account", getObjectBody(req.body));
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
    const body = getObjectBody(req.body);
    const updates: Partial<PublicAppConfigContract> = {};

    if ("acoustid_api_key" in body) {
      const rawValue = body.acoustid_api_key;
      if (rawValue !== undefined && rawValue !== null && typeof rawValue !== "string") {
        throw new RequestValidationError("acoustid_api_key must be a string");
      }

      updates.acoustid_api_key = typeof rawValue === "string" ? rawValue.trim() || undefined : undefined;
    }

    updateConfig("app", updates);
    res.json({ success: true });
  } catch (error: any) {
    if (isRequestValidationError(error)) {
      return res.status(400).json({ detail: error.message });
    }
    res.status(500).json({ detail: error.message });
  }
});

router.get("/about", (_, res) => {
  try {
    res.json(getAppReleaseInfo());
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

router.get("/monitoring", (_, res) => {
  try {
    const config = getConfigSection("monitoring");
    res.json(config);
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

router.post("/monitoring", (req, res) => {
  try {
    updateConfig("monitoring", getObjectBody(req.body));
    res.json({ success: true });
  } catch (error: any) {
    if (isRequestValidationError(error)) {
      return res.status(400).json({ detail: error.message });
    }
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
    updateConfig("quality", getObjectBody(req.body));
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
    updateConfig("filtering", getObjectBody(req.body));
    res.json({ success: true });
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
    updateConfig("metadata", getObjectBody(req.body));
    await syncDownloadBackends();

    // Queue a config prune job to clean up orphaned metadata sidecars
    import("../services/queue.js").then(({ JobTypes, TaskQueueService }) => {
      TaskQueueService.addJob(JobTypes.ConfigPrune, {}, 'system', 0, 1);
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

router.post("/naming", (req, res) => {
  try {
    updateConfig("naming", getObjectBody(req.body));
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
    updateConfig("path", getObjectBody(req.body));
    res.json({ success: true });
  } catch (error: any) {
    if (isRequestValidationError(error)) {
      return res.status(400).json({ detail: error.message });
    }
    res.status(500).json({ detail: error.message });
  }
});

// Get raw TOML file content for advanced editing
router.get("/toml", (_, res) => {
  try {
    const tomlContent = fs.readFileSync(CONFIG_FILE, "utf-8");
    res.json({ toml: tomlContent });
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

// Save raw TOML file content
router.post("/toml", async (req, res) => {
  try {
    const body = getObjectBody(req.body);
    const toml = getRequiredString(body, "toml");

    // Validate TOML syntax before saving
    try {
      TOML.parse(toml);
    } catch (parseError: any) {
      res.status(400).json({ detail: `Invalid TOML syntax: ${parseError.message}` });
      return;
    }

    fs.writeFileSync(CONFIG_FILE, toml, "utf-8");
    await syncDownloadBackends();
    res.json({ success: true, message: "Config saved successfully" });
  } catch (error: any) {
    if (isRequestValidationError(error)) {
      return res.status(400).json({ detail: error.message });
    }
    res.status(500).json({ detail: error.message });
  }
});

export default router;
