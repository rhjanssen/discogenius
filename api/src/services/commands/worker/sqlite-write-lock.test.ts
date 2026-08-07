/**
 * The write lock has to be global to the *process*, not to a thread.
 *
 * The defect it replaces: `withSqliteWriteGate` was a module-scope promise tail
 * in `database.ts`, and command workers are real `worker_threads` Workers. Each
 * thread loads its own module instance, so each got its own gate. Two
 * RefreshArtist workers and a MatchArtistProviders worker could all believe
 * they held it and then contend for SQLite's single writer lock — the
 * `SQLITE_BUSY` claims and expired leases seen in the 500-artist run.
 *
 * These cases exercise the owner's queue directly, then run real Workers
 * against a real SQLite file to prove the end-to-end property: with the lock,
 * concurrent writers from separate threads never overlap and never see
 * `SQLITE_BUSY`.
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
  ownerAcquire,
  ownerRelease,
  ownerReleaseAllFor,
  resetWriteLockForTests,
  writeLockDiagnostics,
} from "./sqlite-write-lock.js";

/* ── The owner's queue ──────────────────────────────────────────────── */

test("only one holder at a time, and the queue is fair", () => {
  resetWriteLockForTests();
  const granted: string[] = [];
  for (const id of ["a", "b", "c"]) {
    ownerAcquire(id, "worker-1", () => granted.push(id));
  }
  assert.deepEqual(granted, ["a"], "the rest wait");
  assert.equal(writeLockDiagnostics().queueDepth, 2);

  ownerRelease("a");
  assert.deepEqual(granted, ["a", "b"]);
  ownerRelease("b");
  assert.deepEqual(granted, ["a", "b", "c"]);
  ownerRelease("c");
  assert.equal(writeLockDiagnostics().held, false);
});

test("a worker that dies holding the lock does not wedge the process", () => {
  resetWriteLockForTests();
  const granted: string[] = [];
  ownerAcquire("held", "worker-1", () => granted.push("held"));
  ownerAcquire("queued-same", "worker-1", () => granted.push("queued-same"));
  ownerAcquire("queued-other", "worker-2", () => granted.push("queued-other"));
  assert.deepEqual(granted, ["held"]);

  // worker-1 crashes: its held lock *and* its queued request both go.
  ownerReleaseAllFor("worker-1");
  assert.deepEqual(granted, ["held", "queued-other"], "worker-2 proceeds");
  assert.equal(writeLockDiagnostics().heldByOwner, "worker-2");
});

test("releasing something never granted does not wedge the line", () => {
  resetWriteLockForTests();
  const granted: string[] = [];
  ownerAcquire("a", "main", () => granted.push("a"));
  ownerAcquire("b", "main", () => granted.push("b"));
  ownerRelease("b");            // abandoned while queued
  ownerRelease("a");
  assert.deepEqual(granted, ["a"], "b was withdrawn, not granted");
  assert.equal(writeLockDiagnostics().held, false);
  assert.equal(writeLockDiagnostics().queueDepth, 0);
});

test("contention is measured, not merely survived", () => {
  resetWriteLockForTests();
  ownerAcquire("a", "main", () => {});
  ownerAcquire("b", "main", () => {});
  ownerAcquire("c", "main", () => {});
  const busy = writeLockDiagnostics();
  assert.equal(busy.held, true);
  assert.equal(busy.queueDepth, 2);
  assert.equal(busy.maxQueueDepth >= 3, true, "peak depth is retained");
  ownerRelease("a"); ownerRelease("b"); ownerRelease("c");
  assert.equal(writeLockDiagnostics().grants, 3);
});

/* ── Real threads against a real database ───────────────────────────── */

/**
 * A worker that writes to SQLite in a loop, taking the lock around each
 * transaction by asking the owner over the message port — the same protocol
 * `withGlobalSqliteWriteLock` uses.
 */
const WRITER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const Database = require(workerData.betterSqlitePath);
const db = new Database(workerData.dbPath);
db.pragma("journal_mode = WAL");
// Deliberately hostile: no busy timeout, so any real overlap surfaces as
// SQLITE_BUSY instead of being hidden by a retry.
db.pragma("busy_timeout = 0");

const pending = new Map();
parentPort.on("message", (message) => {
  if (message.kind !== "writeLockGranted") return;
  const resolve = pending.get(message.requestId);
  if (resolve) { pending.delete(message.requestId); resolve(); }
});

function acquire(requestId) {
  return new Promise((resolve) => {
    pending.set(requestId, resolve);
    parentPort.postMessage({ kind: "writeLockAcquire", requestId });
  });
}

(async () => {
  const errors = [];
  for (let i = 0; i < workerData.iterations; i += 1) {
    const requestId = workerData.name + ":" + i;
    await acquire(requestId);
    try {
      // Two statements with an await between them: without a real global lock
      // another thread interleaves here and SQLite rejects the writer.
      db.prepare("INSERT INTO writes (owner, seq) VALUES (?, ?)").run(workerData.name, i);
      await new Promise((r) => setImmediate(r));
      db.prepare("UPDATE writes SET committed = 1 WHERE owner = ? AND seq = ?")
        .run(workerData.name, i);
    } catch (error) {
      errors.push(String(error && error.code || error));
    } finally {
      parentPort.postMessage({ kind: "writeLockRelease", requestId });
    }
  }
  parentPort.postMessage({ kind: "finished", name: workerData.name, errors });
})();
`;

test("four concurrent command workers never overlap a write", async () => {
  resetWriteLockForTests();
  const folder = mkdtempSync(path.join(tmpdir(), "discogenius-write-lock-"));
  const dbPath = path.join(folder, "test.db");
  const workerPath = path.join(folder, "writer.cjs");
  writeFileSync(workerPath, WRITER_SOURCE);

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`CREATE TABLE writes (
    owner TEXT NOT NULL, seq INTEGER NOT NULL, committed INTEGER NOT NULL DEFAULT 0)`);

  // The real contention shape from the 500-artist run.
  const names = ["refresh-artist-1", "refresh-artist-2", "match-providers", "curate-artist"];
  const iterations = 25;
  const betterSqlitePath = createRequire(import.meta.url).resolve("better-sqlite3");

  // Terminations are awaited before cleanup: on Windows a worker still holding
  // the SQLite handle makes rmSync fail with EBUSY.
  const terminations: Array<Promise<unknown>> = [];
  try {
    const results = await Promise.all(names.map((name) => new Promise<{
      name: string; errors: string[];
    }>((resolve, reject) => {
      const worker = new Worker(workerPath, {
        workerData: { name, iterations, dbPath, betterSqlitePath },
      });
      worker.on("message", (message: { kind?: string; requestId?: string; name?: string; errors?: string[] }) => {
        if (message.kind === "writeLockAcquire" && message.requestId) {
          ownerAcquire(message.requestId, name, () => {
            worker.postMessage({ kind: "writeLockGranted", requestId: message.requestId });
          });
          return;
        }
        if (message.kind === "writeLockRelease" && message.requestId) {
          ownerRelease(message.requestId);
          return;
        }
        if (message.kind === "finished") {
          resolve({ name: message.name!, errors: message.errors! });
          terminations.push(worker.terminate());
        }
      });
      worker.on("error", (error) => { ownerReleaseAllFor(name); reject(error); });
    })));

    for (const result of results) {
      assert.deepEqual(result.errors, [], `${result.name} hit no SQLITE_BUSY`);
    }
    const rows = db.prepare("SELECT COUNT(*) AS total, SUM(committed) AS done FROM writes")
      .get() as { total: number; done: number };
    assert.equal(rows.total, names.length * iterations, "every write landed");
    assert.equal(rows.done, names.length * iterations, "every write completed its pair");

    const diagnostics = writeLockDiagnostics();
    assert.equal(diagnostics.held, false, "the lock is free at the end");
    assert.equal(diagnostics.queueDepth, 0);
    assert.equal(diagnostics.grants, names.length * iterations);
    // Four threads contending for one lock must actually have queued, or the
    // test proved nothing about serialization.
    assert.equal(diagnostics.maxQueueDepth > 1, true, "the workers genuinely contended");
  } finally {
    await Promise.allSettled(terminations);
    db.close();
    rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
