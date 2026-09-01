/**
 * Process-wide SQLite writer mutex: Lidarr's one-writer model for Node
 * worker_threads. Four threads with busy_timeout=0 must never see SQLITE_BUSY
 * when they take the mutex around each write.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import Database from "better-sqlite3";
import {
  SQLITE_WRITE_MUTEX_OWNER_WORKER_DATA_KEY,
  SQLITE_WRITE_MUTEX_WORKER_DATA_KEY,
  forceReleaseSqliteWriteMutexOwner,
  getOrCreateSqliteWriteMutexSab,
  isSqliteWriteMutexHeld,
  sqliteWriteMutexDiagnostics,
  sqliteWriteMutexWorkerData,
  withSqliteWriteMutexAsync,
  withSqliteWriteMutexSync,
} from "./sqlite-write-mutex.js";

test("async writers on the same thread take turns across an await", async () => {
  const order: string[] = [];
  const first = withSqliteWriteMutexAsync(async () => {
    order.push("a-start");
    await new Promise((resolve) => setTimeout(resolve, 30));
    order.push("a-end");
    return "a";
  });
  const second = withSqliteWriteMutexAsync(async () => {
    order.push("b-start");
    order.push("b-end");
    return "b";
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const whileContended = sqliteWriteMutexDiagnostics();
  assert.equal(whileContended.held, true);
  assert.equal(whileContended.queueDepth, 1);
  assert.equal(whileContended.ownerToken !== null, true);
  const results = await Promise.all([first, second]);
  assert.deepEqual(results, ["a", "b"]);
  assert.deepEqual(order, ["a-start", "a-end", "b-start", "b-end"]);
  const after = sqliteWriteMutexDiagnostics();
  assert.equal(after.held, false);
  assert.equal(after.queueDepth, 0);
  assert.equal(after.maxQueueDepth >= 2, true);
});

test("nested sync writes re-enter while an async holder is active", async () => {
  await withSqliteWriteMutexAsync(() => {
    withSqliteWriteMutexSync(() => undefined);
    withSqliteWriteMutexSync(() => undefined);
  });
});

test("a terminated worker's owner token can release its abandoned mutex", async () => {
  const workerMutexData = sqliteWriteMutexWorkerData();
  const mutex = workerMutexData[SQLITE_WRITE_MUTEX_WORKER_DATA_KEY] as SharedArrayBuffer;
  const ownerToken = Number(workerMutexData[SQLITE_WRITE_MUTEX_OWNER_WORKER_DATA_KEY]);
  const worker = new Worker(`
    const { parentPort, workerData } = require("node:worker_threads");
    const lock = new Int32Array(workerData.mutex);
    if (Atomics.compareExchange(lock, 0, 0, workerData.ownerToken) !== 0) {
      throw new Error("test worker could not acquire mutex");
    }
    parentPort.postMessage("locked");
    setInterval(() => {}, 60_000);
  `, {
    eval: true,
    workerData: { mutex, ownerToken },
  });

  await new Promise<void>((resolve, reject) => {
    worker.once("message", () => resolve());
    worker.once("error", reject);
  });
  assert.equal(isSqliteWriteMutexHeld(), true);

  await worker.terminate();
  assert.equal(isSqliteWriteMutexHeld(), true, "worker exit alone leaves the SAB owner token behind");
  assert.equal(forceReleaseSqliteWriteMutexOwner(ownerToken + 1), false, "another worker cannot release it");
  assert.equal(forceReleaseSqliteWriteMutexOwner(ownerToken), true);
  assert.equal(isSqliteWriteMutexHeld(), false);

  withSqliteWriteMutexSync(() => undefined);
});

const WRITER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const Database = require(workerData.betterSqlitePath);
const { Atomics, SharedArrayBuffer } = globalThis;

const lock = new Int32Array(workerData.mutex);
let holds = 0;
function acquire() {
  if (holds > 0) { holds += 1; return; }
  while (Atomics.compareExchange(lock, 0, 0, 1) !== 0) {
    Atomics.wait(lock, 0, 1);
  }
  holds = 1;
}
function release() {
  holds -= 1;
  if (holds > 0) return;
  Atomics.store(lock, 0, 0);
  Atomics.notify(lock, 0);
}

const db = new Database(workerData.dbPath);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 0");

(async () => {
  const errors = [];
  for (let i = 0; i < workerData.iterations; i += 1) {
    acquire();
    try {
      db.prepare("INSERT INTO writes (owner, seq) VALUES (?, ?)").run(workerData.name, i);
      await new Promise((r) => setImmediate(r));
      db.prepare("UPDATE writes SET committed = 1 WHERE owner = ? AND seq = ?")
        .run(workerData.name, i);
    } catch (error) {
      errors.push(String(error && error.code || error));
    } finally {
      release();
    }
  }
  parentPort.postMessage({ kind: "finished", name: workerData.name, errors });
})();
`;

test("four concurrent workers with busy_timeout=0 never see SQLITE_BUSY", async () => {
  const folder = mkdtempSync(path.join(tmpdir(), "discogenius-write-mutex-"));
  const dbPath = path.join(folder, "test.db");
  const workerPath = path.join(folder, "writer.cjs");
  writeFileSync(workerPath, WRITER_SOURCE);

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`CREATE TABLE writes (
    owner TEXT NOT NULL, seq INTEGER NOT NULL, committed INTEGER NOT NULL DEFAULT 0)`);

  const names = ["refresh-artist-1", "refresh-artist-2", "match-providers", "curate-artist"];
  const iterations = 25;
  const betterSqlitePath = createRequire(import.meta.url).resolve("better-sqlite3");
  const mutex = getOrCreateSqliteWriteMutexSab();

  const terminations: Array<Promise<unknown>> = [];
  try {
    const results = await Promise.all(names.map((name) => new Promise<{
      name: string; errors: string[];
    }>((resolve, reject) => {
      const worker = new Worker(workerPath, {
        workerData: {
          name,
          iterations,
          dbPath,
          betterSqlitePath,
          mutex,
          [SQLITE_WRITE_MUTEX_WORKER_DATA_KEY]: mutex,
        },
      });
      worker.on("message", (message: { kind?: string; name?: string; errors?: string[] }) => {
        if (message.kind === "finished") {
          resolve({ name: message.name!, errors: message.errors! });
          terminations.push(worker.terminate());
        }
      });
      worker.on("error", reject);
    })));

    for (const result of results) {
      assert.deepEqual(result.errors, [], `${result.name} hit no SQLITE_BUSY`);
    }
    const rows = db.prepare("SELECT COUNT(*) AS total, SUM(committed) AS done FROM writes")
      .get() as { total: number; done: number };
    assert.equal(rows.total, names.length * iterations);
    assert.equal(rows.done, names.length * iterations);
  } finally {
    await Promise.allSettled(terminations);
    db.close();
    rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
