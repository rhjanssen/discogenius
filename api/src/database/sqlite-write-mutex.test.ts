/**
 * Process-wide SQLite writer admission for Node worker_threads.
 * Four threads with busy_timeout=0 must never see SQLITE_BUSY
 * when they take the mutex around each write.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
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

function holdWorker(name: string, onAcquired?: () => void) {
  const data = sqliteWriteMutexWorkerData();
  const worker = new Worker(new URL("../services/commands/worker/command-worker-bootstrap.mjs", import.meta.url), {
    workerData: { ...data, mode: "hold", name, __entry: new URL("./sqlite-write-mutex.fixture.ts", import.meta.url).href },
  });
  const queued = new Promise<void>((resolve, reject) => {
    worker.on("message", (message) => { if (message.kind === "queued") resolve(); });
    worker.once("error", reject);
  });
  const acquired = new Promise<void>((resolve, reject) => {
    worker.on("message", (message) => { if (message.kind === "acquired") { onAcquired?.(); resolve(); } });
    worker.once("error", reject);
  });
  return { worker, queued, acquired, token: Number(data[SQLITE_WRITE_MUTEX_OWNER_WORKER_DATA_KEY]) };
}

test("production writers receive the lock in arrival order across worker threads", { timeout: 10_000 }, async () => {
  const names = ["first writer", "second writer", "third writer"];
  const order: string[] = [];
  const holders: ReturnType<typeof holdWorker>[] = [];
  try {
    await withSqliteWriteMutexAsync(async () => {
      for (const name of names) {
        const holder = holdWorker(name, () => { order.push(name); holder.worker.postMessage("release"); });
        holders.push(holder);
        await holder.queued;
      }
      assert.deepEqual(sqliteWriteMutexDiagnostics().waitingLabels, names);
    }, "test:hold-until-writers-queue");
    await Promise.all(holders.map(holder => holder.acquired));
    assert.deepEqual(order, names);
  } finally {
    for (const holder of holders) {
      await holder.worker.terminate();
      forceReleaseSqliteWriteMutexOwner(holder.token);
    }
  }
});

test("terminating a queued production writer removes its ticket without releasing another owner", { timeout: 10_000 }, async () => {
  await withSqliteWriteMutexAsync(async () => {
    const holder = holdWorker("interrupted waiter");
    await holder.queued;
    await holder.worker.terminate();
    assert.equal(forceReleaseSqliteWriteMutexOwner(holder.token), true);
    assert.equal(sqliteWriteMutexDiagnostics().queueDepth, 0);
    assert.equal(isSqliteWriteMutexHeld(), true);
  });
  assert.equal(isSqliteWriteMutexHeld(), false);
});

test("a contended synchronous HTTP write fails promptly and a dead owner releases its ticket", { timeout: 10_000 }, async () => {
  const holder = holdWorker("long writer");
  try {
    await holder.acquired;
    const started = performance.now();
    assert.throws(() => withSqliteWriteMutexSync(() => undefined), { code: "SQLITE_BUSY" });
    assert.ok(performance.now() - started < 1_000, "HTTP thread must not wait out the 15-second worker timeout");
  } finally {
    await holder.worker.terminate();
    forceReleaseSqliteWriteMutexOwner(holder.token);
  }
  assert.equal(isSqliteWriteMutexHeld(), false);
  await withSqliteWriteMutexAsync(() => undefined);
});

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

test("an unrelated callback cannot borrow an async writer's ownership on the same thread", async () => {
  let release!: () => void;
  let ready!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { ready = resolve; });
  const writer = withSqliteWriteMutexAsync(async () => {
    ready();
    await pending;
    withSqliteWriteMutexSync(() => undefined);
    await withSqliteWriteMutexAsync(() => undefined);
  });
  try {
    await started;
    assert.throws(() => withSqliteWriteMutexSync(() => assert.fail("unrelated write entered")), { code: "SQLITE_BUSY" });
  } finally { release(); await writer; }
  withSqliteWriteMutexSync(() => undefined);
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

test("supervisor finishes a dead worker's interrupted release without touching a live owner", () => {
  const data = sqliteWriteMutexWorkerData();
  const view = new Int32Array(data[SQLITE_WRITE_MUTEX_WORKER_DATA_KEY] as SharedArrayBuffer);
  const owner = Number(data[SQLITE_WRITE_MUTEX_OWNER_WORKER_DATA_KEY]);
  assert.equal(Atomics.compareExchange(view, 0, 0, -owner), 0);
  try {
    assert.equal(forceReleaseSqliteWriteMutexOwner(owner + 1), false);
    assert.equal(isSqliteWriteMutexHeld(), true);
    assert.equal(forceReleaseSqliteWriteMutexOwner(owner), true);
    withSqliteWriteMutexSync(() => undefined);
  } finally {
    forceReleaseSqliteWriteMutexOwner(owner);
  }
});

test("four concurrent workers with busy_timeout=0 never see SQLITE_BUSY", async () => {
  const folder = mkdtempSync(path.join(tmpdir(), "discogenius-write-mutex-"));
  const dbPath = path.join(folder, "test.db");
  const workerPath = new URL("../services/commands/worker/command-worker-bootstrap.mjs", import.meta.url);
  const fixturePath = new URL("./sqlite-write-mutex.fixture.ts", import.meta.url).href;

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
          __entry: fixturePath,
          ...sqliteWriteMutexWorkerData(),
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


test("an interrupted diagnostic counter update cannot block an empty writer queue", () => {
  const view = new Int32Array(getOrCreateSqliteWriteMutexSab());
  const prior = Atomics.load(view, 3);
  Atomics.store(view, 3, 1);
  try {
    assert.equal(withSqliteWriteMutexSync(() => "written"), "written");
  } finally {
    Atomics.store(view, 3, prior);
  }
});
