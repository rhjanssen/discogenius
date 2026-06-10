import assert from "node:assert/strict";
import test from "node:test";
import { materializeSegmentedPlayback, parsePlaybackRange } from "./segmented-playback-cache.js";

test("materializeSegmentedPlayback fetches a DASH preview once and reuses the cached buffer", async () => {
  const previousFetch = global.fetch;
  const requestedUrls: string[] = [];
  try {
    global.fetch = (async (url: string) => {
      requestedUrls.push(url);
      return new Response(url.endsWith("one") ? "first-" : "second");
    }) as typeof fetch;

    const first = await materializeSegmentedPlayback("track-1", ["https://cdn.test/one", "https://cdn.test/two"]);
    const second = await materializeSegmentedPlayback("track-1", ["https://cdn.test/one", "https://cdn.test/two"]);

    assert.equal(first.toString(), "first-second");
    assert.equal(second.toString(), "first-second");
    assert.deepEqual(requestedUrls, ["https://cdn.test/one", "https://cdn.test/two"]);
  } finally {
    global.fetch = previousFetch;
  }
});

test("parsePlaybackRange accepts open, closed, and suffix byte ranges", () => {
  assert.deepEqual(parsePlaybackRange(undefined, 100), null);
  assert.deepEqual(parsePlaybackRange("bytes=10-19", 100), { start: 10, end: 19 });
  assert.deepEqual(parsePlaybackRange("bytes=90-", 100), { start: 90, end: 99 });
  assert.deepEqual(parsePlaybackRange("bytes=-10", 100), { start: 90, end: 99 });
  assert.throws(() => parsePlaybackRange("bytes=100-", 100), /Invalid byte range/);
});
