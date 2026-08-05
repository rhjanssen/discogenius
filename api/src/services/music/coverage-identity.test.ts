import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyRecordingVersion,
  recordingsCompatible,
  resolveCoverageUnits,
  type CoverageRecording,
} from "./coverage-identity.js";

function rec(
  recordingId: number,
  title: string,
  lengthMs: number | null,
  extra: Partial<CoverageRecording> = {},
): CoverageRecording {
  return { recordingId, title, lengthMs, ...extra };
}

function merged(recordings: CoverageRecording[], links: Parameters<typeof resolveCoverageUnits>[1] = []) {
  const { unitByRecording } = resolveCoverageUnits(recordings, links);
  return (a: number, b: number) => unitByRecording.get(a) === unitByRecording.get(b);
}

/* ── Generic identity rules (synthetic, table-driven) ───────────────── */

test("one Recording is one coverage unit by default", () => {
  const { unitByRecording } = resolveCoverageUnits([
    rec(1, "A", 200000),
    rec(2, "B", 200000),
    rec(3, "C", 200000),
  ]);
  assert.equal(new Set(unitByRecording.values()).size, 3);
});

test("compatibility vetoes are title, version and duration", () => {
  const cases: Array<{
    name: string;
    left: CoverageRecording;
    right: CoverageRecording;
    compatible: boolean;
    reason?: string;
  }> = [
    {
      name: "different works never merge",
      left: rec(1, "Pompeii", 214148),
      right: rec(2, "Oblivion", 196000),
      compatible: false,
      reason: "title_mismatch",
    },
    {
      name: "a remix is a different performance",
      left: rec(1, "Overjoyed", 206253),
      right: rec(2, "Overjoyed (Distance remix)", 305000),
      compatible: false,
      reason: "version_mismatch",
    },
    {
      name: "a live version is a different performance",
      left: rec(1, "Bad Blood", 212613),
      right: rec(2, "Bad Blood (live piano version)", 206000),
      compatible: false,
      reason: "version_mismatch",
    },
    {
      name: "an acoustic version is a different performance",
      left: rec(1, "Flaws", 200000),
      right: rec(2, "Flaws (acoustic)", 201000),
      compatible: false,
      reason: "version_mismatch",
    },
    {
      name: "a demo is a different performance",
      left: rec(1, "Poet", 165000),
      right: rec(2, "Poet (Dan's Bedroom Demo)", 195746),
      compatible: false,
      reason: "version_mismatch",
    },
    {
      name: "an en-dash suffix marker is read like a bracketed one",
      left: rec(1, "Oblivion", 196000),
      right: rec(2, "Oblivion – Capitol Studios 2013 Live", 192296),
      compatible: false,
      reason: "version_mismatch",
    },
    {
      name: "the same work at incompatible lengths is a different performance",
      left: rec(1, "Money for Nothing", 423000),
      right: rec(2, "Money for Nothing", 506400),
      compatible: false,
      reason: "duration_mismatch",
    },
    {
      name: "a remaster is the same performance",
      left: rec(1, "Pompeii", 214148),
      right: rec(2, "Pompeii (2023 Remaster)", 214000),
      compatible: true,
    },
    {
      name: "clean and explicit twins are the same performance",
      left: rec(1, "Bad Blood", 212613, { disambiguation: "explicit" }),
      right: rec(2, "Bad Blood", 212613, { disambiguation: "clean" }),
      compatible: true,
    },
    {
      name: "an unknown duration is not a conflict",
      left: rec(1, "Pompeii", null),
      right: rec(2, "Pompeii", 214148),
      compatible: true,
    },
    {
      name: "a title that merely contains a qualifier word keeps its meaning",
      left: rec(1, "Live and Let Die", 200000),
      right: rec(2, "Live and Let Die", 200500),
      compatible: true,
    },
  ];

  for (const testCase of cases) {
    const verdict = recordingsCompatible(testCase.left, testCase.right);
    assert.equal(
      verdict.compatible,
      testCase.compatible,
      `${testCase.name}: expected compatible=${testCase.compatible}`,
    );
    if (!verdict.compatible && testCase.reason) {
      assert.equal(verdict.reason, testCase.reason, testCase.name);
    }
  }
});

test("version classification separates the work from its markers", () => {
  assert.deepEqual(
    classifyRecordingVersion("Bad Blood (live piano version)"),
    { baseTitle: "bad blood", qualifiers: new Set(["live", "piano version"]) },
  );
  assert.deepEqual(
    classifyRecordingVersion("Pompeii", "explicit"),
    { baseTitle: "pompeii", qualifiers: new Set(["explicit"]) },
  );
});

test("strongly evidenced duplicate Recordings do collapse", () => {
  const isMerged = merged([
    rec(1, "Pompeii", 214148, { isrcs: ["GBAAA1200795"] }),
    rec(2, "Pompeii", 214000, { isrcs: ["gbaaa-1200795"] }),
  ]);
  assert.equal(isMerged(1, 2), true, "same ISRC, same work, same length");
});

test("an exact catalogue alias merges without needing similarity", () => {
  const isMerged = merged([
    rec(1, "Pompeii", 214148, { aliasRecordingIds: [2] }),
    rec(2, "Pompeii (2013 mono edit)", 999000),
  ]);
  assert.equal(isMerged(1, 2), true, "MusicBrainz merges are identity, not a guess");
});

test("ISRC alone cannot merge across a version conflict", () => {
  const isMerged = merged([
    rec(1, "Things We Lost in the Fire", 240000, { isrcs: ["X1"] }),
    rec(2, "Things We Lost in the Fire (TORN remix)", 323821, { isrcs: ["X1"] }),
  ]);
  assert.equal(isMerged(1, 2), false, "a shared ISRC is catalogue noise here, not identity");
});

/* ── Transitivity is bounded ────────────────────────────────────────── */

test("A merges with B, B does not drag in a conflicting C", () => {
  const recordings = [
    rec(1, "Song", 200000, { isrcs: ["ISRC1"] }),
    rec(2, "Song", 200500, { isrcs: ["ISRC1", "ISRC2"] }),
    rec(3, "Song (live)", 201000, { isrcs: ["ISRC2"] }),
  ];
  const { unitByRecording, rejections } = resolveCoverageUnits(recordings);
  assert.equal(unitByRecording.get(1), unitByRecording.get(2), "the good merge survives");
  assert.notEqual(unitByRecording.get(1), unitByRecording.get(3));
  assert.notEqual(unitByRecording.get(2), unitByRecording.get(3));
  assert.ok(
    rejections.some((r) => r.left === 2 && r.right === 3),
    "the refused edge is recorded, not silently dropped",
  );
});

test("a chain of compatible recordings still merges", () => {
  const isMerged = merged([
    rec(1, "Song", 200000, { isrcs: ["A"] }),
    rec(2, "Song", 200500, { isrcs: ["A", "B"] }),
    rec(3, "Song", 201000, { isrcs: ["B"] }),
  ]);
  assert.equal(isMerged(1, 3), true, "no conflict anywhere in the component");
});

/* ── Provider evidence may not create equivalence ───────────────────── */

test("provider evidence alone never merges Recordings", () => {
  const isMerged = merged(
    [rec(1, "Pompeii", 214148), rec(2, "Oblivion", 196000)],
    [{ provider: "tidal", providerTrackItemId: 900, recordingIds: [1, 2] }],
  );
  assert.equal(isMerged(1, 2), false);
});

test("a provider Track matched to incompatible Recordings is quarantined", () => {
  const recordings = [
    ...Array.from({ length: 9 }, (_, i) => rec(i + 1, "Money for Nothing", 400000 + i * 12000)),
    rec(10, "Money for Nothing (2022 Dolby Atmos mix)", 503000),
  ];
  const { unitByRecording, quarantinedProviderLinks } = resolveCoverageUnits(recordings, [
    { provider: "tidal", providerTrackItemId: 230633, recordingIds: recordings.map((r) => r.recordingId) },
  ]);

  assert.equal(quarantinedProviderLinks.length, 1);
  assert.equal(quarantinedProviderLinks[0].providerTrackItemId, 230633);
  assert.ok(quarantinedProviderLinks[0].conflict.reason);
  // The 423s and 506s takes must not share a unit however the provider matched.
  assert.notEqual(unitByRecording.get(1), unitByRecording.get(9));
  assert.notEqual(unitByRecording.get(1), unitByRecording.get(10));
});

test("a provider Track matched to genuinely equivalent Recordings is not quarantined", () => {
  const { quarantinedProviderLinks } = resolveCoverageUnits(
    [rec(1, "Pompeii", 214148), rec(2, "Pompeii", 214000)],
    [{ provider: "tidal", providerTrackItemId: 1, recordingIds: [1, 2] }],
  );
  assert.deepEqual(quarantinedProviderLinks, []);
});

/* ── Determinism and scope ──────────────────────────────────────────── */

test("unit ids are stable and independent of input order", () => {
  const recordings = [
    rec(7, "Song", 200000, { isrcs: ["A"] }),
    rec(3, "Song", 200400, { isrcs: ["A"] }),
    rec(5, "Other", 190000),
  ];
  const forward = resolveCoverageUnits(recordings).unitByRecording;
  const reversed = resolveCoverageUnits([...recordings].reverse()).unitByRecording;
  assert.deepEqual([...forward.entries()].sort(), [...reversed.entries()].sort());
  assert.equal(forward.get(7), 3, "the lowest recording id roots the class");
});

test("recordings outside the requested scope cannot influence the answer", () => {
  const inScope = [
    rec(1, "Song", 200000, { isrcs: ["A"] }),
    rec(2, "Song", 200500, { isrcs: ["A"] }),
  ];
  const scoped = resolveCoverageUnits(inScope);
  // The same two recordings, resolved alongside a large unrelated population.
  const noise = Array.from({ length: 500 }, (_, i) => rec(100 + i, `Noise ${i}`, 180000));
  const wide = resolveCoverageUnits([...inScope, ...noise]);
  assert.equal(
    scoped.unitByRecording.get(1) === scoped.unitByRecording.get(2),
    wide.unitByRecording.get(1) === wide.unitByRecording.get(2),
  );
  assert.equal(scoped.unitByRecording.get(1), wide.unitByRecording.get(1));
});

/* ── Catalog-capability profiles ────────────────────────────────────── */

test("Servarr-minimal facts stay conservative; MB-rich facts may prove more", () => {
  // Servarr shape: no ISRCs exposed. Two same-title takes stay separate when
  // their durations disagree, and merge when everything agrees.
  const servarrConflicting = merged([
    rec(1, "Song", 200000),
    rec(2, "Song", 240000),
  ]);
  assert.equal(servarrConflicting(1, 2), false, "conservative without ISRC evidence");

  const servarrAgreeing = merged([rec(1, "Song", 200000), rec(2, "Song", 200400)]);
  assert.equal(servarrAgreeing(1, 2), true);

  // MB-local shape: the ISRC proves the pair the durations already allowed.
  const mbRich = merged([
    rec(1, "Song", 200000, { isrcs: ["Z1"] }),
    rec(2, "Song", 200400, { isrcs: ["Z1"] }),
  ]);
  assert.equal(mbRich(1, 2), true);

  // ...and never produces a false equivalence the guards forbid.
  const mbRichConflicting = merged([
    rec(1, "Song", 200000, { isrcs: ["Z2"] }),
    rec(2, "Song (live)", 200400, { isrcs: ["Z2"] }),
  ]);
  assert.equal(mbRichConflicting(1, 2), false);
});
