import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-download-progress-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.download-progress.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

const { deriveCatalogFileProgress } = await import("./download-processor.js");
const databaseModule = await import("../../database.js");

after(() => {
  databaseModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("deriveCatalogFileProgress uses catalog length, not provider queue size", () => {
  const tracks = [
    { status: "completed" },
    { status: "downloading" },
    { status: "queued" },
    { status: "queued" },
  ];
  assert.deepEqual(deriveCatalogFileProgress(tracks), {
    totalFiles: 4,
    currentFileNum: 2,
    completed: 1,
  });
});

test("deriveCatalogFileProgress points at next queued row", () => {
  const tracks = [
    { status: "skipped" },
    { status: "completed" },
    { status: "queued" },
  ];
  assert.deepEqual(deriveCatalogFileProgress(tracks), {
    totalFiles: 3,
    currentFileNum: 3,
    completed: 2,
  });
});

test("deriveCatalogFileProgress returns null without tracks", () => {
  assert.equal(deriveCatalogFileProgress([]), null);
  assert.equal(deriveCatalogFileProgress(null), null);
});
