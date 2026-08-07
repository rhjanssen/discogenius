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

test("yielding on an interval lets the heartbeat through", async () => {
  const heartbeat = startHeartbeat(10);
  try {
    // Same total work, yielding every 25 iterations as the matcher now does.
    for (let album = 0; album < 30; album += 1) {
      burnSynchronously(5);
      if ((album + 1) % 5 === 0) await yieldToEventLoop();
    }
    assert.ok(heartbeat.beats() > 0, "the heartbeat fired, so the lease survives");
  } finally {
    heartbeat.stop();
  }
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
