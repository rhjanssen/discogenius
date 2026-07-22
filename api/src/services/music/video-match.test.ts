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
  assert.equal(durationSimilarity(301_000, null), 0.35);
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

test("live and unlabeled studio variants stay split without cross-provider signal", () => {
  const match = scoreVideoIdentityMatch({
    titleA: "Distorted Light Beam",
    titleB: "Distorted Light Beam (Live)",
    lengthMsA: 214_000,
    lengthMsB: 214_000,
    releaseDateA: "2022-01-01",
    releaseDateB: "2022-01-01",
  });
  assert.equal(match.matched, false);
  assert.equal(match.reason, "variant-incompatible");
});

test("cross-provider bare live twins merge unlabeled main at exact duration", () => {
  const match = scoreVideoIdentityMatch({
    titleA: "Seasons & Narcissus",
    titleB: "Seasons & Narcissus (Live)",
    lengthMsA: 206_000,
    lengthMsB: 206_000,
    releaseDateA: "2023-06-09",
    releaseDateB: "2023-06-09",
    providerA: "tidal",
    providerB: "apple-music",
  });
  assert.equal(match.matched, true);
  assert.ok(match.score >= VIDEO_IDENTITY_MATCH_THRESHOLD);
});

test("OMV and bare live stay split even cross-provider at equal duration", () => {
  const match = scoreVideoIdentityMatch({
    titleA: "Pompeii (Official Music Video)",
    titleB: "Pompeii (Live)",
    lengthMsA: 214_000,
    lengthMsB: 214_000,
    releaseDateA: "2013-02-11",
    releaseDateB: "2013-02-11",
    providerA: "tidal",
    providerB: "apple-music",
  });
  assert.equal(match.matched, false);
  assert.equal(match.reason, "variant-incompatible");
});

test("named TV performance twins bare title only at exact duration", () => {
  const sameDuration = scoreVideoIdentityMatch({
    titleA: "Pompeii",
    titleB: "Pompeii (Good Morning America Performance)",
    lengthMsA: 228_000,
    lengthMsB: 228_000,
  });
  assert.equal(sameDuration.matched, true);

  const liveAtVenue = scoreVideoIdentityMatch({
    titleA: "Back to Black",
    titleB: "Back To Black (Live at Other Voices, 2006)",
    lengthMsA: 253_000,
    lengthMsB: 253_000,
  });
  assert.equal(liveAtVenue.matched, true);

  const bareLiveWithoutVenue = scoreVideoIdentityMatch({
    titleA: "Distorted Light Beam",
    titleB: "Distorted Light Beam (Live)",
    lengthMsA: 182_000,
    lengthMsB: 182_000,
  });
  assert.equal(bareLiveWithoutVenue.matched, false);
  assert.equal(bareLiveWithoutVenue.reason, "variant-incompatible");

  const offByFiveSeconds = scoreVideoIdentityMatch({
    titleA: "Pompeii",
    titleB: "Pompeii (Good Morning America Performance)",
    lengthMsA: 233_000,
    lengthMsB: 228_000,
  });
  assert.equal(offByFiveSeconds.matched, false);
});

test("official and near-duration alternate cut do not merge past the 3s hard gate", () => {
  const match = scoreVideoIdentityMatch({
    titleA: "Pompeii",
    titleB: "Pompeii",
    lengthMsA: 233_000,
    lengthMsB: 228_000,
    releaseDateA: "2019-06-28",
    releaseDateB: "2019-06-28",
  });
  assert.equal(match.matched, false);
  assert.equal(match.reason, "duration-hard-reject");
});

test("shared ISRC + strong title merges across providers when one duration is missing", () => {
  const match = scoreVideoIdentityMatch({
    titleA: "Million Pieces",
    titleB: "Million Pieces",
    lengthMsA: 214_000,
    lengthMsB: null,
    isrcsA: "GBARL1401499",
    isrcsB: "GBARL1401499",
  });
  assert.equal(match.matched, true);
  assert.equal(match.durationScore, 1);
});

test("identical duration + strong title merges without dates or ISRC", () => {
  const match = scoreVideoIdentityMatch({
    titleA: "Million Pieces",
    titleB: "Million Pieces",
    lengthMsA: 214_000,
    lengthMsB: 214_000,
  });
  assert.equal(match.matched, true);
});
