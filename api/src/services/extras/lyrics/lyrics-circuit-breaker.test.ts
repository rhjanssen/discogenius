import assert from "node:assert/strict";
import { beforeEach, describe, it, test } from "node:test";
import {
  LyricsCircuitBreaker,
  isLyricsCircuitOpen,
  recordLyricsFailure,
  recordLyricsSuccess,
  resetLyricsCircuitBreakerForTests,
} from "./lyrics-circuit-breaker.js";

test("circuit breaker trips after consecutive timeouts or 5xx errors", () => {
  const cb = new LyricsCircuitBreaker(5, 15 * 60 * 1000);
  const now = 1000000;

  assert.equal(cb.isOpen("tidal", now), false);

  // 4 failures should not trip
  for (let i = 1; i <= 4; i++) {
    const tripped = cb.recordFailure("tidal", { status: 504 }, now);
    assert.equal(tripped, false);
    assert.equal(cb.isOpen("tidal", now), false);
  }

  // 5th consecutive failure trips the circuit
  const timeoutError = new Error("Gateway Timeout");
  (timeoutError as any).status = 504;
  const tripped = cb.recordFailure("tidal", timeoutError, now);
  assert.equal(tripped, true);
  assert.equal(cb.isOpen("tidal", now), true);

  // During cooldown (15 min = 900,000 ms), circuit stays open
  assert.equal(cb.isOpen("tidal", now + 60_000), true);
  assert.equal(cb.isOpen("tidal", now + 899_999), true);

  // After cooldown expires, circuit allows a trial request (half-open)
  assert.equal(cb.isOpen("tidal", now + 900_001), false);
});

test("circuit breaker resets failure counter on success", () => {
  const cb = new LyricsCircuitBreaker(5, 15 * 60 * 1000);
  const now = 1000000;

  // 4 failures
  for (let i = 0; i < 4; i++) {
    cb.recordFailure("tidal", { status: 500 }, now);
  }
  assert.equal(cb.getConsecutiveFailures("tidal"), 4);

  // Success resets consecutive failures to 0
  cb.recordSuccess("tidal");
  assert.equal(cb.getConsecutiveFailures("tidal"), 0);

  // Next failure starts at 1, not 5
  cb.recordFailure("tidal", { status: 500 }, now);
  assert.equal(cb.getConsecutiveFailures("tidal"), 1);
  assert.equal(cb.isOpen("tidal", now), false);
});

test("circuit breaker ignores non-qualifying errors like 404", () => {
  const cb = new LyricsCircuitBreaker(5, 15 * 60 * 1000);
  const now = 1000000;

  // 404 is definitive absence, not a server timeout or 5xx
  const notFoundError = new Error("Not Found");
  (notFoundError as any).status = 404;

  const qualified = cb.recordFailure("tidal", notFoundError, now);
  assert.equal(qualified, false);
  assert.equal(cb.getConsecutiveFailures("tidal"), 0);
  assert.equal(cb.isOpen("tidal", now), false);
});

test("circuit breaker recognizes TimeoutError and AbortError", () => {
  const cb = new LyricsCircuitBreaker(3, 60_000);
  const now = 1000000;

  const timeoutErr = new Error("Request timed out");
  timeoutErr.name = "TimeoutError";

  cb.recordFailure("tidal", timeoutErr, now);
  cb.recordFailure("tidal", timeoutErr, now);
  assert.equal(cb.isOpen("tidal", now), false);

  cb.recordFailure("tidal", timeoutErr, now);
  assert.equal(cb.isOpen("tidal", now), true);
});

test("global helpers operate and reset correctly", () => {
  resetLyricsCircuitBreakerForTests();
  const now = Date.now();

  assert.equal(isLyricsCircuitOpen("tidal", now), false);

  for (let i = 0; i < 5; i++) {
    recordLyricsFailure("tidal", { status: 503 }, now);
  }
  assert.equal(isLyricsCircuitOpen("tidal", now), true);

  recordLyricsSuccess("tidal");
  assert.equal(isLyricsCircuitOpen("tidal", now), false);

  resetLyricsCircuitBreakerForTests();
  assert.equal(isLyricsCircuitOpen("tidal", now), false);
});
