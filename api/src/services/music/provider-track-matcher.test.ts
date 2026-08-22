import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assignRankedTrackMatches,
  scoreTrackMatch,
  isTrackMatch,
  TRACK_MATCH_THRESHOLD,
  type MatchTargetTrack,
  type MatchProviderTrack,
} from "./provider-track-matcher.js";

function target(over: Partial<MatchTargetTrack> = {}): MatchTargetTrack {
  return { recordingMbid: null, isrcs: new Set(), title: "Bad Blood", trackNumber: 3, volumeNumber: 1, durationSec: 200, ...over };
}
function provider(over: Partial<MatchProviderTrack> = {}): MatchProviderTrack {
  return { mbid: null, isrc: null, title: "Bad Blood", trackNumber: 3, volumeNumber: 1, durationSec: 200, ...over };
}

test("ranked assignment finds full one-to-one coverage without reusing a source", () => {
  const sourceA = { id: "a" };
  const sourceB = { id: "b" };
  const assignments = assignRankedTrackMatches([
    [
      { sourceKey: "a", source: sourceA, matchScore: 0.95 },
      { sourceKey: "b", source: sourceB, matchScore: 0.9 },
    ],
    [
      { sourceKey: "a", source: sourceA, matchScore: 1 },
    ],
  ]);

  assert.equal(assignments.size, 2);
  assert.equal(assignments.get(0)?.sourceKey, "b");
  assert.equal(assignments.get(1)?.sourceKey, "a");
  assert.equal(new Set([...assignments.values()].map((edge) => edge.sourceKey)).size, 2);
});

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

test("commentary track does not match same-slot song with a large duration gap", () => {
  // Bakermat "The Spirit (Track by Track)": pos 1 is a 47s commentary clip;
  // the standard album's pos 1 is the 136s song. Base titles agree and slots
  // align, but duration must reject the false medium_position_duration cover.
  const s = scoreTrackMatch(
    target({ title: "The Spirit (commentary)", trackNumber: 1, durationSec: 47 }),
    provider({ title: "The Spirit", trackNumber: 1, durationSec: 136 }),
  );
  assert.ok(s < TRACK_MATCH_THRESHOLD, `commentary must not match song, got ${s}`);
});

test("commentary matches the same-slot commentary when duration is close", () => {
  const s = scoreTrackMatch(
    target({ title: "The Spirit (commentary)", trackNumber: 1, durationSec: 47 }),
    provider({ title: "The Spirit", trackNumber: 1, durationSec: 46 }),
  );
  // One-sided "commentary" qualifier + position + duration → structural OK.
  assert.ok(s >= 0.9, `commentary should match short slot peer, got ${s}`);
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

test("same-release superset context permits a flattened version title at a shifted position", () => {
  const canonical = target({
    title: "Reality (Dave Winnel remix)",
    trackNumber: 1,
    durationSec: 245,
  });
  const flattened = provider({
    title: "Reality",
    trackNumber: 11,
    durationSec: 245,
  });

  assert.ok(scoreTrackMatch(canonical, flattened) < TRACK_MATCH_THRESHOLD);
  assert.equal(
    scoreTrackMatch(canonical, flattened, {
      allowSameReleaseSupersetPositionMismatch: true,
    }),
    0.94,
  );
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

test("a dash-suffixed live qualifier matches its provider track on structure", () => {
  // MusicBrainz writes live/session performances two ways and only the
  // parenthesised form was understood, so the whole " - ARTE Live at …" suffix
  // stayed in the base title and could never compare equal to the provider's
  // plain title. On "&" (Ampersand), Part Four three tracks went unmatched
  // despite agreeing with the provider on position AND duration to the second,
  // while a fourth scraped in on raw string similarity purely because its title
  // was longer - the outcome was decided by title length.
  for (const [canonical, provided, seconds, position] of [
    ["Good Grief - ARTE Live at Turner Contemporary", "Good Grief", 261, 5],
    ["Eve & Paradise Lost - ARTE Live at Turner Contemporary", "Eve & Paradise Lost", 269, 6],
    ["Leonard & Marianne - ARTE Live at Turner Contemporary", "Leonard & Marianne", 233, 7],
  ] as const) {
    const score = scoreTrackMatch(
      target({ title: canonical, trackNumber: position, durationSec: seconds }),
      provider({ title: provided, trackNumber: position, durationSec: seconds }),
    );
    assert.ok(score >= TRACK_MATCH_THRESHOLD, `${canonical} should match its provider track, got ${score}`);
  }
});

test("an ordinary dash in a title is not read as a version qualifier", () => {
  assert.ok(isTrackMatch(
    target({ title: "Mother - Daughter", trackNumber: 3, durationSec: 200 }),
    provider({ title: "Mother - Daughter", trackNumber: 3, durationSec: 200 }),
  ));
});

test("a title-similar track with a grossly different runtime is not a match", () => {
  // The Japanese Frank release lists "Amy Amy Amy" (4:15) at position 13 where
  // the canonical edition has the combined "Amy Amy Amy / Outro" (13:17). Every
  // other path requires the runtimes to agree; the title-dominant fallback only
  // gave duration a bonus, so a near-identical title outvoted nine minutes of
  // missing content and the wrong provider track was assigned.
  const score = scoreTrackMatch(
    target({ title: "Amy Amy Amy / Outro", trackNumber: 13, durationSec: 797 }),
    provider({ title: "Amy Amy Amy", trackNumber: 13, durationSec: 255 }),
  );
  assert.ok(score < TRACK_MATCH_THRESHOLD, `a 9-minute gap must not match, got ${score}`);
});

test("the combined track still matches the provider track that actually contains it", () => {
  // The UK deluxe release does have the combined 13:17 track; that is the one
  // the canonical edition should source from.
  assert.ok(isTrackMatch(
    target({ title: "Amy Amy Amy / Outro", trackNumber: 13, durationSec: 797 }),
    provider({ title: "Amy Amy Amy / Outro", trackNumber: 13, durationSec: 797 }),
  ));
});

test("live at and live from the same venue are one recording, including an extra acoustic tag", () => {
  // Bad Blood X disc 2: MusicBrainz "Pompeii (live from Studio Brussel)" vs
  // Apple "Pompeii (Live At Studio Brussel / Acoustic)". Positions also differ
  // because Apple put Pompeii MMXXIII on disc 2.
  const score = scoreTrackMatch(
    target({
      title: "Pompeii (live from Studio Brussel)",
      trackNumber: 6,
      volumeNumber: 2,
      durationSec: 199.8,
    }),
    provider({
      title: "Pompeii (Live At Studio Brussel / Acoustic)",
      trackNumber: 7,
      volumeNumber: 2,
      durationSec: 200,
    }),
  );
  assert.ok(score >= 0.9, `Studio Brussel live/acoustic should match, got ${score}`);
});

test("a differently named demo of the same recording matches via an alternate title", () => {
  const canonical = target({
    title: "Laura Palmer (Dan’s Bedroom demo)",
    trackNumber: 8,
    volumeNumber: 2,
    durationSec: 179.88,
  });
  const apple = provider({
    title: "Laura Palmer (Racing Heart Demo)",
    trackNumber: 9,
    volumeNumber: 2,
    durationSec: 180,
  });
  assert.ok(
    scoreTrackMatch(canonical, apple) < TRACK_MATCH_THRESHOLD,
    "Dan's Bedroom vs Racing Heart is not the same name",
  );
  const score = scoreTrackMatch(
    {
      ...canonical,
      alternateTitles: ["Laura Palmer (Racing Heart demo)"],
    },
    apple,
  );
  assert.ok(score >= 0.9, `sibling Racing Heart title should cover the Apple track, got ${score}`);
});
