import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-provider-registry-"));
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");

const CONFIG_FILE = path.join(tempDir, "config.toml");

function writeDefaultProvider(id: string | null): void {
  const lines = id ? ["[streaming]", `default_provider = "${id}"`] : [];
  fs.writeFileSync(CONFIG_FILE, lines.join("\n") + "\n", "utf-8");
}

test("registry resolves the active provider from config, not a hardcoded id", async () => {
  const { streamingProviderManager } = await import("./index.js");

  // Default config -> tidal.
  writeDefaultProvider("tidal");
  assert.equal(streamingProviderManager.getDefaultProviderId(), "tidal");
  assert.equal(streamingProviderManager.getDefaultStreamingProvider().id, "tidal");

  // Config switches the active provider to apple-music.
  writeDefaultProvider("apple-music");
  assert.equal(streamingProviderManager.getDefaultProviderId(), "apple-music");
  assert.equal(streamingProviderManager.getDefaultStreamingProvider().id, "apple-music");

  // Unknown/unregistered provider id falls back to the legacy default.
  writeDefaultProvider("does-not-exist");
  assert.equal(streamingProviderManager.getDefaultProviderId(), "tidal");

  // Missing streaming config also falls back gracefully.
  writeDefaultProvider(null);
  assert.equal(streamingProviderManager.getDefaultProviderId(), "tidal");
});

test("registry exposes both built-in providers", async () => {
  const { streamingProviderManager } = await import("./index.js");
  const ids = streamingProviderManager.getAllStreamingProviders().map((p) => p.id);
  assert.ok(ids.includes("tidal"));
  assert.ok(ids.includes("apple-music"));
});
