import assert from "node:assert/strict";
import { test } from "node:test";
import { findRelatedAudioRecordingForVideo, preferredMergedVideoTitle } from "./refresh-video-support.js";

test("video→audio title match requires duration within 5s", () => {
  const candidates = [
    { id: 1, mbid: "audio-a", title: "Romeo & Juliet", length_ms: 465_000 },
    { id: 2, mbid: "audio-b", title: "Romeo & Juliet", length_ms: 457_000 },
  ];

  const withinFive = findRelatedAudioRecordingForVideo(
    { title: "Romeo & Juliet (Live At The Hammersmith Odeon)", duration: 457 },
    candidates,
  );
  assert.equal(withinFive?.id, 2);
  assert.equal(withinFive?.method, "provider-video-contained-title-recording");

  const eightSecondsOff = findRelatedAudioRecordingForVideo(
    { title: "Romeo & Juliet (Live At The Hammersmith Odeon)", duration: 457 },
    [{ id: 1, mbid: "audio-a", title: "Romeo & Juliet", length_ms: 465_866 }],
  );
  assert.equal(eightSecondsOff, null, "8.8s duration delta must not link on title alone");
});

test("video→audio title match rejects missing durations", () => {
  const match = findRelatedAudioRecordingForVideo(
    { title: "Pompeii", duration: null },
    [{ id: 9, mbid: "audio-p", title: "Pompeii", length_ms: 214_000 }],
  );
  assert.equal(match, null);
});

test("video→audio ISRC match still works when one duration is missing", () => {
  const match = findRelatedAudioRecordingForVideo(
    { title: "Pompeii (Official Video)", duration: null, isrc: "GBUM71507698" },
    [{ id: 9, mbid: "audio-p", title: "Other Title", length_ms: null, isrcs: "GBUM71507698" }],
  );
  assert.equal(match?.id, 9);
  assert.equal(match?.method, "provider-video-isrc-recording");
});

test("video→audio ISRC match ignores the 5s title duration gate", () => {
  const match = findRelatedAudioRecordingForVideo(
    { title: "Pompeii (Official Music Video)", duration: 225, isrc: "GBUM71300354" },
    [{ id: 3, mbid: "audio-p", title: "Pompeii", length_ms: 214_000, isrcs: '["GBUM71300354"]' }],
  );
  assert.equal(match?.id, 3);
  assert.equal(match?.method, "provider-video-isrc-recording");
});

test("preferredMergedVideoTitle keeps a shared live/venue parenthetical", () => {
  assert.equal(
    preferredMergedVideoTitle(
      "Romeo & Juliet (Live At The Hammersmith Odeon)",
      "Romeo & Juliet (Live At The Hammersmith Odeon) (Official Video)",
    ),
    "Romeo & Juliet (Live At The Hammersmith Odeon)",
  );
  assert.equal(
    preferredMergedVideoTitle("Good Grief", "Good Grief (Live From O2)"),
    "Good Grief (Live From O2)",
  );
  assert.equal(
    preferredMergedVideoTitle("Oblivion (Lyric Video)", "Oblivion (Official Music Video)"),
    "Oblivion",
  );
});
