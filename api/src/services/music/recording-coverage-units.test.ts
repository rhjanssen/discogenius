import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRecordingCoverageUnitMap,
  editionExplicitLabelScore,
  editionExplicitPreferenceRank,
  mapRecordingsToCoverageUnits,
  normalizeCoverageTitle,
} from "./recording-coverage-units.js";
import { curateLibraryReleases, type CurationReleaseCandidate } from "./library-curation-planner.js";

test("normalizeCoverageTitle collapses punctuation and case", () => {
  assert.equal(normalizeCoverageTitle("Plug In…"), "plug in");
  assert.equal(normalizeCoverageTitle("No Bad Days"), "no bad days");
});

test("buildRecordingCoverageUnitMap pairs clean/explicit twins by title+near duration", () => {
  const unitByRecording = buildRecordingCoverageUnitMap([
    { recordingId: 10, title: "No Bad Days", lengthMs: 185379 },
    { recordingId: 11, title: "No Bad Days", lengthMs: 185379 },
    { recordingId: 20, title: "SPINALL remix", lengthMs: 200000 },
    { recordingId: 21, title: "Unrelated", lengthMs: 185379 },
  ]);
  assert.equal(unitByRecording.get(10), unitByRecording.get(11));
  assert.notEqual(unitByRecording.get(10), unitByRecording.get(20));
  assert.notEqual(unitByRecording.get(10), unitByRecording.get(21));
  assert.equal(unitByRecording.get(20), 20);
});

test("title-only matches without duration do not pair", () => {
  const unitByRecording = buildRecordingCoverageUnitMap([
    { recordingId: 1, title: "Same Title", lengthMs: null },
    { recordingId: 2, title: "Same Title", lengthMs: null },
  ]);
  assert.equal(unitByRecording.get(1), 1);
  assert.equal(unitByRecording.get(2), 2);
});

test("near-equal durations (clean/explicit twin drift) still pair", () => {
  // Ampersand clean vs explicit often differ by ~500–1500ms in MusicBrainz.
  const unitByRecording = buildRecordingCoverageUnitMap([
    { recordingId: 10, title: "Leonard & Marianne", lengthMs: 236627 },
    { recordingId: 11, title: "Leonard & Marianne", lengthMs: 235000 },
    { recordingId: 20, title: "Leonard & Marianne", lengthMs: 300000 }, // different performance
  ]);
  assert.equal(unitByRecording.get(10), unitByRecording.get(11));
  assert.notEqual(unitByRecording.get(10), unitByRecording.get(20));
});

test("shared ISRC collapses two recording MBIDs into one unit", () => {
  const unitByRecording = buildRecordingCoverageUnitMap([
    { recordingId: 10, title: "Know You Now", lengthMs: 183000, isrcs: ["GBAAN0300470"] },
    { recordingId: 11, title: "Know You Now (Japan)", lengthMs: 183053, isrcs: ["GBAAN0300470"] },
  ]);
  assert.equal(unitByRecording.get(10), unitByRecording.get(11));
});

test("shared provider track collapses Japan studio MBID onto deluxe MBID", () => {
  // Frank-shaped: different titles/lengths fail soft pairing, but both accepted
  // matches point at the same provider track item.
  const unitByRecording = buildRecordingCoverageUnitMap(
    [
      { recordingId: 100, title: "Know You Now", lengthMs: 184253 },
      { recordingId: 200, title: "Know You Now", lengthMs: 183053 },
      { recordingId: 300, title: "Mylo Remix", lengthMs: 292080 },
    ],
    [
      { recordingIds: [100, 200] }, // same TIDAL track matched to both
    ],
  );
  assert.equal(unitByRecording.get(100), unitByRecording.get(200));
  assert.notEqual(unitByRecording.get(100), unitByRecording.get(300));
});

test("within-RG curation drops Japan when units already covered by deluxe", () => {
  // Deluxe has studio units 1,2,3 + demos 10,11. Japan has studio 1,2,3 (same
  // units after provider-track collapse) + unattainable remix unit 99 that is
  // NOT in attainable sets — so Japan adds nothing and is not selected.
  const deluxe = {
    releaseGroupId: 1,
    editionId: 180,
    attainableRecordingIds: new Set([1, 2, 3, 10, 11]),
    official: true,
    medium: "digital" as const,
    preferredCountry: true,
    mediaCount: 1,
    releaseDate: "2008-01-01",
  };
  const japan = {
    releaseGroupId: 1,
    editionId: 200,
    attainableRecordingIds: new Set([1, 2, 3]), // remixes never attainable
    official: true,
    medium: "cd" as const,
    preferredCountry: false,
    mediaCount: 1,
    releaseDate: "0001-01-01",
  };
  const result = curateLibraryReleases([japan, deluxe], true);
  assert.deepEqual(result.selectedReleaseIds, [180]);
});

test("editionExplicitPreferenceRank prefers explicit when configured", () => {
  assert.equal(editionExplicitLabelScore("Album", "explicit"), 1);
  assert.equal(editionExplicitLabelScore("Album", "clean"), -1);
  assert.equal(editionExplicitPreferenceRank(1, true), 2);
  assert.equal(editionExplicitPreferenceRank(-1, true), 0);
  assert.equal(editionExplicitPreferenceRank(-1, false), 2);
});

test("clean twin is dropped when coverage units match and prefer_explicit ranks the other higher", () => {
  // Shared core tracks with clean/explicit counterparts + one unique remix on deluxe.
  const unitByRecording = buildRecordingCoverageUnitMap([
    { recordingId: 101, title: "No Bad Days", lengthMs: 1000 },
    { recordingId: 201, title: "No Bad Days", lengthMs: 1000 },
    { recordingId: 102, title: "Promises", lengthMs: 2000 },
    { recordingId: 202, title: "Promises", lengthMs: 2000 },
    { recordingId: 103, title: "Family Ties", lengthMs: 3000 },
    { recordingId: 203, title: "Family Ties", lengthMs: 3000 },
    { recordingId: 301, title: "SPINALL remix", lengthMs: 4000 },
  ]);

  const units = (ids: number[]) => mapRecordingsToCoverageUnits(ids, unitByRecording);

  const candidate = (
    releaseGroupId: number,
    editionId: number,
    recordings: number[],
    explicitRank: number,
  ): CurationReleaseCandidate => ({
    releaseGroupId,
    editionId,
    attainableRecordingIds: units(recordings),
    official: true,
    medium: "digital",
    preferredCountry: true,
    mediaCount: 1,
    releaseDate: "2022-01-01",
    explicitPreferenceRank: explicitRank,
  });

  // Same RG: explicit 27-track (101-103), clean twin (201-203), deluxe with remix (101-103 + 301).
  const result = curateLibraryReleases([
    candidate(1, 10, [101, 102, 103], 2), // explicit dreams
    candidate(1, 11, [201, 202, 203], 0), // clean dreams
    candidate(1, 12, [101, 102, 103, 301], 2), // deluxe + remix
  ], true);

  assert.ok(!result.selectedReleaseIds.includes(11), "clean twin must not be monitored");
  assert.ok(result.selectedReleaseIds.includes(10) || result.selectedReleaseIds.includes(12));
  // With redundancy, fewest editions covering units: deluxe alone covers remix+core,
  // so only one (or deluxe alone) — clean is never required.
  assert.ok(result.selectedReleaseIds.length <= 2);
  assert.deepEqual(
    result.selectedReleaseIds.filter((id) => id === 11),
    [],
  );
});

test("when only clean and explicit twins exist, prefer_explicit keeps the explicit edition", () => {
  const unitByRecording = buildRecordingCoverageUnitMap([
    { recordingId: 1, title: "Song", lengthMs: 1000 },
    { recordingId: 2, title: "Song", lengthMs: 1000 },
    { recordingId: 3, title: "Other", lengthMs: 2000 },
    { recordingId: 4, title: "Other", lengthMs: 2000 },
  ]);
  const units = (ids: number[]) => mapRecordingsToCoverageUnits(ids, unitByRecording);

  const result = curateLibraryReleases([
    {
      releaseGroupId: 1,
      editionId: 50,
      attainableRecordingIds: units([1, 3]),
      official: true,
      medium: "digital",
      preferredCountry: true,
      mediaCount: 1,
      releaseDate: "2022-01-01",
      explicitPreferenceRank: 2,
    },
    {
      releaseGroupId: 1,
      editionId: 51,
      attainableRecordingIds: units([2, 4]),
      official: true,
      medium: "digital",
      preferredCountry: true,
      mediaCount: 1,
      releaseDate: "2022-01-01",
      explicitPreferenceRank: 0,
    },
  ], true);

  assert.deepEqual(result.selectedReleaseIds, [50]);
});
