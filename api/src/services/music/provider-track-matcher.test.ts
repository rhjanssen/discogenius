import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreTrackMatch, isTrackMatch, TRACK_MATCH_THRESHOLD, type MatchTargetTrack, type MatchProviderTrack } from "./provider-track-matcher.js";

function target(over: Partial<MatchTargetTrack> = {}): MatchTargetTrack {
  return { recordingMbid: null, isrcs: new Set(), title: "Bad Blood", trackNumber: 3, volumeNumber: 1, durationSec: 200, ...over };
}
function provider(over: Partial<MatchProviderTrack> = {}): MatchProviderTrack {
  return { mbid: null, isrc: null, title: "Bad Blood", trackNumber: 3, volumeNumber: 1, durationSec: 200, ...over };
}

test("recording MBID match wins outright", () => {
  assert.equal(scoreTrackMatch(target({ recordingMbid: "rec-1" }), provider({ mbid: "rec-1", title: "totally different" })), 1.0);
});

test("ISRC match wins outright", () => {
  assert.equal(scoreTrackMatch(target({ isrcs: new Set(["GBUM71405337"]) }), provider({ isrc: "GBUM71405337", title: "x" })), 1.0);
});

test("provider 'VS.' / featuring decoration does not break a same-position match", () => {
  // The 0.72-string-cutoff bug: TIDAL adds '(Bastille Vs. ...)' to the title.
  const s = scoreTrackMatch(
    target({ title: "Bad Blood" }),
    provider({ title: "Bad Blood (Bastille Vs. Other People's Heartache, Pt. III)" }),
  );
  assert.ok(s >= 0.9, `expected strong match, got ${s}`);
});

test("MusicBrainz parenthetical qualifier the provider omits still matches", () => {
  // MB: "Haunt (demo)" vs provider plain "Haunt", same slot + duration.
  assert.ok(isTrackMatch(target({ title: "Haunt (demo)", durationSec: 180 }), provider({ title: "Haunt", durationSec: 182 })));
});

test("same position + close duration matches when the base title still agrees", () => {
  // Structural streaming metadata is reliable; titles can carry cosmetic
  // parentheticals that baseComparableTitle strips.
  const s = scoreTrackMatch(target({ title: "Intro", durationSec: 210 }), provider({ title: "Intro (Feel The Positive Flow)", durationSec: 213 }));
  assert.ok(s >= 0.9, `got ${s}`);
});

test("two genuinely different songs at the same position with a coincidental duration do NOT match", () => {
  // Guard against false coverage when combining releases.
  const s = scoreTrackMatch(
    target({ title: "Pompeii", trackNumber: 1, durationSec: 210 }),
    provider({ title: "Quarter Past Midnight", trackNumber: 1, durationSec: 211 }),
  );
  assert.ok(s < TRACK_MATCH_THRESHOLD, `expected no match, got ${s}`);
});

test("World Gone Mad does not match Distorted Light Beam on position+duration alone", () => {
  // Bastille: two different 1-track singles, both track #1, durations within the
  // 10s grace (195 vs 186). Levenshtein similarity is exactly 0.3 — enough to
  // clear the old structural guard and mark a verified HIRES cover of the wrong
  // MusicBrainz release group.
  const s = scoreTrackMatch(
    target({
      title: "World Gone Mad",
      trackNumber: 1,
      volumeNumber: 1,
      durationSec: 195,
      isrcs: new Set(["USAT21704727"]),
      recordingMbid: "e78b4529-83ff-45d3-abad-f77d90551368",
    }),
    provider({
      title: "Distorted Light Beam",
      trackNumber: 1,
      volumeNumber: 1,
      durationSec: 186,
      isrc: "GBUM72104671",
      mbid: "a38a4da7-4657-4c33-a4df-0a8f9b92b548",
    }),
  );
  assert.ok(s < TRACK_MATCH_THRESHOLD, `expected no match, got ${s}`);
});

test("a remix does not match a radio-edit recording at the same position (version-aware)", () => {
  // Bakermat "One Day (Vandaag)": the remix single and the radio edit share a
  // base title and track slot. In Servarr mode there is no UPC to separate them,
  // so the track matcher must: conflicting significant versions are not the same
  // recording.
  const s = scoreTrackMatch(
    target({ title: "One Day (Vandaag) (radio edit)", trackNumber: 1, durationSec: 200 }),
    provider({ title: "One Day (Vandaag) (Oliver $ & Matthew K Remix)", trackNumber: 1, durationSec: 260 }),
  );
  assert.ok(s < TRACK_MATCH_THRESHOLD, `remix should not match radio edit, got ${s}`);
});

test("a matching significant version still matches (radio edit vs radio edit)", () => {
  const s = scoreTrackMatch(
    target({ title: "One Day (Vandaag) (radio edit)", trackNumber: 1, durationSec: 200 }),
    provider({ title: "One Day (Vandaag) (Radio Edit)", trackNumber: 1, durationSec: 201 }),
  );
  assert.ok(s >= 0.9, `radio edit should match radio edit, got ${s}`);
});

test("a plain provider title still matches a versioned recording (one-sided qualifier)", () => {
  // The provider omits the "(radio edit)" qualifier the MB recording carries —
  // a one-sided qualifier must stay compatible, not block the match.
  const s = scoreTrackMatch(
    target({ title: "One Day (Vandaag) (radio edit)", trackNumber: 1, durationSec: 200 }),
    provider({ title: "One Day (Vandaag)", trackNumber: 1, durationSec: 201 }),
  );
  assert.ok(s >= 0.9, `plain title should match a versioned recording, got ${s}`);
});

test("base-title match with duration agreement matches across differing positions (combine case)", () => {
  // A standalone single (track 1) covering an album target at position 7.
  const s = scoreTrackMatch(
    target({ title: "Pompeii", trackNumber: 7, volumeNumber: 1, durationSec: 214 }),
    provider({ title: "Pompeii", trackNumber: 1, volumeNumber: 1, durationSec: 214 }),
  );
  assert.ok(s >= 0.9, `got ${s}`);
});

test("missing durations: same position + base title still matches", () => {
  assert.ok(isTrackMatch(
    target({ title: "Pompeii", durationSec: null }),
    provider({ title: "Pompeii", durationSec: null }),
  ));
});

test("weak title and no structural agreement falls below threshold", () => {
  const s = scoreTrackMatch(
    target({ title: "Song A", trackNumber: 2, durationSec: 200 }),
    provider({ title: "Completely Different", trackNumber: 9, durationSec: 320 }),
  );
  assert.ok(s < TRACK_MATCH_THRESHOLD, `got ${s}`);
});

test("a studio track does NOT cover a live-variant recording across positions (Amy Winehouse case)", () => {
  // Back to Black: the 11-track hi-res album's studio "Rehab" (vol 1 #1) was
  // assigned to "Rehab (live at Kalkscheune, Berlin)" (vol 3 #1) because live
  // cuts often share the studio runtime. A one-sided version claim needs the
  // SAME slot to count; combined-in tracks may not claim variants on duration.
  const s = scoreTrackMatch(
    target({ title: "Rehab (live at Kalkscheune, Berlin)", trackNumber: 1, volumeNumber: 3, durationSec: 213 }),
    provider({ title: "Rehab", trackNumber: 1, volumeNumber: 1, durationSec: 213 }),
  );
  assert.ok(s < TRACK_MATCH_THRESHOLD, `studio track must not cover the live recording, got ${s}`);
});

test("a one-sided variant at the SAME slot with close duration still matches (Haunt demo shape)", () => {
  const s = scoreTrackMatch(
    target({ title: "Rehab (live at Kalkscheune, Berlin)", trackNumber: 1, volumeNumber: 3, durationSec: 213 }),
    provider({ title: "Rehab", trackNumber: 1, volumeNumber: 3, durationSec: 213 }),
  );
  assert.ok(s >= 0.9, `same-slot one-sided qualifier should match, got ${s}`);
});

test("elaborated qualifiers describe the same variant (demo vs original demo)", () => {
  const s = scoreTrackMatch(
    target({ title: "Love Is a Losing Game (original demo)", trackNumber: 7, volumeNumber: 2, durationSec: 154 }),
    provider({ title: "Love Is A Losing Game (Demo)", trackNumber: 7, volumeNumber: 2, durationSec: 155 }),
  );
  assert.ok(s >= 0.9, `demo vs original demo should be compatible, got ${s}`);
});

test("distinct live venues are different recordings", () => {
  const s = scoreTrackMatch(
    target({ title: "Rehab (live at Kalkscheune, Berlin)", trackNumber: 1, durationSec: 213 }),
    provider({ title: "Rehab (Live At BBC Radio 1)", trackNumber: 1, durationSec: 213 }),
  );
  assert.ok(s < TRACK_MATCH_THRESHOLD, `different venues must not match, got ${s}`);
});
