import assert from "node:assert/strict";
import { test } from "node:test";
import {
  VIDEO_IDENTITY_MATCH_THRESHOLD,
  dateSimilarity,
  durationSimilarity,
  scoreVideoIdentityMatch,
} from "./video-match.js";
import { VIDEO_DURATION_MATCH_MS } from "./video-variant.js";

test("durationSimilarity is full credit inside the soft gate then falls off", () => {
  assert.equal(durationSimilarity(301_000, 301_000), 1);
  assert.equal(durationSimilarity(301_000, 301_000 + VIDEO_DURATION_MATCH_MS), 1);
  assert.ok(durationSimilarity(301_000, 282_000) < 0.5);
  assert.equal(durationSimilarity(301_000, null), 0.4);
});

test("dateSimilarity rewards same day and stays neutral when missing", () => {
  assert.equal(dateSimilarity("2017-06-05", "2017-06-05"), 1);
  assert.ok(dateSimilarity("2017-06-05", "2017-04-18") < 0.5);
  assert.equal(dateSimilarity("2017-06-05", null), 0.4);
});

test("Glory OMV identity matches across providers with title+duration+date", () => {
  const match = scoreVideoIdentityMatch({
    titleA: "Glory",
    titleB: "Glory (Official Music Video)",
    lengthMsA: 301_000,
    lengthMsB: 301_000,
    releaseDateA: "2017-06-05",
    releaseDateB: "2017-06-05",
  });
  assert.equal(match.matched, true);
  assert.ok(match.score >= VIDEO_IDENTITY_MATCH_THRESHOLD);
});

test("different Glory cuts with far durations do not merge", () => {
  const match = scoreVideoIdentityMatch({
    titleA: "Glory",
    titleB: "Glory",
    lengthMsA: 301_000,
    lengthMsB: 252_000,
    releaseDateA: "2017-06-05",
    releaseDateB: "2017-05-05",
  });
  assert.equal(match.matched, false);
  assert.equal(match.reason, "duration-hard-reject");
});

test("wrong audio-cut duration without a shared date does not merge on title alone", () => {
  const match = scoreVideoIdentityMatch({
    titleA: "Glory",
    titleB: "Glory",
    lengthMsA: 301_000,
    lengthMsB: 282_000,
    releaseDateA: "2017-06-05",
    releaseDateB: null,
  });
  assert.equal(match.matched, false);
});

test("tour-suffixed titles merge when duration aligns", () => {
  const match = scoreVideoIdentityMatch({
    titleA: "SAVE MY SOUL",
    titleB: 'SAVE MY SOUL ("FROM ALL SIDES" Tour)',
    lengthMsA: 256_000,
    lengthMsB: 256_000,
  });
  assert.equal(match.matched, true);
  assert.ok(match.titleScore >= 0.88);
});
