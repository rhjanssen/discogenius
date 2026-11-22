import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-deezer-unavailable-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.deezer-unavailable.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;
process.env.DISCOGENIUS_DOWNLOAD_SAME_OFFER_ATTEMPTS = "3";
process.env.DISCOGENIUS_DOWNLOAD_SAME_OFFER_BACKOFF_MS = "0";
process.env.DISCOGENIUS_DEEZER_JITTER_MAX_MS = "0";

const databaseModule = await import("../../database.js");
databaseModule.initDatabase();
const { db } = databaseModule;
await import("../providers/index.js");
const { DownloadProcessor } = await import("./download-processor.js");
const { downloadBackendRegistry } = await import("./download-backend.js");
const { ProviderUnavailableError } = await import("./provider-unavailable-error.js");
const { StreamripDeezerBackend, classifyStreamripOutput } = await import("../providers/deezer/streamrip-backend.js");
const { saveDeezerCredentials } = await import("../providers/deezer/deezer-auth.js");
const { getPendingAcquisitionPlanningRevision } = await import("../music/acquisition-planning-control.js");

test.after(() => {
  databaseModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("a delisted Deezer album is tried once, marked unavailable, and sent back to planning", async () => {
  saveDeezerCredentials({ arl: "a".repeat(192) });
  db.prepare(`
    INSERT INTO ProviderItems (provider, entity_type, provider_id, title, availability)
    VALUES ('deezer', 'release', '113031', 'Just Say Ozzy', 'available')
  `).run();
  const outputTail = "Traceback (most recent call last)\nDataException: DataException: album/113031 no data";
  let runs = 0;
  downloadBackendRegistry.register(new StreamripDeezerBackend(async () => {
    runs += 1;
    return { exitCode: 1, outputTail, classifiedErrors: classifyStreamripOutput(outputTail), producedFiles: [] };
  }));
  assert.equal(getPendingAcquisitionPlanningRevision(), null);

  const processor = new DownloadProcessor() as any;
  await assert.rejects(
    () => processor.downloadItem(93001, "113031", "album", {
      provider: "deezer",
      providerId: "113031",
      type: "album",
      title: "Just Say Ozzy",
      artist: "Ozzy Osbourne",
    }, {
      provider: "deezer",
      type: "album",
      providerId: "113031",
      workerId: "deezer-unavailable-test",
      abortController: new AbortController(),
      cancelRequested: false,
    }),
    (error: unknown) => error instanceof ProviderUnavailableError,
  );

  assert.equal(runs, 1, "an unavailable offer gets no same-offer retries");
  const row = db.prepare(`
    SELECT availability FROM ProviderItems
    WHERE provider = 'deezer' AND entity_type = 'release' AND provider_id = '113031'
  `).get() as { availability: string };
  assert.equal(row.availability, "unavailable");
  assert.notEqual(getPendingAcquisitionPlanningRevision(), null, "the next missing pass replans instead of requeueing this offer");
});
