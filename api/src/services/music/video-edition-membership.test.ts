import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveVideoRelationsFromEdition,
  type EditionMember,
} from "./video-edition-membership.js";

let nextId = 0;
function member(
  overrides: Partial<EditionMember> & Pick<EditionMember, "title" | "isVideo">,
): EditionMember {
  nextId += 1;
  return {
    trackId: nextId * 10,
    recordingId: nextId * 100,
    lengthMs: 200_000,
    isrcs: [],
    mediumPosition: 1,
    position: nextId,
    videoVariant: null,
    ...overrides,
  };
}

test("the iTunes Festival shape links each video to the performance it is of", () => {
  // Members 1-5 audio, 6-7 video. Video 6 is of member 1; video 7 of member 5.
  const songOne = member({ title: "Pompeii", isVideo: false, position: 1 });
  const songTwo = member({ title: "Things We Lost in the Fire", isVideo: false, position: 2 });
  const songThree = member({ title: "Flaws", isVideo: false, position: 3 });
  const songFour = member({ title: "Icarus", isVideo: false, position: 4 });
  const songFive = member({ title: "Bad Blood", isVideo: false, position: 5 });
  const videoOne = member({ title: "Pompeii", isVideo: true, position: 6, videoVariant: "official" });
  const videoFive = member({ title: "Bad Blood", isVideo: true, position: 7, videoVariant: "official" });

  const relations = deriveVideoRelationsFromEdition([
    songOne, songTwo, songThree, songFour, songFive, videoOne, videoFive,
  ]);

  assert.deepEqual(
    relations.map((relation) => [relation.videoRecordingId, relation.audioRecordingId]),
    [
      [videoOne.recordingId, songOne.recordingId],
      [videoFive.recordingId, songFive.recordingId],
    ],
  );
});

test("a shared ISRC outranks title matching", () => {
  const decoy = member({ title: "Pompeii", isVideo: false, position: 1, isrcs: ["GBARL1300001"] });
  const real = member({ title: "Pompeii (radio edit)", isVideo: false, position: 2, isrcs: ["GBARL1300099"] });
  const video = member({
    title: "Pompeii", isVideo: true, position: 3, isrcs: ["GBARL1300099"],
  });

  const [relation] = deriveVideoRelationsFromEdition([decoy, real, video]);
  assert.equal(relation.audioRecordingId, real.recordingId);
  assert.equal(relation.method, "canonical-edition-isrc");
  assert.ok(relation.confidence > 0.95);
});

test("marketing wrappers are stripped before titles are compared", () => {
  const audio = member({ title: "Oblivion", isVideo: false, position: 1 });
  const video = member({
    title: "Oblivion (Official Music Video)", isVideo: true, position: 2, videoVariant: "official",
  });

  const [relation] = deriveVideoRelationsFromEdition([audio, video]);
  assert.equal(relation.audioRecordingId, audio.recordingId);
});

test("a live video does not take a studio track sharing the release", () => {
  // A release carrying both the studio cut and a live cut of one song, plus a
  // video of the live performance. Title alone would match either.
  const studio = member({ title: "Tunnel of Love", isVideo: false, position: 1 });
  const live = member({ title: "Tunnel of Love (live)", isVideo: false, position: 2 });
  const liveVideo = member({
    title: "Tunnel of Love (live)", isVideo: true, position: 3, videoVariant: "live",
  });

  const [relation] = deriveVideoRelationsFromEdition([studio, live, liveVideo]);
  assert.equal(relation.audioRecordingId, live.recordingId);
  assert.notEqual(relation.audioRecordingId, studio.recordingId);
});

test("an ordinary video does not take a live track sharing the release", () => {
  const studio = member({ title: "Tunnel of Love", isVideo: false, position: 1 });
  const live = member({ title: "Tunnel of Love (live)", isVideo: false, position: 2 });
  const studioVideo = member({
    title: "Tunnel of Love", isVideo: true, position: 3, videoVariant: "official",
  });

  const [relation] = deriveVideoRelationsFromEdition([studio, live, studioVideo]);
  assert.equal(relation.audioRecordingId, studio.recordingId);
});

test("a duration far from every candidate links to none of them", () => {
  const audio = member({ title: "Pompeii", isVideo: false, position: 1, lengthMs: 214_000 });
  const video = member({
    title: "Pompeii", isVideo: true, position: 2, lengthMs: 620_000, videoVariant: "official",
  });

  assert.deepEqual(deriveVideoRelationsFromEdition([audio, video]), []);
});

test("an identical title on a different recording is not enough on its own", () => {
  // Two distinct recordings of one song on one release, both plain-titled: the
  // video could be of either, so it is left unlinked rather than guessed.
  const first = member({ title: "Pompeii", isVideo: false, position: 1 });
  const second = member({ title: "Pompeii", isVideo: false, position: 2 });
  const video = member({ title: "Pompeii", isVideo: true, position: 3, videoVariant: "official" });

  assert.deepEqual(deriveVideoRelationsFromEdition([first, second, video]), []);
});

test("the same recording appearing twice is not an ambiguity", () => {
  const recordingId = 4242;
  const first = member({ title: "Pompeii", isVideo: false, position: 1, recordingId });
  const second = member({ title: "Pompeii", isVideo: false, position: 9, recordingId });
  const video = member({ title: "Pompeii", isVideo: true, position: 10, videoVariant: "official" });

  const [relation] = deriveVideoRelationsFromEdition([first, second, video]);
  assert.equal(relation.audioRecordingId, recordingId);
});

test("several videos of one recording each get their own relation", () => {
  const audio = member({ title: "Pompeii", isVideo: false, position: 1 });
  const official = member({ title: "Pompeii", isVideo: true, position: 2, videoVariant: "official" });
  const lyric = member({ title: "Pompeii (Lyric Video)", isVideo: true, position: 3, videoVariant: "lyric" });

  const relations = deriveVideoRelationsFromEdition([audio, official, lyric]);
  assert.deepEqual(
    relations.map((relation) => relation.videoRecordingId).sort((a, b) => a - b),
    [official.recordingId, lyric.recordingId].sort((a, b) => a - b),
  );
  assert.ok(relations.every((relation) => relation.audioRecordingId === audio.recordingId));
});

test("an edition with no video members yields nothing", () => {
  assert.deepEqual(
    deriveVideoRelationsFromEdition([
      member({ title: "Pompeii", isVideo: false }),
      member({ title: "Flaws", isVideo: false }),
    ]),
    [],
  );
});
