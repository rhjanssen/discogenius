import assert from "node:assert/strict";
import test from "node:test";
import {
  candidateFitsTrack,
  compareInlineCandidates,
  comparePlacementCandidates,
  curateLibraryVideos,
  type InlinePlacementCandidate,
  type VideoCandidate,
} from "./video-curation.js";

const AUDIO = 100;
const OTHER_AUDIO = 200;

function candidate(overrides: Partial<VideoCandidate> & Pick<VideoCandidate, "videoRecordingId">): VideoCandidate {
  return {
    canonicalType: "video",
    audioRecordingId: AUDIO,
    relationConfidence: 0.9,
    relationAccepted: false,
    directEditionIds: new Set<number>(),
    providerAvailable: true,
    providerQualityRank: 1,
    manuallySelected: false,
    ...overrides,
  };
}

function placement(
  overrides: Partial<InlinePlacementCandidate> & Pick<InlinePlacementCandidate, "trackId">,
): InlinePlacementCandidate {
  return {
    editionId: 10,
    releaseGroupId: 1,
    audioRecordingId: AUDIO,
    placementLibraryId: 1,
    releaseKind: "studio",
    editionTrackCount: 12,
    representative: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

test("a video fits a track it is a video of, or one on an edition it belongs to", () => {
  const track = placement({ trackId: 1 });
  assert.equal(candidateFitsTrack(candidate({ videoRecordingId: 1 }), track), true);
  assert.equal(
    candidateFitsTrack(candidate({ videoRecordingId: 2, audioRecordingId: OTHER_AUDIO }), track),
    false,
    "a different performance is not a fit",
  );
  assert.equal(
    candidateFitsTrack(
      candidate({ videoRecordingId: 3, audioRecordingId: null, directEditionIds: new Set([10]) }),
      track,
    ),
    true,
    "direct canonical membership qualifies without a relation",
  );
});

// ---------------------------------------------------------------------------
// §13 winner ranking
// ---------------------------------------------------------------------------

test("an exact recording relation beats provider quality outright", () => {
  const track = placement({ trackId: 1 });
  const exact = candidate({ videoRecordingId: 1, providerQualityRank: 9 });
  const merelyOnEdition = candidate({
    videoRecordingId: 2,
    audioRecordingId: null,
    directEditionIds: new Set([10]),
    providerQualityRank: 0,
  });
  assert.ok(compareInlineCandidates(exact, merelyOnEdition, track) < 0);
});

test("an accepted relation beats an inferred one of equal confidence", () => {
  const track = placement({ trackId: 1 });
  const accepted = candidate({ videoRecordingId: 5, relationAccepted: true });
  const inferred = candidate({ videoRecordingId: 2, relationAccepted: false });
  assert.ok(compareInlineCandidates(accepted, inferred, track) < 0,
    "even with a higher id, the accepted relation wins");
});

test("confidence, then availability, then quality, then id break the tie", () => {
  const track = placement({ trackId: 1 });
  assert.ok(compareInlineCandidates(
    candidate({ videoRecordingId: 9, relationConfidence: 0.99 }),
    candidate({ videoRecordingId: 1, relationConfidence: 0.8 }),
    track,
  ) < 0);
  assert.ok(compareInlineCandidates(
    candidate({ videoRecordingId: 9, providerAvailable: true }),
    candidate({ videoRecordingId: 1, providerAvailable: false }),
    track,
  ) < 0);
  assert.ok(compareInlineCandidates(
    candidate({ videoRecordingId: 9, providerQualityRank: 0 }),
    candidate({ videoRecordingId: 1, providerQualityRank: 5 }),
    track,
  ) < 0);
  assert.ok(compareInlineCandidates(
    candidate({ videoRecordingId: 1 }),
    candidate({ videoRecordingId: 9 }),
    track,
  ) < 0, "ties are broken deterministically by id");
});

test("beside a live track a live video outranks an official one", () => {
  const liveTrack = placement({ trackId: 1, releaseKind: "live" });
  const live = candidate({ videoRecordingId: 9, canonicalType: "live" });
  const official = candidate({ videoRecordingId: 1, canonicalType: "video" });
  assert.ok(compareInlineCandidates(live, official, liveTrack) < 0);
  // ...and beside a studio track the ordinary video wins instead.
  const studioTrack = placement({ trackId: 2, releaseKind: "studio" });
  assert.ok(compareInlineCandidates(official, live, studioTrack) < 0);
});

// ---------------------------------------------------------------------------
// §14 placement ranking
// ---------------------------------------------------------------------------

test("a natural studio album beats a larger compilation", () => {
  const video = candidate({ videoRecordingId: 1 });
  const studio = placement({ trackId: 1, editionId: 10, releaseKind: "studio", editionTrackCount: 12 });
  const compilation = placement({
    trackId: 2, editionId: 20, releaseKind: "compilation", editionTrackCount: 40,
  });
  assert.ok(comparePlacementCandidates(video, studio, compilation) < 0,
    "size is a tie-break, not a lead criterion");
});

test("an exact live video prefers the live release over the studio one", () => {
  const liveVideo = candidate({ videoRecordingId: 1, canonicalType: "live" });
  const live = placement({ trackId: 1, editionId: 10, releaseKind: "live", editionTrackCount: 9 });
  const studio = placement({ trackId: 2, editionId: 20, releaseKind: "studio", editionTrackCount: 30 });
  assert.ok(comparePlacementCandidates(liveVideo, live, studio) < 0);
});

test("direct canonical membership beats every other placement signal", () => {
  const video = candidate({ videoRecordingId: 1, directEditionIds: new Set([20]) });
  const bigStudio = placement({ trackId: 1, editionId: 10, releaseKind: "studio", editionTrackCount: 40 });
  const memberEdition = placement({
    trackId: 2, editionId: 20, releaseKind: "compilation", editionTrackCount: 3, representative: false,
  });
  assert.ok(comparePlacementCandidates(video, memberEdition, bigStudio) < 0);
});

test("within equal context the larger, then representative, edition wins", () => {
  const video = candidate({ videoRecordingId: 1 });
  const large = placement({ trackId: 1, editionId: 11, editionTrackCount: 30, representative: false });
  const small = placement({ trackId: 2, editionId: 12, editionTrackCount: 12, representative: true });
  assert.ok(comparePlacementCandidates(video, large, small) < 0);

  const repEdition = placement({ trackId: 3, editionId: 13, editionTrackCount: 30, representative: true });
  assert.ok(comparePlacementCandidates(video, repEdition, large) < 0);
});

// ---------------------------------------------------------------------------
// Layout modes
// ---------------------------------------------------------------------------

const officialVideo = candidate({ videoRecordingId: 1, canonicalType: "video" });
const liveVideo = candidate({ videoRecordingId: 2, canonicalType: "live" });
const lyricVideo = candidate({ videoRecordingId: 3, canonicalType: "lyrics" });
const studioTrack = placement({ trackId: 500, releaseKind: "studio" });

test("separated stores every eligible video in the video library", () => {
  const result = curateLibraryVideos({
    layout: "separated",
    candidates: [officialVideo, liveVideo, lyricVideo],
    placementCandidates: [studioTrack],
  });
  assert.equal(result.selected.length, 3);
  assert.ok(result.selected.every((decision) => decision.placement.mode === "separated"));
  assert.deepEqual(result.unselected, []);
});

test("inline gives one regular and one lyrics winner; the rest stay separated", () => {
  const result = curateLibraryVideos({
    layout: "inline",
    candidates: [officialVideo, liveVideo, lyricVideo],
    placementCandidates: [studioTrack],
  });

  const inline = result.selected.filter((decision) => decision.placement.mode === "inline");
  assert.equal(inline.length, 2, "one video slot, one lyrics slot");
  const slots = inline.map((decision) =>
    decision.placement.mode === "inline" ? decision.placement.inlineSlot : null).sort();
  assert.deepEqual(slots, ["lyrics", "video"]);

  // Official and live contend for the same slot beside a studio track, and the
  // ordinary video wins there.
  const videoSlotWinner = inline.find((decision) =>
    decision.placement.mode === "inline" && decision.placement.inlineSlot === "video");
  assert.equal(videoSlotWinner?.videoRecordingId, officialVideo.videoRecordingId);

  // The loser is still selected — just stored separately, never both.
  const loser = result.selected.find((decision) =>
    decision.videoRecordingId === liveVideo.videoRecordingId);
  assert.equal(loser?.placement.mode, "separated");
  assert.deepEqual(result.unselected, []);
});

test("a live candidate wins the regular slot beside a live track", () => {
  const liveTrack = placement({ trackId: 600, releaseKind: "live" });
  const result = curateLibraryVideos({
    layout: "inline",
    candidates: [officialVideo, liveVideo],
    placementCandidates: [liveTrack],
  });
  const winner = result.selected.find((decision) => decision.placement.mode === "inline");
  assert.equal(winner?.videoRecordingId, liveVideo.videoRecordingId);
});

test("inline_only selects the winners and leaves the losers unmonitored", () => {
  const result = curateLibraryVideos({
    layout: "inline_only",
    candidates: [officialVideo, liveVideo, lyricVideo],
    placementCandidates: [studioTrack],
  });

  assert.deepEqual(
    result.selected.map((decision) => decision.videoRecordingId).sort((a, b) => a - b),
    [officialVideo.videoRecordingId, lyricVideo.videoRecordingId].sort((a, b) => a - b),
  );
  assert.ok(result.selected.every((decision) => decision.placement.mode === "inline"));
  assert.deepEqual(result.unselected, [liveVideo.videoRecordingId],
    "the losing candidate stays visible, unmonitored and undownloaded");
});

test("inline_only keeps a manual selection that fits nowhere", () => {
  // A video of a different performance entirely: no track to sit beside, so
  // automation would drop it. The user asked for it, so it is kept — stored
  // separately, because there is no slot for it.
  const manualUnrelated = candidate({
    videoRecordingId: 2,
    canonicalType: "live",
    audioRecordingId: OTHER_AUDIO,
    manuallySelected: true,
  });
  const automaticUnrelated = candidate({
    videoRecordingId: 4, audioRecordingId: OTHER_AUDIO,
  });
  const result = curateLibraryVideos({
    layout: "inline_only",
    candidates: [officialVideo, manualUnrelated, automaticUnrelated],
    placementCandidates: [studioTrack],
  });

  const manual = result.selected.find((decision) => decision.videoRecordingId === 2);
  assert.equal(manual?.placement.mode, "separated");
  assert.deepEqual(result.unselected, [automaticUnrelated.videoRecordingId],
    "the automatic one with nowhere to go is left unmonitored; the manual one is not");
});

test("a manual selection takes the slot from an automatic candidate", () => {
  const manualLive = candidate({
    videoRecordingId: 2, canonicalType: "live", manuallySelected: true,
  });
  const result = curateLibraryVideos({
    layout: "inline",
    candidates: [officialVideo, manualLive],
    placementCandidates: [studioTrack],
  });
  const inline = result.selected.find((decision) => decision.placement.mode === "inline");
  assert.equal(inline?.videoRecordingId, manualLive.videoRecordingId,
    "the user's choice occupies the slot the automatic candidate would have won");
});

test("a video with nowhere to sit is separated under inline, not lost", () => {
  const unrelated = candidate({ videoRecordingId: 7, audioRecordingId: OTHER_AUDIO });
  const result = curateLibraryVideos({
    layout: "inline",
    candidates: [unrelated],
    placementCandidates: [studioTrack],
  });
  assert.equal(result.selected.length, 1);
  assert.equal(result.selected[0]?.placement.mode, "separated");
});

test("no video is ever both inline and separated", () => {
  const result = curateLibraryVideos({
    layout: "inline",
    candidates: [officialVideo, liveVideo, lyricVideo],
    placementCandidates: [studioTrack, placement({ trackId: 501, editionId: 11 })],
  });
  const byVideo = new Map<number, string[]>();
  for (const decision of result.selected) {
    byVideo.set(decision.videoRecordingId, [
      ...(byVideo.get(decision.videoRecordingId) || []),
      decision.placement.mode,
    ]);
  }
  assert.ok([...byVideo.values()].every((modes) => modes.length === 1));
});

test("two tracks each get their own pair of winners", () => {
  const secondAudio = 300;
  const trackOne = placement({ trackId: 1, audioRecordingId: AUDIO });
  const trackTwo = placement({ trackId: 2, editionId: 11, audioRecordingId: secondAudio });
  const result = curateLibraryVideos({
    layout: "inline",
    candidates: [
      candidate({ videoRecordingId: 1, canonicalType: "video", audioRecordingId: AUDIO }),
      candidate({ videoRecordingId: 2, canonicalType: "lyrics", audioRecordingId: AUDIO }),
      candidate({ videoRecordingId: 3, canonicalType: "video", audioRecordingId: secondAudio }),
      candidate({ videoRecordingId: 4, canonicalType: "lyrics", audioRecordingId: secondAudio }),
    ],
    placementCandidates: [trackOne, trackTwo],
  });
  const inline = result.selected.filter((decision) => decision.placement.mode === "inline");
  assert.equal(inline.length, 4);
  const keys = inline.map((decision) =>
    decision.placement.mode === "inline"
      ? `${decision.placement.inlineTrackId}:${decision.placement.inlineSlot}`
      : "").sort();
  assert.deepEqual(keys, ["1:lyrics", "1:video", "2:lyrics", "2:video"]);
});
