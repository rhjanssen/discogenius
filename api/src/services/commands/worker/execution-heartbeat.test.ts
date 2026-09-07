import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { startExecutionHeartbeat } from "./execution-heartbeat.js";

test("physical heartbeats continue while one lease renewal waits for the database", async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let beats = 0;
  let renewals = 0;
  const stop = startExecutionHeartbeat({ intervalMs: 5,
    onHeartbeat: () => { beats++; },
    renew: () => { renewals++; return pending; },
    onError: () => assert.fail("renewal should not fail"),
  });
  try {
    await delay(40);
    assert.ok(beats > 1);
    assert.equal(renewals, 1, "lease waits must not accumulate callbacks");
    let stopped = false;
    const stopping = stop().then(() => { stopped = true; });
    await delay(10);
    assert.equal(stopped, false, "completion must await its outstanding renewal");
    const finalBeat = beats;
    release();
    await stopping;
    await delay(15);
    assert.equal(beats, finalBeat);
    assert.equal(renewals, 1);
  } finally { release(); await stop(); }
});

test("a rejected lease renewal is reported and retried without killing execution", async () => {
  let calls = 0;
  const errors: unknown[] = [];
  let recovered!: () => void;
  const recovery = new Promise<void>(resolve => { recovered = resolve; });
  const failure = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
  const stop = startExecutionHeartbeat({ intervalMs: 5,
    renew: async () => { if (++calls === 1) throw failure; recovered(); },
    onError: error => errors.push(error),
  });
  try {
    await Promise.race([recovery, delay(1000).then(() => assert.fail("renewal did not recover"))]);
    assert.deepEqual(errors, [failure]);
  } finally { await stop(); }
});
