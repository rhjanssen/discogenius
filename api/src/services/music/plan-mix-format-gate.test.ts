/**
 * A Dolby Atmos mix and its stereo counterpart are one *wanted* song and two
 * *acquirable* products.
 *
 * Curation must see one unit, or the Stereo and Spatial libraries each mark the
 * same song wanted and the redundancy filter reports a duplicate that isn't one.
 * That matters more once libraries become user-defined ("Atmos above 24-bit
 * stereo"): the question "do I have this song?" has one answer, and the profile
 * decides which rendering satisfies it.
 *
 * Acquisition must see two, or a stereo offer fills an Edition the catalogue
 * explicitly labels as a surround mix. Same shape as the clean/explicit gate,
 * one axis over — and it is a *separate* axis, because `dolby atmos mix, clean`
 * is a real comment carrying one marker of each.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { eligiblePlansForEdition } from "./acquisition-planning-service.js";
import { resolveCoverageUnits } from "./coverage-identity.js";
import {
  editionMixFormat,
  editionMixFormatWithRecordings,
  editionRendition,
  planEligibleForMixFormat,
} from "./rendition-policy.js";

/* ── Curation: one unit ─────────────────────────────────────────────── */

const pompeii = (recordingId: number, disambiguation?: string, lengthMs = 214148) =>
  ({ recordingId, title: "Pompeii", lengthMs, disambiguation });

test("every channel rendering of one performance is one coverage unit", () => {
  const { unitByRecording } = resolveCoverageUnits([
    pompeii(1),
    pompeii(2, "dolby atmos mix", 214000),
    pompeii(3, "5.1 mix", 214200),
    pompeii(4, "360 reality audio mix", 214100),
    pompeii(5, "quadraphonic", 214050),
  ]);
  const unit = unitByRecording.get(1);
  for (const recordingId of [2, 3, 4, 5]) {
    assert.equal(unitByRecording.get(recordingId), unit, `recording ${recordingId}`);
  }
  assert.equal(new Set(unitByRecording.values()).size, 1);
});

test("a channel format merges but a different performance still does not", () => {
  const { unitByRecording } = resolveCoverageUnits([
    pompeii(1),
    pompeii(2, "dolby atmos mix", 214000),
    pompeii(10, "live", 215000),
    pompeii(11, "remix", 214100),
    pompeii(12, "instrumental", 214090),
  ]);
  assert.equal(unitByRecording.get(1), unitByRecording.get(2));
  for (const recordingId of [10, 11, 12]) {
    assert.notEqual(unitByRecording.get(1), unitByRecording.get(recordingId), `recording ${recordingId}`);
  }
});

test("a format marker beats the bare `mix` token inside it", () => {
  // "dolby atmos mix" contains "mix", which alone denotes a remix — a different
  // performance. Longest-marker-first is what keeps the format from reading as
  // a remix and splitting the unit.
  const { unitByRecording } = resolveCoverageUnits([
    pompeii(1),
    pompeii(2, "dolby atmos mix", 214000),
  ]);
  assert.equal(unitByRecording.get(1), unitByRecording.get(2));
});

test("the two axes are independent, as the corpus writes them", () => {
  // `dolby atmos mix, explicit` — 1108 recordings, 280 releases.
  assert.equal(editionMixFormat(null, "dolby atmos mix, explicit"), "spatial");
  assert.equal(editionRendition(null, "dolby atmos mix, explicit"), "explicit");
  assert.equal(editionMixFormat(null, "clean, dolby atmos mix"), "spatial");
  assert.equal(editionRendition(null, "clean, dolby atmos mix"), "clean");
});

/* ── What labels an Edition spatial ─────────────────────────────────── */

test("real MusicBrainz channel-format comments are recognised", () => {
  for (const comment of [
    "dolby atmos mix",          // 11806
    "5.1 mix",                  // 2737
    "360 reality audio mix",    // 1411
    "dolby atmos",              // 395
    "quadraphonic",             // 361
    "5.1 surround mix",         // 229
    "quadraphonic mix",         // 193
    "5.1 surround sound",       // 172
    "5.1 audio",                // 137
    "atmos mix",                // 9
    "quadraphonic vinyl lp",    // 41
    "quadraphonic 8-track",     // 32
    "dolby atmos mix, deluxe",  // 27
    "7.1 mix",
    "binaural",
  ]) assert.equal(editionMixFormat(null, comment), "spatial", comment);
});

test("a stereo edition is unlabelled, not spatial", () => {
  for (const comment of [
    null,
    "stereo",
    "deluxe",
    "remaster",
    "explicit",
    "mono",
    // Prose that would trip a substring scan.
    "surrounded by silence tour edition",
    "atmospheric mix",
    "recorded at 5.1 studios",
  ]) assert.equal(editionMixFormat(null, comment), "unlabelled", String(comment));
});

test("a title labels the Edition only when the marker stands alone", () => {
  assert.equal(editionMixFormat("Back to Black (Dolby Atmos Mix)", null), "spatial");
  assert.equal(editionMixFormat("Back to Black [5.1 Mix]", null), "spatial");
  assert.equal(editionMixFormat("Surrounded (deluxe)", null), "unlabelled");
});

/* ── Acquisition: two products ──────────────────────────────────────── */

test("a spatial Edition takes only a spatial plan", () => {
  assert.equal(planEligibleForMixFormat("spatial", "spatial"), true);
  for (const tier of ["hires-lossless", "lossless", "high", "low", null, undefined]) {
    assert.equal(planEligibleForMixFormat(tier, "spatial"), false, String(tier));
  }
});

test("an unlabelled Edition takes any plan; the quality profile decides", () => {
  // Not duplicating the profile here is deliberate: a Spatial library pointed at
  // an unlabelled Edition that happens to carry an Atmos offer must still work.
  for (const tier of ["spatial", "hires-lossless", "lossless", null]) {
    assert.equal(planEligibleForMixFormat(tier, "unlabelled"), true, String(tier));
  }
});

const plan = (
  planKey: string,
  qualityTier: string,
  explicitContent: "explicit" | "clean" | "unknown" = "unknown",
) => ({ planKey, qualityTier, explicitContent });

const keys = (plans: ReadonlyArray<{ planKey: string }>) => plans.map((p) => p.planKey);

test("the planner drops a stereo plan for a surround-mix Edition", () => {
  const eligible = eligiblePlansForEdition(
    [plan("hires-stereo", "hires-lossless"), plan("atmos", "spatial")],
    "Back to Black",
    "dolby atmos mix",
  );
  assert.deepEqual(keys(eligible), ["atmos"]);
});

test("a spatial Edition whose only offer is stereo gets no plan at all", () => {
  // Same reasoning as the rendition gate: the last surviving plan is rank 0
  // whatever it is, and rank 0 is what curation executes.
  assert.deepEqual(eligiblePlansForEdition([plan("stereo", "lossless")], null, "5.1 mix"), []);
});

test("both gates apply together", () => {
  const plans = [
    plan("atmos-explicit", "spatial", "explicit"),
    plan("atmos-clean", "spatial", "clean"),
    plan("stereo-clean", "lossless", "clean"),
  ];
  assert.deepEqual(
    keys(eligiblePlansForEdition(plans, null, "dolby atmos mix, clean")),
    ["atmos-clean"],
  );
  assert.deepEqual(
    keys(eligiblePlansForEdition(plans, null, "explicit, dolby atmos mix")),
    ["atmos-explicit"],
  );
});

test("an unlabelled Edition keeps every plan and the planner's own ordering", () => {
  const plans = [plan("a", "spatial"), plan("b", "hires-lossless"), plan("c", "lossless")];
  assert.deepEqual(keys(eligiblePlansForEdition(plans, "Back to Black", "deluxe")), ["a", "b", "c"]);
});

/* ── The comment has to survive the round trip ──────────────────────── */

test("a qualifier that lives only in the comment reaches the resolver", async () => {
  // This is the case the schema was blind to. MusicBrainz keeps titles clean
  // and puts the qualifier in `recording.comment`: 34,154 corpus recordings are
  // qualified there and nowhere else *and* have a same-title sibling within two
  // seconds, so a resolver that cannot see the comment merges a live take into
  // the studio one — a false merge, which silently drops wanted content.
  const { default: Database } = await import("better-sqlite3");
  const { loadCoverageUnitsForRecordings } = await import("./coverage-identity-repository.js");
  const db = new Database(":memory:");
  try {
    db.exec(`
      CREATE TABLE Recordings (
        id INTEGER PRIMARY KEY, title TEXT, length_ms INT,
        disambiguation TEXT, isrcs TEXT, is_video INT DEFAULT 0);
      CREATE TABLE ProviderTrackMatches (
        provider_track_item_id INT, recording_id INT, match_state TEXT);
      CREATE TABLE ProviderItems (id INTEGER PRIMARY KEY, provider TEXT, isrc TEXT);
      -- The resolver also reads the lengths each Recording appears at on real
      -- Tracks, because a Recording's stamped length can describe a different
      -- release than the one being curated.
      CREATE TABLE Tracks (id INTEGER PRIMARY KEY, recording_id INT, length_ms INT);
    `);
    const insert = db.prepare(
      "INSERT INTO Recordings (id, title, length_ms, disambiguation) VALUES (?, ?, ?, ?)");
    insert.run(1, "Pompeii", 214148, null);
    insert.run(2, "Pompeii", 214148, "live");
    insert.run(3, "Pompeii", 214148, "dolby atmos mix");

    const { unitByRecording } = loadCoverageUnitsForRecordings(db, [1, 2, 3]);
    assert.notEqual(unitByRecording.get(1), unitByRecording.get(2), "live must not merge");
    assert.equal(unitByRecording.get(1), unitByRecording.get(3), "atmos must merge");
  } finally {
    db.close();
  }
});

/* ── A comment carries independent attributes ───────────────────────── */

test("a channel format does not swallow the performance qualifier beside it", () => {
  // `live, 5.1 mix` (93 recordings) and its kin: 1,261 corpus recordings carry
  // both a channel format and a performance qualifier in one comment. Consuming
  // the format and stopping loses the `live`, and a live take then merges into
  // the studio recording — the failure that costs wanted content, not a
  // duplicate download.
  const { unitByRecording } = resolveCoverageUnits([
    pompeii(1),                                   // stereo studio
    pompeii(2, "dolby atmos mix", 214000),        // Atmos studio  -> same
    pompeii(3, "live, 5.1 mix", 215000),          // live surround -> different
    pompeii(4, "instrumental, 5.1 mix", 214100),  // instrumental  -> different
    pompeii(5, "remix, dolby atmos mix", 214050), // remix         -> different
    pompeii(6, "radio edit, 360 reality audio mix", 214090),
  ]);
  assert.equal(unitByRecording.get(1), unitByRecording.get(2), "Atmos studio is the same song");
  for (const recordingId of [3, 4, 5, 6]) {
    assert.notEqual(
      unitByRecording.get(1), unitByRecording.get(recordingId),
      `recording ${recordingId} is a different performance`,
    );
  }
});

test("two surround recordings of the same performance still merge", () => {
  // The format is neutral on both sides, so removing it must not make them
  // differ from each other either.
  const { unitByRecording } = resolveCoverageUnits([
    pompeii(1, "live, 5.1 mix", 215000),
    pompeii(2, "live, dolby atmos mix", 215100),
    pompeii(3, "live", 215050),
  ]);
  assert.equal(unitByRecording.get(1), unitByRecording.get(2));
  assert.equal(unitByRecording.get(1), unitByRecording.get(3));
});

test("rendition markers beside a format stay neutral", () => {
  // `dolby atmos mix, explicit` (1108) and `dolby atmos mix, clean` (890) are
  // one performance; the rendition split is acquisition's business, not
  // curation's.
  const { unitByRecording } = resolveCoverageUnits([
    pompeii(1, "explicit"),
    pompeii(2, "dolby atmos mix, explicit", 214000),
    pompeii(3, "clean, dolby atmos mix", 214100),
  ]);
  assert.equal(unitByRecording.get(1), unitByRecording.get(2));
  assert.equal(unitByRecording.get(1), unitByRecording.get(3));
});

/* ── When only the Recordings carry the marker ──────────────────────── */

test("an Edition whose Recordings unanimously say spatial is spatial", () => {
  // 155 corpus releases label every recording and nothing on the release.
  assert.equal(
    editionMixFormatWithRecordings("Back to Black", null,
      ["dolby atmos mix", "dolby atmos mix", "dolby atmos mix"]),
    "spatial",
  );
  assert.deepEqual(
    keys(eligiblePlansForEdition(
      [plan("stereo", "lossless"), plan("atmos", "spatial")],
      "Back to Black", null, ["dolby atmos mix", "dolby atmos mix"],
    )),
    ["atmos"],
  );
});

test("one bonus Atmos cut does not make the whole Edition spatial", () => {
  // The 801 corpus releases that carry *a* spatial recording without being a
  // spatial issue. Inferring from "any" would deny all of them every stereo
  // plan — breaking 801 editions to fix 155.
  assert.equal(
    editionMixFormatWithRecordings("Back to Black", null,
      [null, null, "dolby atmos mix", null]),
    "unlabelled",
  );
  assert.deepEqual(
    keys(eligiblePlansForEdition(
      [plan("stereo", "lossless"), plan("atmos", "spatial")],
      "Back to Black", null, [null, null, "dolby atmos mix"],
    )),
    ["stereo", "atmos"],
  );
});

test("an Edition labelled spatial stays spatial whatever its Recordings say", () => {
  assert.equal(
    editionMixFormatWithRecordings("Back to Black", "dolby atmos mix", [null, null]),
    "spatial",
  );
});

test("no Recordings means no inference", () => {
  assert.equal(editionMixFormatWithRecordings("Back to Black", null, []), "unlabelled");
});

/* ── One performance, described twice ───────────────────────────────── */

test("a Dolby Atmos mix of a live set is that live set, however the title words it", () => {
  // Bastille's MTV Unplugged shipped as two Editions: the album, and a "Dolby
  // Atmos mix" Edition of the same 15 performances. Fourteen merged; the first
  // did not, because its title says "MTV Unplugged" where the other's comment
  // says "live" - and one unmerged track was enough to keep the whole duplicate
  // Edition monitored, so the spatial library would have downloaded fifteen
  // Atmos files it already had.
  //
  // Both comments name the identical occasion, which is what settles it. Title
  // wording cannot outvote that.
  //
  // The edge itself comes from the shared ISRC, which is how the live catalogue
  // proposes it: one Apple Music track is accepted against both Recordings, so
  // its ISRC is folded into both. What changed is that the veto no longer fires.
  const occasion = "live, 2021-11-16: Porchester Hall, London, UK";
  const { unitByRecording } = resolveCoverageUnits([
    {
      recordingId: 1,
      title: "Survivin’ – MTV Unplugged 2021",
      lengthMs: 247259,
      disambiguation: occasion,
      isrcs: ["GBUM72300557"],
    },
    {
      recordingId: 2,
      title: "survivin’",
      lengthMs: 247259,
      disambiguation: `Dolby Atmos mix, ${occasion}`,
      isrcs: ["GBUM72300557"],
    },
  ]);
  assert.equal(unitByRecording.get(1), unitByRecording.get(2));
});

test("a shared occasion does not merge a different rendition of it", () => {
  // The occasion says when it was captured, not what was done to the audio. An
  // instrumental of one live take is still a different deliverable.
  const occasion = "live, 2021-11-16: Porchester Hall, London, UK";
  const { unitByRecording } = resolveCoverageUnits([
    { recordingId: 1, title: "Pompeii", lengthMs: 300000, disambiguation: occasion, isrcs: ["GBUM70000001"] },
    {
      recordingId: 2,
      title: "Pompeii",
      lengthMs: 300000,
      disambiguation: `instrumental, ${occasion}`,
      isrcs: ["GBUM70000001"],
    },
  ]);
  assert.notEqual(unitByRecording.get(1), unitByRecording.get(2));
});

test("a bare live comment is not an occasion, so two live takes stay apart", () => {
  // "live" alone is what every live track says. Without a date or venue it
  // identifies nothing, and two unrelated live takes must not collapse.
  const { unitByRecording } = resolveCoverageUnits([
    { recordingId: 1, title: "Pompeii", lengthMs: 300000, disambiguation: "live" },
    { recordingId: 2, title: "Pompeii", lengthMs: 300000, disambiguation: "unplugged" },
  ]);
  assert.notEqual(unitByRecording.get(1), unitByRecording.get(2));
});

test("a length stamped from another release does not split a performance", () => {
  // MusicBrainz reuses one Recording across releases that run to different
  // lengths, and the stamped length then describes only one of them. Bastille's
  // "Survivin'" is stamped 3:10 - its studio single - while every Track of it on
  // MTV Unplugged is 4:07, and all four providers agree on 4:07.
  const occasion = "live, 2021-11-16: Porchester Hall, London, UK";
  const { unitByRecording } = resolveCoverageUnits([
    {
      recordingId: 1,
      title: "Survivin’",
      lengthMs: 190000,
      observedLengthsMs: [190000, 247000],
      disambiguation: occasion,
      isrcs: ["GBUM70000002"],
    },
    {
      recordingId: 2,
      title: "Survivin’",
      lengthMs: 247259,
      observedLengthsMs: [247259],
      disambiguation: occasion,
      isrcs: ["GBUM70000002"],
    },
  ]);
  assert.equal(unitByRecording.get(1), unitByRecording.get(2));

  // With no Track observing a compatible length, the stamped disagreement stands.
  const apart = resolveCoverageUnits([
    {
      recordingId: 1,
      title: "Survivin’",
      lengthMs: 190000,
      observedLengthsMs: [190000],
      disambiguation: occasion,
      isrcs: ["GBUM70000002"],
    },
    {
      recordingId: 2,
      title: "Survivin’",
      lengthMs: 247259,
      observedLengthsMs: [247259],
      disambiguation: occasion,
      isrcs: ["GBUM70000002"],
    },
  ]);
  assert.notEqual(apart.unitByRecording.get(1), apart.unitByRecording.get(2));
});
