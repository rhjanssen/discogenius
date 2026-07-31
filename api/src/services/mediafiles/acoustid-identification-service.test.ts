import assert from "node:assert/strict";
import test from "node:test";
import {
  identifyAudioFileByAcoustId,
} from "./acoustid-identification-service.js";
import type { MusicBrainzRecording } from "./fingerprint.js";

function recording(id: string, durationSeconds = 180): MusicBrainzRecording {
  return {
    id,
    title: `Recording ${id}`,
    artists: ["Bastille"],
    isrcs: [],
    releaseTitles: [],
    firstReleaseDate: null,
    durationSeconds,
  };
}

test("embedded MusicBrainz identity avoids unnecessary fingerprint and lookup work", async () => {
  let called = false;
  const result = await identifyAudioFileByAcoustId("ignored.flac", {
    embeddedRecordingMbid: "embedded-recording",
    dependencies: {
      generateFingerprint: async () => {
        called = true;
        throw new Error("must not run");
      },
    },
  });
  assert.equal(result.status, "embedded_identity");
  assert.deepEqual(result.recordingIds, ["embedded-recording"]);
  assert.equal(called, false);
});

test("AcoustID identification surfaces multiple valid MusicBrainz Recording candidates", async () => {
  const result = await identifyAudioFileByAcoustId("unknown.flac", {
    dependencies: {
      generateFingerprint: async () => ({ fingerprint: "fingerprint", duration: 180 }),
      lookup: async () => ({
        status: "matched",
        cached: true,
        matches: [{
          id: "acoustid",
          score: 0.97,
          recordingIds: ["recording-one", "recording-two"],
        }],
      }),
      lookupRecording: async (id) => recording(id),
    },
  });
  assert.equal(result.status, "ambiguous");
  assert.equal(result.cached, true);
  assert.deepEqual(result.recordingIds, ["recording-one", "recording-two"]);
});

test("AcoustID identification rejects duration mismatches instead of assigning them", async () => {
  const result = await identifyAudioFileByAcoustId("unknown.flac", {
    durationToleranceSeconds: 5,
    dependencies: {
      generateFingerprint: async () => ({ fingerprint: "fingerprint", duration: 180 }),
      lookup: async () => ({
        status: "matched",
        cached: false,
        matches: [{
          id: "acoustid",
          score: 0.99,
          recordingIds: ["wrong-duration"],
        }],
      }),
      lookupRecording: async () => recording("wrong-duration", 220),
    },
  });
  assert.equal(result.status, "duration_mismatch");
  assert.deepEqual(result.recordingIds, []);
  assert.match(result.rejected[0]?.reason || "", /differs by 40s/);
});

test("AcoustID identification keeps no-match and service failures distinct", async () => {
  const dependencies = {
    generateFingerprint: async () => ({ fingerprint: "fingerprint", duration: 180 }),
    lookupRecording: async () => null,
  };
  const noMatch = await identifyAudioFileByAcoustId("unknown.flac", {
    dependencies: {
      ...dependencies,
      lookup: async () => ({
        status: "no_match",
        cached: false,
        matches: [],
      }),
    },
  });
  const failure = await identifyAudioFileByAcoustId("unknown.flac", {
    dependencies: {
      ...dependencies,
      lookup: async () => ({
        status: "service_error",
        cached: false,
        matches: [],
        error: "rate limited",
      }),
    },
  });
  assert.equal(noMatch.status, "no_match");
  assert.equal(failure.status, "service_error");
  assert.equal(failure.error, "rate limited");
});
