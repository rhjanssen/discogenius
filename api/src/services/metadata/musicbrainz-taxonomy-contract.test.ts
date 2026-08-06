/**
 * Every value MusicBrainz can put in these three fields must have a switch.
 *
 * The taxonomies are closed sets read from the corpus, not guesses: 5 primary
 * Release Group types, 12 secondary types, 7 release statuses. Anything without
 * a config key was previously rejected with a reason the user could neither see
 * nor change, so these tests enumerate the *whole* vocabulary rather than
 * sampling it — a missing key is a silent content deletion.
 *
 * Counts in comments are corpus-wide (39.4M recordings, 5.6M releases).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG, type FilteringConfig } from "../config/config.js";
import {
  getMusicBrainzReleaseGroupIncludeDecision,
  getReleaseStatusIncludeDecision,
  isMusicBrainzReleaseGroupIncluded,
  isReleaseStatusIncluded,
  normalizeMusicBrainzType,
} from "./musicbrainz-release-group-filter.js";

/** MusicBrainz's complete primary vocabulary, with corpus Release Group counts. */
const PRIMARY_TYPES = [
  ["Album", "include_album", 2278381],
  ["Single", "include_single", 1355220],
  ["EP", "include_ep", 563504],
  ["Other", "include_other", 62655],
  ["Broadcast", "include_broadcast", 26573],
] as const;

/** MusicBrainz's complete secondary vocabulary. */
const SECONDARY_TYPES = [
  ["Compilation", "include_compilation", 486796],
  ["Live", "include_live", 154884],
  ["Soundtrack", "include_soundtrack", 93327],
  ["Remix", "include_remix", 74533],
  ["Demo", "include_demo", 36659],
  ["DJ-mix", "include_dj_mix", 33225],
  ["Audiobook", "include_audiobook", 18987],
  ["Mixtape/Street", "include_mixtape_street", 17940],
  ["Spokenword", "include_spokenword", 17636],
  ["Audio drama", "include_audio_drama", 16111],
  ["Interview", "include_interview", 3735],
  ["Field recording", "include_field_recording", 861],
] as const;

/** MusicBrainz's complete status vocabulary, with corpus Release counts. */
const RELEASE_STATUSES = [
  ["Official", "include_status_official", 5082652],
  ["Promotion", "include_status_promotion", 117616],
  ["Bootleg", "include_status_bootleg", 98022],
  ["Pseudo-Release", "include_status_pseudo_release", 25610],
  ["Withdrawn", "include_status_withdrawn", 10806],
  ["Cancelled", "include_status_cancelled", 559],
  ["Expunged", "include_status_expunged", 333],
] as const;

/** The secondary types that are music, and so ship on. */
const MUSIC_SECONDARY_KEYS = new Set([
  "include_compilation", "include_live", "include_soundtrack", "include_remix",
  "include_demo", "include_dj_mix", "include_mixtape_street",
]);

const ALL_ON: FilteringConfig = new Proxy({} as FilteringConfig, {
  get: (_target, key) => (String(key).startsWith("include_") ? true : undefined),
});

function configWith(overrides: Partial<Record<string, boolean>>): FilteringConfig {
  return new Proxy({} as FilteringConfig, {
    get: (_target, key) => {
      const name = String(key);
      if (name in overrides) return overrides[name];
      return name.startsWith("include_") ? true : undefined;
    },
  });
}

/* ── Every value is reachable ───────────────────────────────────────── */

test("every primary type has a switch that actually gates it", () => {
  for (const [type, key] of PRIMARY_TYPES) {
    assert.equal(
      isMusicBrainzReleaseGroupIncluded({ primary_type: type }, ALL_ON), true,
      `${type} must be included when its switch is on`,
    );
    const decision = getMusicBrainzReleaseGroupIncludeDecision(
      { primary_type: type }, configWith({ [key]: false }),
    );
    assert.equal(decision.include, false, `${type} must be excluded when its switch is off`);
    assert.match(String(decision.reason), /_excluded$/, `${type} must say why`);
  }
});

test("every secondary type has a switch that actually gates it", () => {
  for (const [type, key] of SECONDARY_TYPES) {
    assert.equal(
      isMusicBrainzReleaseGroupIncluded({ primary_type: "Album", secondary_types: [type] }, ALL_ON),
      true, `${type} must be included when its switch is on`,
    );
    const decision = getMusicBrainzReleaseGroupIncludeDecision(
      { primary_type: "Album", secondary_types: [type] }, configWith({ [key]: false }),
    );
    assert.equal(decision.include, false, `${type} must be excluded when its switch is off`);
    assert.match(String(decision.reason), /_excluded$/, `${type} must say why`);
  }
});

test("every release status has a switch that actually gates it", () => {
  for (const [status, key] of RELEASE_STATUSES) {
    assert.equal(isReleaseStatusIncluded(status, ALL_ON), true, `${status} on`);
    const decision = getReleaseStatusIncludeDecision(status, configWith({ [key]: false }));
    assert.equal(decision.include, false, `${status} off`);
    assert.match(String(decision.reason), /_excluded$/, `${status} must say why`);
  }
});

test("no secondary type is rejected for having no config key", () => {
  // The bug this replaces: Spokenword, Interview, Audiobook, Audio drama and
  // Field recording fell through to an `_unsupported` rejection no user could
  // reach — 57,330 Release Groups excluded by omission rather than by choice.
  for (const [type] of SECONDARY_TYPES) {
    const decision = getMusicBrainzReleaseGroupIncludeDecision(
      { primary_type: "Album", secondary_types: [type] }, ALL_ON,
    );
    assert.equal(decision.include, true, type);
    assert.equal(decision.reason, null, type);
  }
});

/* ── Unknown is its own thing, not Other and not Album ──────────────── */

test("a Release Group with no primary type is not silently an Album", () => {
  // 99,535 Release Groups have no primary type. Calling them Albums admitted
  // them under a switch pointed at albums and hid the metadata gap.
  for (const missing of [null, undefined, "", "   "]) {
    const decision = getMusicBrainzReleaseGroupIncludeDecision(
      { primary_type: missing }, configWith({ include_unknown_type: false }),
    );
    assert.equal(decision.include, false, String(missing));
    assert.equal(decision.reason, "unset_primary_type_excluded");
  }
  // Turning albums off must not touch it, and vice versa.
  assert.equal(
    isMusicBrainzReleaseGroupIncluded({ primary_type: null }, configWith({ include_album: false })),
    true,
  );
  assert.equal(
    isMusicBrainzReleaseGroupIncluded({ primary_type: "Album" }, configWith({ include_unknown_type: false })),
    true,
  );
});

test("unset is not the same switch as MusicBrainz's own Other type", () => {
  assert.equal(
    isMusicBrainzReleaseGroupIncluded({ primary_type: "Other" }, configWith({ include_unknown_type: false })),
    true, "Other is a type an editor chose",
  );
  assert.equal(
    isMusicBrainzReleaseGroupIncluded({ primary_type: null }, configWith({ include_other: false })),
    true, "unset is not Other",
  );
});

test("a type this build does not recognise rides the unknown switch, not silence", () => {
  // If MusicBrainz adds a type, the content must not vanish without a trace.
  const primary = getMusicBrainzReleaseGroupIncludeDecision({ primary_type: "Hologram" }, ALL_ON);
  assert.equal(primary.include, true);
  const secondary = getMusicBrainzReleaseGroupIncludeDecision(
    { primary_type: "Album", secondary_types: ["Podcast"] }, ALL_ON,
  );
  assert.equal(secondary.include, true);
  assert.equal(
    getMusicBrainzReleaseGroupIncludeDecision(
      { primary_type: "Album", secondary_types: ["Podcast"] },
      configWith({ include_unknown_type: false }),
    ).reason,
    "podcast_unrecognized_excluded",
  );
});

/* ── No "studio / no secondary type" category ───────────────────────── */

test("a Release Group with no secondary type is judged on its primary type alone", () => {
  // Deliberate divergence from Lidarr, which models Studio as a secondary type.
  // A separate switch would let "Album on, Studio off" silently exclude every
  // plain studio album, a state with no legible meaning.
  for (const empty of [null, undefined, "", "[]", []]) {
    assert.equal(
      isMusicBrainzReleaseGroupIncluded({ primary_type: "Album", secondary_types: empty }, ALL_ON),
      true, String(empty),
    );
    assert.equal(
      isMusicBrainzReleaseGroupIncluded(
        { primary_type: "Album", secondary_types: empty }, configWith({ include_album: false }),
      ),
      false, String(empty),
    );
  }
});

/* ── Real shapes from the measured library ──────────────────────────── */

test("Bastille's discography classifies as the corpus says it does", () => {
  // Read from the local mirror. Other People's Heartache Pt. 1/2/4 and
  // VS. (Pt. III) are EP + Mixtape/Street — the factory defaults must keep them,
  // which is why Mixtape/Street ships on.
  const defaults = configWith({});
  for (const title of ["Other People's Heartache", "Other People's Heartache, Pt. 2"]) {
    assert.equal(
      isMusicBrainzReleaseGroupIncluded(
        { primary_type: "EP", secondary_types: ["Mixtape/Street"] }, defaults,
      ),
      true, title,
    );
  }
  // And the rest of the real shapes on that artist.
  const shapes: Array<[string, string[]]> = [
    ["Album", []],                    // Bad Blood, Doom Days, Give Me the Future
    ["Album", ["Live"]],              // MTV Unplugged – Live in London
    ["Album", ["Remix"]],             // Remixed
    ["Album", ["Compilation"]],       // Bad Blood / Haunt / Remixed
    ["Album", ["Soundtrack"]],        // KAOS
    ["EP", ["Live"]],                 // Live at KOKO
    ["Broadcast", ["Live"]],          // 2014-01-25: Saturday Night Live
    ["Single", ["Remix"]],            // Pompeii (Audien remix)
  ];
  for (const [primary, secondary] of shapes) {
    assert.equal(
      isMusicBrainzReleaseGroupIncluded(
        { primary_type: primary, secondary_types: secondary }, defaults,
      ),
      true, `${primary} + ${secondary.join("+") || "(none)"}`,
    );
  }
});

/* ── Spelling variants the two modes produce ────────────────────────── */

test("mode spelling differences normalize to one vocabulary", () => {
  // MB-local yields "Pseudo-Release" and "Mixtape/Street"; Servarr and older
  // payloads use underscores, spaces or collapsed forms.
  assert.equal(normalizeMusicBrainzType("Pseudo-Release"), "pseudo-release");
  assert.equal(normalizeMusicBrainzType("pseudo_release"), "pseudo-release");
  assert.equal(normalizeMusicBrainzType("PseudoRelease"), "pseudo-release");
  assert.equal(normalizeMusicBrainzType("Mixtape/Street"), "mixtape/street");
  assert.equal(normalizeMusicBrainzType("Mixtape"), "mixtape/street");
  assert.equal(normalizeMusicBrainzType("Spoken Word"), "spokenword");
  assert.equal(normalizeMusicBrainzType("Audio Drama"), "audio-drama");
  assert.equal(normalizeMusicBrainzType("Field Recording"), "field-recording");
  assert.equal(normalizeMusicBrainzType("DJ-mix"), "dj-mix");

  for (const spelling of ["Pseudo-Release", "pseudo_release", "PSEUDORELEASE"]) {
    assert.equal(
      isReleaseStatusIncluded(spelling, configWith({ include_status_pseudo_release: false })),
      false, spelling,
    );
  }
});

/* ── Status: unset and unrecognized ─────────────────────────────────── */

test("a release with no status is its own case, defaulting to eligible", () => {
  // 275,102 releases carry no status; dropping them is a silent coverage hole.
  for (const missing of [null, undefined, ""]) {
    assert.equal(isReleaseStatusIncluded(missing, ALL_ON), true, String(missing));
    assert.equal(
      isReleaseStatusIncluded(missing, configWith({ include_status_unknown: false })),
      false, String(missing),
    );
  }
  // Turning Official off must not take unset with it.
  assert.equal(isReleaseStatusIncluded(null, configWith({ include_status_official: false })), true);
});

/* ── The shipped defaults, asserted rather than restated ────────────── */

test("factory defaults curate a full discography, unlike Lidarr's stock profile", () => {
  // Lidarr ships Album + Studio + Official: an opt-in discography. Discogenius
  // aims at full coverage filtered down, so every type toggle ships on — and
  // Bastille's Other People's Heartache (EP + Mixtape/Street) is the concrete
  // case that would vanish if Mixtape/Street defaulted off.
  const factory = DEFAULT_CONFIG.filtering;
  for (const [type, key] of PRIMARY_TYPES) {
    assert.equal(factory[key], true, `primary ${type} ships on`);
  }
  assert.equal(factory.include_unknown_type, true, "unset type ships on");
  for (const [type, key] of SECONDARY_TYPES.filter(([, k]) => MUSIC_SECONDARY_KEYS.has(k))) {
    assert.equal(factory[key], true, `secondary ${type} ships on`);
  }
  // The five that were already being rejected keep that outcome; only the
  // switch is new. They are also not music.
  for (const key of [
    "include_spokenword", "include_interview", "include_audiobook",
    "include_audio_drama", "include_field_recording",
  ] as const) {
    assert.equal(factory[key], false, `${key} ships off`);
  }
});

test("factory status defaults keep Official and unset, and drop the rest", () => {
  // The one place we fail closed: a bootleg or pseudo-release is a worse copy
  // of a record the user already gets, not additional coverage. 5.08M of 5.6M
  // releases are Official, so coverage barely moves.
  const factory = DEFAULT_CONFIG.filtering;
  assert.equal(factory.include_status_official, true);
  assert.equal(factory.include_status_unknown, true);
  for (const [status, key] of RELEASE_STATUSES.filter(([s]) => s !== "Official")) {
    assert.equal(factory[key], false, status);
  }
  assert.equal(isReleaseStatusIncluded("Official", factory), true);
  assert.equal(isReleaseStatusIncluded(null, factory), true);
  assert.equal(isReleaseStatusIncluded("Bootleg", factory), false);
  assert.equal(isReleaseStatusIncluded("Pseudo-Release", factory), false);
});
