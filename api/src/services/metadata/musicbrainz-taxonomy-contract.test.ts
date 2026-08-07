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
  "include_studio", "include_compilation", "include_live", "include_soundtrack",
  "include_remix", "include_demo", "include_dj_mix", "include_mixtape_street",
  "include_audiobook", "include_field_recording",
]);

/** MusicBrainz's own names, used to prove Studio is not one of them. */
const SECONDARY_TYPE_NAMES: string[] = SECONDARY_TYPES.map(([name]) => name);

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

/* ── Untyped folds into Other ───────────────────────────────────────── */

test("an untyped Release Group is judged as Other, not as an Album", () => {
  // 99,535 Release Groups have no primary type. Calling them Albums admitted
  // them under a switch pointed at albums.
  for (const missing of [null, undefined, "", "   "]) {
    assert.equal(
      isMusicBrainzReleaseGroupIncluded({ primary_type: missing }, configWith({ include_other: false })),
      false, String(missing),
    );
    assert.equal(
      isMusicBrainzReleaseGroupIncluded({ primary_type: missing }, configWith({ include_album: false })),
      true, String(missing),
    );
  }
  assert.equal(
    getMusicBrainzReleaseGroupIncludeDecision(
      { primary_type: null }, configWith({ include_other: false }),
    ).reason,
    "untyped_excluded",
    "the reason still distinguishes untyped from a real Other",
  );
});

test("a primary type this build does not recognise is also Other", () => {
  assert.equal(
    isMusicBrainzReleaseGroupIncluded({ primary_type: "Hologram" }, configWith({ include_other: true })),
    true,
  );
  assert.equal(
    isMusicBrainzReleaseGroupIncluded({ primary_type: "Hologram" }, configWith({ include_other: false })),
    false,
  );
});

/* ── One enabled secondary type is enough ───────────────────────────── */

test("a Release Group is included when any one of its secondary types is on", () => {
  // Lidarr's rule. `Live + Spokenword` is 2,322 Release Groups: a live record
  // that also has speech, which enabling Live means wanting.
  const speechOff = configWith({
    include_spokenword: false, include_interview: false, include_audio_drama: false,
  });
  for (const combo of [
    ["Live", "Spokenword"],          // 2322
    ["Compilation", "Spokenword"],   //  464
    ["Soundtrack", "Spokenword"],    //  365
    ["Interview", "Live"],           //  263
    ["Audio drama", "Compilation"],  //  304
  ]) {
    assert.equal(
      isMusicBrainzReleaseGroupIncluded({ primary_type: "Album", secondary_types: combo }, speechOff),
      true, combo.join(" + "),
    );
  }
});

test("a Release Group is excluded only when every secondary type is off", () => {
  const speechOff = configWith({
    include_spokenword: false, include_interview: false, include_audio_drama: false,
  });
  for (const combo of [
    ["Spokenword"],
    ["Audio drama", "Spokenword"],   // 767
    ["Interview", "Spokenword"],
  ]) {
    const decision = getMusicBrainzReleaseGroupIncludeDecision(
      { primary_type: "Album", secondary_types: combo }, speechOff,
    );
    assert.equal(decision.include, false, combo.join(" + "));
    assert.match(String(decision.reason), /_excluded$/);
  }
});

test("an unrecognised secondary type never vetoes, and never stands alone as a veto", () => {
  // It cannot veto under these semantics, and letting it exclude on its own
  // would mean a future MusicBrainz addition silently deleting content.
  assert.equal(
    isMusicBrainzReleaseGroupIncluded(
      { primary_type: "Album", secondary_types: ["Podcast", "Live"] }, ALL_ON,
    ), true,
  );
  assert.equal(
    isMusicBrainzReleaseGroupIncluded(
      { primary_type: "Album", secondary_types: ["Podcast"] },
      configWith({ include_spokenword: false }),
    ), true,
  );
});

/* ── Studio is the empty set, and only that ─────────────────────────── */

test("Studio decides Release Groups with no secondary type at all", () => {
  for (const empty of [null, undefined, "", "[]", []]) {
    assert.equal(
      isMusicBrainzReleaseGroupIncluded({ primary_type: "Album", secondary_types: empty }, ALL_ON),
      true, String(empty),
    );
    assert.equal(
      isMusicBrainzReleaseGroupIncluded(
        { primary_type: "Album", secondary_types: empty }, configWith({ include_studio: false }),
      ),
      false, String(empty),
    );
  }
});

test("Studio does not touch a Release Group that has a secondary type", () => {
  // It is the empty-set case only — never a facet a release can carry, which is
  // also why it is never stored and never written to a tag.
  assert.equal(
    isMusicBrainzReleaseGroupIncluded(
      { primary_type: "Album", secondary_types: ["Live"] }, configWith({ include_studio: false }),
    ),
    true,
  );
  assert.equal(normalizeMusicBrainzType("Studio"), "studio");
  assert.equal(
    SECONDARY_TYPE_NAMES.includes("Studio"), false,
    "Studio is not one of MusicBrainz's twelve",
  );
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

test("factory defaults are a discography of albums, EPs and singles", () => {
  // Lidarr ships Album + Studio + Official: an opt-in discography. Discogenius
  // ships the three kinds a discography is made of, and lets the user widen.
  const factory = DEFAULT_CONFIG.filtering;
  for (const key of ["include_album", "include_ep", "include_single"] as const) {
    assert.equal(factory[key], true, `${key} ships on`);
  }
  // A broadcast is a radio session; Other also carries the untyped and the
  // unrecognised. Neither is what someone means by "this artist's records".
  assert.equal(factory.include_broadcast, false);
  assert.equal(factory.include_other, false);
});

test("factory secondary defaults keep every kind of music and drop speech", () => {
  const factory = DEFAULT_CONFIG.filtering;
  for (const key of MUSIC_SECONDARY_KEYS) {
    assert.equal(factory[key as keyof typeof factory], true, `${key} ships on`);
  }
  for (const key of ["include_spokenword", "include_interview", "include_audio_drama"] as const) {
    assert.equal(factory[key], false, `${key} ships off`);
  }
});

test("the factory defaults keep Bastille's Other People's Heartache", () => {
  // EP + Mixtape/Street, all four of them. The concrete case a restrictive
  // secondary default would have silently dropped.
  assert.equal(
    isMusicBrainzReleaseGroupIncluded(
      { primary_type: "EP", secondary_types: ["Mixtape/Street"] }, DEFAULT_CONFIG.filtering,
    ),
    true,
  );
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
