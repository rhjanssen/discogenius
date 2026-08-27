import assert from "node:assert/strict";
import { test } from "node:test";
import {
  VIDEO_IDENTITY_MATCH_THRESHOLD,
  dateSimilarity,
  durationSimilarity,
  isExactVideoTwin,
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

test("named TV performance twins bare title within the soft ±2s duration gate", () => {
  const sameDuration = scoreVideoIdentityMatch({
    titleA: "Pompeii",
    titleB: "Pompeii (Good Morning America Performance)",
    lengthMsA: 228_000,
    lengthMsB: 228_000,
  });
  assert.equal(sameDuration.matched, true);

  const liveAtVenue = scoreVideoIdentityMatch({
    titleA: "Me & Mr. Jones",
    titleB: "Me & Mr. Jones (Live at Other Voices, 2006)",
    lengthMsA: 203_000,
    lengthMsB: 203_000,
    releaseDateA: "2024-09-02",
    releaseDateB: "2024-09-02",
    variantA: "video",
    variantB: "live",
    providerA: "tidal",
    providerB: "apple-music",
  });
  assert.equal(liveAtVenue.matched, true);
  assert.ok(liveAtVenue.score >= VIDEO_IDENTITY_MATCH_THRESHOLD);

  // Catalog rounding: Apple 180s vs TIDAL 179s for the same Friday Night Project cut.
  const oneSecondRounding = scoreVideoIdentityMatch({
    titleA: "You Know I'm No Good",
    titleB: "You Know I'm No Good (Live From Friday Night Project / 2007)",
    lengthMsA: 179_000,
    lengthMsB: 180_000,
    releaseDateA: "2026-07-10",
    releaseDateB: "2026-07-10",
    variantA: "video",
    variantB: "live",
    providerA: "tidal",
    providerB: "apple-music",
  });
  assert.equal(oneSecondRounding.matched, true);

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

test("isExactVideoTwin allows ±2s catalog rounding but rejects farther cuts", () => {
  const base = {
    titleA: "Pompeii",
    titleB: "Pompeii",
    variantA: "official" as const,
    variantB: "official" as const,
  };
  assert.equal(isExactVideoTwin({
    ...base,
    lengthMsA: 233_000,
    lengthMsB: 232_000,
  }), true);
  assert.equal(isExactVideoTwin({
    ...base,
    lengthMsA: 233_000,
    lengthMsB: 231_000,
  }), true);
  assert.equal(isExactVideoTwin({
    ...base,
    lengthMsA: 233_000,
    lengthMsB: 228_000,
  }), false);
});

test("isExactVideoTwin rejects same-provider alternates with different known dates", () => {
  assert.equal(isExactVideoTwin({
    titleA: "Send Them Off!",
    titleB: "Send Them Off!",
    lengthMsA: 226_000,
    lengthMsB: 225_000,
    releaseDateA: "2016-10-14",
    releaseDateB: "2016-09-07",
  }), false);
});

test("isExactVideoTwin rejects different known provider ISRCs", () => {
  assert.equal(isExactVideoTwin({
    titleA: "Distorted Light Beam",
    titleB: "Distorted Light Beam",
    lengthMsA: 181000,
    lengthMsB: 182000,
    releaseDateA: "2021-06-23",
    releaseDateB: "2021-06-23",
    isrcsA: "GBUV72101394",
    isrcsB: "GBUV72101029",
  }), false);
});

test("a MusicBrainz video without duration still matches the official provider title", () => {
  const match = scoreVideoIdentityMatch({
    titleA: "Living",
    titleB: "Living (feat. Alex Clare)",
    lengthMsA: null,
    lengthMsB: 214_000,
  });
  assert.equal(match.matched, true);
  assert.ok(match.titleScore >= 0.9);
});

test("audio-cut provider titles stay split from a duration-less catalog video", () => {
  const match = scoreVideoIdentityMatch({
    titleA: "Living",
    titleB: "Living (Audio)",
    lengthMsA: null,
    lengthMsB: 214_000,
  });
  assert.equal(match.matched, false);
  assert.equal(match.reason, "variant-incompatible");
});
