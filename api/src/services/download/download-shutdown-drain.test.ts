import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-shutdown-drain-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.shutdown-drain.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let processorModule: typeof import("./download-processor.js");

before(async () => {
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  processorModule = await import("./download-processor.js");
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

// A deploy restart used to kill a running import mid-album; restart recovery
// then failed it closed ("may have partially mutated library files").
// Shutdown must let the running import finish first.
test("shutdown suspend waits for a running import to finish", async () => {
  const processor = new processorModule.DownloadProcessor();
  const running = deferred();
  (processor as any).activeImports.set(4242, {
    providerId: "album-1", type: "album", workerId: "w", promise: running.promise,
  });

  let suspended = false;
  const suspending = processor.suspend().then(() => { suspended = true; });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(suspended, false, "suspend returned while an import was still running");

  running.resolve();
  await suspending;
  assert.equal(suspended, true);
});

test("import drain gives up at the deadline and names what is still running", async () => {
  const stuck = new Map([[7, { promise: new Promise<void>(() => {}) }], [8, { promise: Promise.resolve() }]]);
  const started = Date.now();
  assert.deepEqual(await processorModule.drainActiveImports(stuck, 30), [7]);
  assert.ok(Date.now() - started < 1000);
});

test("a failing import does not break the drain", async () => {
  const failing = new Map([[9, { promise: Promise.reject(new Error("boom")) }]]);
  assert.deepEqual(await processorModule.drainActiveImports(failing, 1000), []);
});
