import assert from "node:assert/strict";
import test from "node:test";
import {
  parsePlaybackExpiration,
  playbackSignatureMatches,
  signPlaybackValue,
} from "./playback-signing.js";

test("playback signing fails closed without a configured secret", () => {
  const previous = process.env.JWT_SECRET;
  try {
    delete process.env.JWT_SECRET;
    assert.throws(() => signPlaybackValue("tidal:track:1"), /unavailable/);
  } finally {
    if (previous === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previous;
  }
});

test("playback signatures bind the complete value and reject malformed input", () => {
  const previous = process.env.JWT_SECRET;
  try {
    process.env.JWT_SECRET = "test-secret-that-is-not-used-outside-this-test";
    const signature = signPlaybackValue("tidal:track:LOSSLESS:123");
    assert.equal(playbackSignatureMatches(signature, "tidal:track:LOSSLESS:123"), true);
    assert.equal(playbackSignatureMatches(signature, "tidal:other:LOSSLESS:123"), false);
    assert.equal(playbackSignatureMatches("not-hex", "tidal:track:LOSSLESS:123"), false);
  } finally {
    if (previous === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previous;
  }
});

test("signed playback expiry rejects malformed, expired, and implausibly long URLs", () => {
  const now = 1_800_000_000;
  assert.equal(parsePlaybackExpiration("not-a-time", now), null);
  assert.equal(parsePlaybackExpiration(String(now), now), null);
  assert.equal(parsePlaybackExpiration(String(now + 7_201), now), null);
  assert.equal(parsePlaybackExpiration(String(now + 3_600), now), now + 3_600);
});
