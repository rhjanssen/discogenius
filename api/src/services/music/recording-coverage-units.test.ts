import assert from "node:assert/strict";
import test from "node:test";
import { resolveCoverageUnits, type CoverageRecording } from "./coverage-identity.js";
import {
  mapRecordingsToCoverageUnits,
  normalizeCoverageTitle,
} from "./recording-coverage-units.js";
import { editionRendition, renditionPreferenceRank } from "./rendition-policy.js";
import { curateLibraryReleases, type CurationEditionCandidate } from "./library-curation-planner.js";

/**
 * The old whole-database union-find is gone; these cases now exercise the
 * scoped, conservative resolver that replaced it. Signature-compatible shim so
 * each case keeps stating what it always stated.
 */
function buildRecordingCoverageUnitMap(
  recordings: readonly CoverageRecording[],
  providerLinks: ReadonlyArray<{ recordingIds: readonly number[] }> = [],
): Map<number, number> {
  return resolveCoverageUnits(
    recordings,
    providerLinks.map((link, index) => ({
      provider: "test",
      providerTrackItemId: index + 1,
      recordingIds: link.recordingIds,
    })),
  ).unitByRecording;
}

test("normalizeCoverageTitle collapses punctuation and case", () => {
  assert.equal(normalizeCoverageTitle("Plug In…"), "plug in");
  assert.equal(normalizeCoverageTitle("No Bad Days"), "no bad days");
});

test("coverage units pair clean/explicit twins by title+near duration", () => {
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

test("a corroborating provider track does not change a catalogue-proven merge", () => {
  // Frank-shaped: the two region MBIDs are the same work at the same length, so
  // catalogue evidence already proves the pair. The shared provider track item
  // agrees with that conclusion; it is not what reaches it, and the unrelated
  // remix stays out however the provider matched.
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
  const deluxe: CurationEditionCandidate = {
    releaseGroupId: 1,
    editionId: 180,
    attainableUnitIds: new Set([1, 2, 3, 10, 11]),
    official: true,
    medium: "digital" as const,
    preferredCountry: true,
    mediaCount: 1,
    releaseDate: "2008-01-01",
    releaseTypeRank: 0,
    secondaryTypeRank: 0,
    hasUsablePlan: true,
    planExplicitPreferenceRank: 1,
    editionExplicitPreferenceRank: 1,
    protected: false,
    existingRepresentative: false,
  };
  const japan: CurationEditionCandidate = {
    releaseGroupId: 1,
    editionId: 200,
    attainableUnitIds: new Set([1, 2, 3]), // remixes never attainable
    official: true,
    medium: "cd" as const,
    preferredCountry: false,
    mediaCount: 1,
    releaseDate: "0001-01-01",
    releaseTypeRank: 0,
    secondaryTypeRank: 0,
    hasUsablePlan: true,
    planExplicitPreferenceRank: 1,
    editionExplicitPreferenceRank: 1,
    protected: false,
    existingRepresentative: false,
  };
  const result = curateLibraryReleases([japan, deluxe], true);
  assert.deepEqual(result.selectedEditionIds, [180]);
});

test("rendition preference ranks the wanted side higher", () => {
  assert.equal(editionRendition("Album", "explicit"), "explicit");
  assert.equal(editionRendition("Album", "clean"), "clean");
  assert.equal(renditionPreferenceRank("explicit", true), 2);
  assert.equal(renditionPreferenceRank("clean", true), 0);
  assert.equal(renditionPreferenceRank("clean", false), 2);
  // An unlabelled edition sits between the two so it never beats a match.
  assert.equal(renditionPreferenceRank("unlabelled", true), 1);
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
    planExplicitRank: 0 | 1,
  ): CurationEditionCandidate => ({
    releaseGroupId,
    editionId,
    attainableUnitIds: units(recordings),
    official: true,
    medium: "digital",
    preferredCountry: true,
    mediaCount: 1,
    releaseDate: "2022-01-01",
    releaseTypeRank: 0,
    secondaryTypeRank: 0,
    hasUsablePlan: true,
    planExplicitPreferenceRank: planExplicitRank,
    editionExplicitPreferenceRank: 1,
    protected: false,
    existingRepresentative: false,
  });

  // Same RG: explicit 27-track (101-103), clean twin (201-203), deluxe with remix (101-103 + 301).
  const result = curateLibraryReleases([
    candidate(1, 10, [101, 102, 103], 1), // explicit dreams
    candidate(1, 11, [201, 202, 203], 0), // clean dreams
    candidate(1, 12, [101, 102, 103, 301], 1), // deluxe + remix
  ], true);

  const selectedIds = result.selectedEditionIds ?? result.selectedEditionIds ?? [];
  assert.ok(!selectedIds.includes(11), "clean twin must not be monitored");
  assert.ok(selectedIds.includes(10) || selectedIds.includes(12));
  assert.ok(selectedIds.length <= 2);
  assert.deepEqual(
    selectedIds.filter((id) => id === 11),
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
      attainableUnitIds: units([1, 3]),
      official: true,
      medium: "digital",
      preferredCountry: true,
      mediaCount: 1,
      releaseDate: "2022-01-01",
      releaseTypeRank: 0,
      secondaryTypeRank: 0,
      hasUsablePlan: true,
      planExplicitPreferenceRank: 1,
      editionExplicitPreferenceRank: 1,
      protected: false,
      existingRepresentative: false,
    },
    {
      releaseGroupId: 1,
      editionId: 51,
      attainableUnitIds: units([2, 4]),
      official: true,
      medium: "digital",
      preferredCountry: true,
      mediaCount: 1,
      releaseDate: "2022-01-01",
      releaseTypeRank: 0,
      secondaryTypeRank: 0,
      hasUsablePlan: true,
      planExplicitPreferenceRank: 0,
      editionExplicitPreferenceRank: 1,
      protected: false,
      existingRepresentative: false,
    },
  ], true);

  const selectedIds = result.selectedEditionIds ?? result.selectedEditionIds ?? [];
  assert.deepEqual(selectedIds, [50]);
});
