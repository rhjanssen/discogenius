import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-download-progress-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.download-progress.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

const { deriveCatalogFileProgress, resolveDownloadTrackOfferIndex } = await import("./download-processor.js");
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


test('album track offers resolve the exact edition occurrence rather than the first repeated recording', () => {
  const tracks = [
    { title: 'Intro', canonicalTrackMbid: 'disc-one', canonicalRecordingMbid: 'same-recording', providerTrackId: 'same-provider-id', trackNum: 1, volumeNum: 1, status: 'queued' as const },
    { title: 'Intro', canonicalTrackMbid: 'disc-two', canonicalRecordingMbid: 'same-recording', providerTrackId: 'same-provider-id', trackNum: 1, volumeNum: 2, status: 'queued' as const },
  ];
  assert.equal(resolveDownloadTrackOfferIndex(tracks, { provider: 'tidal', providerTrackId: 'same-provider-id', canonicalTrackMbid: 'disc-two' }), 1);
  assert.equal(resolveDownloadTrackOfferIndex(tracks, { provider: 'tidal', providerTrackId: 'same-provider-id', trackNum: 1, volumeNum: 2 }), 1);
  assert.equal(resolveDownloadTrackOfferIndex(tracks, { provider: 'tidal', providerTrackId: 'same-provider-id', canonicalRecordingMbid: 'same-recording' }), -1);
  assert.equal(resolveDownloadTrackOfferIndex(tracks, { provider: 'tidal', providerTrackId: 'same-provider-id', canonicalTrackMbid: 'missing-occurrence' }), -1);
});
