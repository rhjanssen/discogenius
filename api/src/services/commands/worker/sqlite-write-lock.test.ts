import assert from "node:assert/strict";
import test from "node:test";
import { withGlobalSqliteWriteLock, writeLockDiagnostics } from "./sqlite-write-lock.js";

test("write gate diagnostics identify the production holder and waiting section", async () => {
  let release!: () => void;
  let ready!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { ready = resolve; });
  const first = withGlobalSqliteWriteLock(async () => { ready(); await held; }, undefined, "catalog:tracks");
  await started;
  const second = withGlobalSqliteWriteLock(() => 42, undefined, "command:heartbeat");
  const during = writeLockDiagnostics();
  assert.equal(during.heldByLabel, "catalog:tracks");
  assert.deepEqual(during.waitingLabels, ["command:heartbeat"]);
  release();
  assert.deepEqual(await Promise.all([first, second]), [undefined, 42]);
  assert.equal(writeLockDiagnostics().held, false);
  assert.equal(writeLockDiagnostics().queueDepth, 0);
});
