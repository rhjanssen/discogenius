import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-provider-registry-"));
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");

test("registry resolves the active provider from config, not a hardcoded id", async () => {
  const { initDatabase } = await import("../../database.js");
  initDatabase();
  const { updateConfig } = await import("../config/config.js");
  const { streamingProviderManager } = await import("./index.js");

  updateConfig("streaming", { default_provider: "tidal" });
  assert.equal(streamingProviderManager.getDefaultProviderId(), "tidal");
  assert.equal(streamingProviderManager.getDefaultStreamingProvider().id, "tidal");

  updateConfig("streaming", { default_provider: "apple-music" });
  assert.equal(streamingProviderManager.getDefaultProviderId(), "apple-music");
  assert.equal(streamingProviderManager.getDefaultStreamingProvider().id, "apple-music");

  updateConfig("streaming", { default_provider: "does-not-exist" });
  assert.throws(() => streamingProviderManager.getDefaultProviderId(), /not registered/);

  // Empty/missing default falls back to the built-in tidal registration.
  updateConfig("streaming", { default_provider: "" });
  assert.equal(streamingProviderManager.getDefaultProviderId(), "tidal");
});

test("registry exposes every built-in provider", async () => {
  const { streamingProviderManager } = await import("./index.js");
  const providers = streamingProviderManager.getAllStreamingProviders();
  const ids = providers.map((p) => p.id);
  assert.deepEqual(ids, [
    "tidal",
    "apple-music",
    "amazon-music",
    "spotify",
    "youtube-music",
    "deezer",
  ]);

  for (const provider of providers) {
    assert.ok(provider.manifest, `${provider.id} should expose a provider manifest`);
    assert.equal(provider.manifest.id, provider.id);
    assert.equal(provider.manifest.displayName, provider.name);
    assert.match(provider.manifest.configRoot, /^providers\/[a-z0-9-]+$/);
    assert.ok(["official-api", "web-api", "unofficial-api", "none"].includes(provider.manifest.integration.catalogSource));
    assert.ok(["native-cli", "external-service", "none"].includes(provider.manifest.integration.downloadSource));
    assert.ok(provider.manifest.integration.stableResourceIds.includes("album"));
    assert.ok(provider.manifest.downloadBackends.length > 0);
    assert.ok(provider.manifest.diagnostics?.length);
    assert.equal(provider.manifest.catalog.search, provider.capabilities.catalogSearch);
    assert.equal(provider.manifest.catalog.artistCatalog, provider.capabilities.artistCatalog);
    assert.equal(provider.manifest.catalog.videos, provider.capabilities.musicVideos);
    assert.equal(provider.manifest.qualityMapping.neutral, Boolean(provider.qualityMapping?.toNeutral));
    assert.equal(provider.manifest.qualityMapping.stereo, Boolean(provider.qualityMapping?.fromNeutralAudio));
    assert.equal(provider.manifest.qualityMapping.spatial, provider.capabilities.spatialAudio);
    assert.equal(provider.manifest.qualityMapping.video, provider.capabilities.musicVideos);
  }
});
