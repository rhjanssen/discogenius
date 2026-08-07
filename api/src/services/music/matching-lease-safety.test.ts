/**
 * MatchArtistProviders must not starve its own heartbeat.
 *
 * Under the 500-artist load it repeatedly lost its lease, retried, and
 * poison-failed after three attempts. The heartbeat is a `setInterval` in the
 * worker entry, so it does not miss because the command is *slow* — it misses
 * because the handler holds the event loop, which thousands of synchronous
 * SQLite reads over a large discography will do.
 *
 * That makes the fix structural rather than a longer lease: yield periodically
 * and the timer fires. Critically, it also costs nothing at the provider: the
 * yields sit inside loops over already-fetched albums, and the fetch pattern
 * (bulk tracklists, non-candidate tracklists skipped) is untouched. Chunking
 * the *fetching* would have meant more API calls and risked rate limits.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { yieldToEventLoop } from "../commands/command-context.js";
import {
  createMatchingYield,
  MATCHING_YIELD_INTERVAL,
  MATCHING_YIELD_MS,
} from "./refresh-artist-service.js";

/** A timer heartbeat, exactly as the worker entry runs one. */
function startHeartbeat(intervalMs: number): { beats: () => number; stop: () => void } {
  let beats = 0;
  const timer = setInterval(() => { beats += 1; }, intervalMs);
  return { beats: () => beats, stop: () => clearInterval(timer) };
}

/** Synchronous work, of the kind a per-album SQLite read pass performs. */
function burnSynchronously(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) { /* deliberately blocking */ }
}

test("a loop that never yields starves the heartbeat", async () => {
  const heartbeat = startHeartbeat(10);
  try {
    // 30 albums of blocking work, no yield: the timer cannot fire at all.
    for (let album = 0; album < 30; album += 1) burnSynchronously(5);
    assert.equal(heartbeat.beats(), 0, "the lease would expire here");
  } finally {
    heartbeat.stop();
  }
});

test("the production cadence lets the heartbeat through", async () => {
  // Exercises the real helper at the real interval, not an illustrative one:
  // a test that yields more often than production proves nothing about
  // production.
  const heartbeat = startHeartbeat(10);
  const shouldYield = createMatchingYield();
  try {
    for (let album = 0; album < MATCHING_YIELD_INTERVAL * 2; album += 1) {
      await shouldYield();
      burnSynchronously(5);
    }
    assert.ok(heartbeat.beats() > 0, "the heartbeat fired, so the lease survives");
  } finally {
    heartbeat.stop();
  }
});

test("one pathological album cannot outrun the count alone", async () => {
  // A count assumes albums cost roughly the same. A 200-track compilation, or a
  // release matching thousands of candidate recordings, can exceed the
  // heartbeat interval on its own — and 24 more like it would still not reach
  // an interval of 25. The elapsed-time arm is what covers that.
  const heartbeat = startHeartbeat(10);
  const shouldYield = createMatchingYield();
  try {
    // Far fewer albums than MATCHING_YIELD_INTERVAL, each expensive.
    for (let album = 0; album < 4; album += 1) {
      await shouldYield();
      burnSynchronously(MATCHING_YIELD_MS);
    }
    assert.ok(
      heartbeat.beats() > 0,
      "elapsed time forced a yield even though the count never fired",
    );
  } finally {
    heartbeat.stop();
  }
});

test("the yield is cheap when the loop is already fast", async () => {
  // It must not turn a tight loop into one event-loop turn per album.
  const shouldYield = createMatchingYield();
  let turns = 0;
  const originalSetImmediate = globalThis.setImmediate;
  (globalThis as { setImmediate: typeof setImmediate }).setImmediate = ((
    callback: () => void, ...args: unknown[]
  ) => {
    turns += 1;
    return originalSetImmediate(callback, ...args as []);
  }) as typeof setImmediate;
  try {
    for (let album = 0; album < MATCHING_YIELD_INTERVAL * 3; album += 1) {
      await shouldYield();
    }
  } finally {
    (globalThis as { setImmediate: typeof setImmediate }).setImmediate = originalSetImmediate;
  }
  assert.ok(turns <= 4, `expected ~3 yields over 75 fast albums, saw ${turns}`);
});

test("yieldToEventLoop gives up a full event-loop turn, not just a microtask", async () => {
  // The distinction matters: awaiting a resolved promise drains microtasks and
  // returns without ever leaving the current turn, so timers never run and the
  // heartbeat still misses. `yieldToEventLoop` uses setImmediate, which reaches
  // the check phase — enough for pending macrotask callbacks to fire.
  let immediateRan = false;
  setImmediate(() => { immediateRan = true; });

  await Promise.resolve();
  assert.equal(immediateRan, false, "a microtask await never left the turn");

  await yieldToEventLoop();
  assert.equal(immediateRan, true, "the yield did");
});
