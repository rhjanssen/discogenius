import assert from "node:assert/strict";
import { test } from "node:test";
import {
  findRelatedAudioRecordingForVideo,
  isLivePerformanceTitle,
  liveVenueSignaturesCompatible,
  preferredMergedVideoTitle,
  recordingPerformanceTitle,
  videoAudioTitlesCompatible,
} from "./refresh-video-support.js";

test("video→audio title match requires duration within 5s", () => {
  const candidates = [
    { id: 1, mbid: "audio-a", title: "Romeo & Juliet (Live At The Hammersmith Odeon)", length_ms: 465_000, has_live_album: 1 },
    { id: 2, mbid: "audio-b", title: "Romeo & Juliet (Live At The Hammersmith Odeon)", length_ms: 457_000, has_live_album: 1 },
  ];

  const withinFive = findRelatedAudioRecordingForVideo(
    { title: "Romeo & Juliet (Live At The Hammersmith Odeon)", duration: 457 },
    candidates,
  );
  assert.equal(withinFive?.id, 2);
  assert.equal(withinFive?.method, "provider-video-title-recording");

  const eightSecondsOff = findRelatedAudioRecordingForVideo(
    { title: "Romeo & Juliet (Live At The Hammersmith Odeon)", duration: 457 },
    [{
      id: 1,
      mbid: "audio-a",
      title: "Romeo & Juliet (Live At The Hammersmith Odeon)",
      length_ms: 465_866,
      has_live_album: 1,
    }],
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
    "Oblivion (Lyric Video)",
  );
});

test("main OMV prefers studio album audio over same-duration live bootleg", () => {
  const match = findRelatedAudioRecordingForVideo(
    { title: "Back to Black", duration: 247 },
    [
      { id: 1, mbid: "live-bootleg", title: "Back to Black", length_ms: 247_000, has_non_live_album: 0 },
      { id: 2, mbid: "studio", title: "Back to Black", length_ms: 241_000, has_non_live_album: 1, has_studio_album: 1 },
    ],
    { videoVariant: "video", preferStudioAudio: true },
  );
  assert.equal(match?.id, 2, "studio album audio must win despite 6s duration delta");
  assert.equal(match?.evidence.hasNonLiveAlbum, true);
});

test("main OMV prefers Album/EP/Single studio membership over compilation-only", () => {
  const match = findRelatedAudioRecordingForVideo(
    { title: "Back to Black", duration: 247 },
    [
      { id: 1, mbid: "compilation", title: "Back to Black", length_ms: 252_000, has_non_live_album: 1, has_studio_album: 0 },
      { id: 2, mbid: "studio-album", title: "Back to Black", length_ms: 241_000, has_non_live_album: 1, has_studio_album: 1 },
    ],
    { videoVariant: "video", preferStudioAudio: true },
  );
  assert.equal(match?.id, 2);
});

test("main OMV rejects live-titled audio on artist-wide studio preference", () => {
  const match = findRelatedAudioRecordingForVideo(
    { title: "Bad Blood", duration: 228 },
    [
      { id: 1, mbid: "live-audio", title: "Bad Blood (live)", length_ms: 228_792, has_non_live_album: 1 },
      { id: 2, mbid: "studio", title: "Bad Blood", length_ms: 212_613, has_non_live_album: 1 },
    ],
    { videoVariant: "video", preferStudioAudio: true },
  );
  assert.equal(match?.id, 2, "live-titled audio must lose to studio even when duration is closer");
});

test("main OMV rejects live-album-only session audio without the word live", () => {
  const match = findRelatedAudioRecordingForVideo(
    { title: "Stronger Than Me", duration: 232 },
    [
      {
        id: 1,
        mbid: "session",
        title: "Stronger Than Me (Later With Jools Holland / Nov 2003)",
        length_ms: 231_000,
        has_live_album: 1,
        has_non_live_album: 0,
        has_studio_album: 0,
      },
      {
        id: 2,
        mbid: "studio",
        title: "Stronger Than Me",
        length_ms: 230_000,
        has_non_live_album: 1,
        has_studio_album: 1,
      },
    ],
    { videoVariant: "video", preferStudioAudio: true },
  );
  assert.equal(match?.id, 2);
  assert.equal(
    findRelatedAudioRecordingForVideo(
      { title: "Teach Me Tonight", duration: 198 },
      [{
        id: 9,
        mbid: "hoot",
        title: "Teach Me Tonight (Hootenanny / Dec 2004)",
        length_ms: 198_000,
        has_live_album: 1,
        has_non_live_album: 0,
        has_studio_album: 0,
      }],
      { videoVariant: "video", preferStudioAudio: true },
    ),
    null,
  );
  assert.equal(
    isLivePerformanceTitle("Stronger Than Me (Later With Jools Holland / Nov 2003)"),
    false,
    "show names are not title markers; live-album-only membership is the gate",
  );
});

test("live-marked video does not match studio audio even when duration is close", () => {
  const match = findRelatedAudioRecordingForVideo(
    { title: "You Know I'm No Good (Live)", duration: 218 },
    [
      {
        id: 1,
        mbid: "studio",
        title: "You Know I'm No Good",
        length_ms: 216_000,
        has_non_live_album: 1,
        has_studio_album: 1,
      },
      {
        id: 2,
        mbid: "live-cut",
        title: "You Know I'm No Good (Live)",
        length_ms: 218_000,
        has_live_album: 1,
        has_non_live_album: 0,
      },
    ],
  );
  assert.equal(match?.id, 2);
  assert.equal(
    findRelatedAudioRecordingForVideo(
      { title: "Pompeii (MTV Unplugged)", duration: 214 },
      [{
        id: 3,
        mbid: "studio-pompeii",
        title: "Pompeii",
        length_ms: 214_000,
        has_non_live_album: 1,
        has_studio_album: 1,
      }],
    ),
    null,
  );
});

test("Abbey Road live does not attach to Unit 24 venue audio", () => {
  assert.equal(
    liveVenueSignaturesCompatible(
      "Flaws (live at Abbey Road)",
      "Flaws (acoustic version // live from Unit 24)",
    ),
    false,
  );
  assert.equal(
    videoAudioTitlesCompatible(
      "Flaws (live at Abbey Road)",
      "Flaws (acoustic version // live from Unit 24)",
    ),
    false,
  );
  const match = findRelatedAudioRecordingForVideo(
    { title: "Flaws (live at Abbey Road)", duration: 259 },
    [
      {
        id: 114,
        mbid: "flaws-unit24",
        title: "Flaws (live acoustic version)",
        length_ms: 218_000,
        has_non_live_album: 1,
      },
    ],
  );
  assert.equal(match, null);
});

test("Oblivion live title is incompatible with Flaws Unit 24 audio", () => {
  assert.equal(
    videoAudioTitlesCompatible(
      "Oblivion (Live From Capitol Studios, USA / 2013)",
      "Flaws (live acoustic version)",
    ),
    false,
  );
});

test("studio OMV does not attach to Unplugged or Alchemy-style live audio", () => {
  assert.equal(
    findRelatedAudioRecordingForVideo(
      { title: "Pompeii (Official Music Video)", duration: 214 },
      [{
        id: 1,
        mbid: "unplugged-pompeii",
        title: "Pompeii (MTV Unplugged)",
        length_ms: 214_000,
        has_live_album: 1,
        has_non_live_album: 0,
        has_studio_album: 0,
      }],
    ),
    null,
  );
  const alchemyAudio = [{
    id: 2,
    mbid: "alchemy-sultans",
    title: "Sultans of Swing",
    length_ms: 347_000,
    has_live_album: 1,
    has_non_live_album: 0,
    has_studio_album: 0,
  }];
  assert.equal(
    findRelatedAudioRecordingForVideo(
      { title: "Sultans of Swing (Official Music Video)", duration: 347 },
      alchemyAudio,
    ),
    null,
    "bare live-album title is still live; studio OMV must not attach",
  );
  const liveOfThatCut = findRelatedAudioRecordingForVideo(
    { title: "Sultans of Swing (Live)", duration: 347 },
    alchemyAudio,
  );
  assert.equal(liveOfThatCut?.id, 2);
});

test("Watch Listen Tell session is not the studio Overjoyed recording", () => {
  assert.equal(
    recordingPerformanceTitle("Overjoyed", "Watch Listen Tell session"),
    "Overjoyed (Watch Listen Tell session)",
  );
  assert.equal(
    videoAudioTitlesCompatible("Overjoyed (Watch Listen Tell session)", "Overjoyed"),
    false,
  );
  assert.equal(
    videoAudioTitlesCompatible("Overjoyed (Official Music Video)", "Overjoyed"),
    true,
  );
  const studio = [{
    id: 6,
    mbid: "overjoyed-studio",
    title: "Overjoyed",
    length_ms: 206_253,
    has_non_live_album: 1,
    has_studio_album: 1,
  }];
  assert.equal(
    findRelatedAudioRecordingForVideo(
      { title: "Overjoyed", duration: 195, disambiguation: "Watch Listen Tell session" },
      studio,
      { videoVariant: "video", preferStudioAudio: true },
    ),
    null,
  );
  const official = findRelatedAudioRecordingForVideo(
    { title: "Overjoyed", duration: 223 },
    studio,
    { videoVariant: "video", preferStudioAudio: true },
  );
  assert.equal(official?.id, 6);
});
