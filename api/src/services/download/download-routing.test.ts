import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-download-routing-"));
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;
process.env.DOWNLOAD_PATH = path.join(tempDir, "downloads");

const { getDownloadWorkspacePath, validateDownloadWorkspacePath } = await import("./download-routing.js");

after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("new download workspaces namespace equal item IDs by provider", () => {
  const tidal = getDownloadWorkspacePath("album", "42", "tidal");
  const apple = getDownloadWorkspacePath("album", "42", "apple-music");

  assert.notEqual(tidal, apple);
  assert.equal(tidal, path.join(tempDir, "downloads", "albums", "tidal", "42"));
  assert.equal(apple, path.join(tempDir, "downloads", "albums", "apple-music", "42"));
});

test("providerless workspace lookup preserves the persisted legacy location", () => {
  assert.equal(
    getDownloadWorkspacePath("album", "42"),
    path.join(tempDir, "downloads", "albums", "42"),
  );
});

test("download workspaces reject provider-id traversal and unsafe path characters", () => {
  for (const providerId of ["..", "../../config", "..\\..\\config", "C:\\config", "bad/name", "bad\u0000name"]) {
    assert.throws(
      () => getDownloadWorkspacePath("track", providerId, "tidal"),
      /Provider resource ID/u,
    );
  }
});

test("persisted workspace paths must remain below the configured download root", () => {
  const valid = path.join(tempDir, "downloads", "tracks", "tidal", "42", "job_1");
  assert.equal(validateDownloadWorkspacePath(valid), path.resolve(valid));
  assert.throws(() => validateDownloadWorkspacePath(path.join(tempDir, "config")), /download root/iu);
  assert.throws(() => validateDownloadWorkspacePath(path.join(tempDir, "downloads")), /download root/iu);
});
