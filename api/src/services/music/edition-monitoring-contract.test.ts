/**
 * The contract between canonical Editions, Acquisition Plans and monitoring.
 *
 * Three separate things are deliberately kept separate here, and this suite
 * exists because collapsing any two of them has broken the product before:
 *
 *   canonical contents   — what the Edition IS, always complete
 *   provider coverage    — what a provider can deliver of it
 *   monitoring           — what this Library has chosen to keep
 *
 * Scenario throughout (a shrunk version of the standard/deluxe case):
 *
 *   Standard edition: tracks 1-2
 *   Deluxe edition:   tracks 1-4
 *   TIDAL deluxe      — exact match to deluxe, 4/4, lossless
 *   Apple standard    — exact match to standard, and a SUBSET match to deluxe
 */
import assert from "node:assert/strict";
import test, { after } from "node:test";
import {
  closeActiveSchemaDb,
  openActiveSchemaDb,
  prepareActiveSchemaEnv,
  resetActiveSchemaRows,
} from "../../test-support/active-schema-fixture.js";
import { ProviderReleaseIngestionService } from "../providers/provider-release-ingestion-service.js";
import { AcquisitionPlanningService } from "./acquisition-planning-service.js";
import { AlbumCommandService } from "./album-command-service.js";
import { LibraryCurationService } from "./library-curation-service.js";
import { LibraryReleaseSelectionService } from "./library-release-selection-service.js";

const { tempDir } = prepareActiveSchemaEnv("edition-monitoring-contract");
const { db, dbModule } = await openActiveSchemaDb();

after(() => closeActiveSchemaDb(dbModule, tempDir));

const ARTIST_MBID = "e1000000-0000-4000-8000-000000000001";
const ALBUM_MBID = "e1000000-0000-4000-8000-000000000002";
const STANDARD_MBID = "e1000000-0000-4000-8000-000000000003";
const DELUXE_MBID = "e1000000-0000-4000-8000-000000000004";
const STANDARD_EDITION_ID = 1;
const DELUXE_EDITION_ID = 2;
const LIBRARY_ID = 1;

/** Canonical catalogue + one Library. Nothing monitored, no plans. */
function seedCatalog(options: { requireProviderAvailability?: boolean } = {}): void {
  resetActiveSchemaRows(db, ["Libraries", "MetadataProfiles", "quality_profiles"]);
  db.exec(`
    INSERT INTO ArtistMetadata (id, mbid, name) VALUES (1, '${ARTIST_MBID}', 'Bastille');
    INSERT INTO ManagedArtists (id, artist_id) VALUES (1, 1);
    INSERT INTO Albums (id, mbid, artist_metadata_id, artist_mbid, title, primary_type)
    VALUES (1, '${ALBUM_MBID}', 1, '${ARTIST_MBID}', 'Doom Days', 'Album');
    INSERT INTO AlbumEditions (
      id, mbid, release_group_id, release_group_mbid, artist_metadata_id, artist_mbid,
      title, status, country, date, media_count, track_count
    ) VALUES
      (${STANDARD_EDITION_ID}, '${STANDARD_MBID}', 1, '${ALBUM_MBID}', 1, '${ARTIST_MBID}',
       'Doom Days', 'Official', 'XW', '2019-06-14', 1, 2),
      (${DELUXE_EDITION_ID}, '${DELUXE_MBID}', 1, '${ALBUM_MBID}', 1, '${ARTIST_MBID}',
       'Doom Days (Deluxe)', 'Official', 'XW', '2019-11-01', 1, 4);
    INSERT INTO Recordings (id, mbid, artist_metadata_id, artist_mbid, title, length_ms, isrcs) VALUES
      (1, 'e1000000-0000-4000-8000-000000000011', 1, '${ARTIST_MBID}', 'Quarter Past Midnight', 199000, '["GBUM71801770"]'),
      (2, 'e1000000-0000-4000-8000-000000000012', 1, '${ARTIST_MBID}', 'Bad Decisions', 190000, '["GBUM71901234"]'),
      (3, 'e1000000-0000-4000-8000-000000000013', 1, '${ARTIST_MBID}', 'Another Place', 205000, '["GBUM71901235"]'),
      (4, 'e1000000-0000-4000-8000-000000000014', 1, '${ARTIST_MBID}', 'Joy', 210000, '["GBUM71901236"]');
    INSERT INTO Tracks (
      id, mbid, album_edition_id, release_mbid, recording_id, recording_mbid,
      medium_position, position, title, length_ms
    ) VALUES
      (1, 'e-track-std-1', ${STANDARD_EDITION_ID}, '${STANDARD_MBID}', 1, 'e1000000-0000-4000-8000-000000000011', 1, 1, 'Quarter Past Midnight', 199000),
      (2, 'e-track-std-2', ${STANDARD_EDITION_ID}, '${STANDARD_MBID}', 2, 'e1000000-0000-4000-8000-000000000012', 1, 2, 'Bad Decisions', 190000),
      (3, 'e-track-dlx-1', ${DELUXE_EDITION_ID}, '${DELUXE_MBID}', 1, 'e1000000-0000-4000-8000-000000000011', 1, 1, 'Quarter Past Midnight', 199000),
      (4, 'e-track-dlx-2', ${DELUXE_EDITION_ID}, '${DELUXE_MBID}', 2, 'e1000000-0000-4000-8000-000000000012', 1, 2, 'Bad Decisions', 190000),
      (5, 'e-track-dlx-3', ${DELUXE_EDITION_ID}, '${DELUXE_MBID}', 3, 'e1000000-0000-4000-8000-000000000013', 1, 3, 'Another Place', 205000),
      (6, 'e-track-dlx-4', ${DELUXE_EDITION_ID}, '${DELUXE_MBID}', 4, 'e1000000-0000-4000-8000-000000000014', 1, 4, 'Joy', 210000);
    INSERT INTO MetadataProfiles (
      id, name, release_type_policy, explicit_policy, require_provider_availability, redundancy_enabled
    ) VALUES (1, 'Default', '{}', 'allow', ${options.requireProviderAvailability === false ? 0 : 1}, 0);
    INSERT INTO quality_profiles (
      id, name, allowed_source_formats, preference_order, cutoff,
      continue_upgrades, fallback_policy, output_format, transcode_policy
    ) VALUES (
      1, 'High Quality', '["lossless","hires-lossless"]', '["hires-lossless","lossless"]',
      'lossless', 0, 'best_allowed', '{"codec":"flac"}', 'preserve'
    );
    INSERT INTO Libraries (id, name, root_path, metadata_profile_id, quality_profile_id, enabled)
    VALUES (${LIBRARY_ID}, 'Stereo', '/library/stereo', 1, 1, 1);
    INSERT INTO LibraryArtists (id, library_id, managed_artist_id, monitored)
    VALUES (1, ${LIBRARY_ID}, 1, 1);
  `);
}

function ingestProviderEdition(input: {
  provider: string;
  providerId: string;
  canonicalReleaseId: number;
  quality: "lossless" | "hires-lossless";
  recordings: ReadonlyArray<{ isrc: string; title: string; durationMs: number }>;
}): void {
  new ProviderReleaseIngestionService(db).ingest({
    release: {
      provider: input.provider,
      entityType: "release",
      providerId: input.providerId,
      title: "Doom Days",
      availability: "available",
    },
    canonicalReleaseId: input.canonicalReleaseId,
    matcherVersion: 1,
    releaseAudioVariants: [{
      variantKey: input.quality,
      qualityClass: input.quality,
      codec: "flac",
      availability: "available",
    }],
    members: input.recordings.map((recording, index) => ({
      item: {
        provider: input.provider,
        entityType: "track" as const,
        providerId: `${input.providerId}-${index + 1}`,
        title: recording.title,
        isrc: recording.isrc,
        durationMs: recording.durationMs,
        availability: "available",
      },
      mediumPosition: 1,
      position: index + 1,
    })),
  });
}

const STANDARD_TRACKS = [
  { isrc: "GBUM71801770", title: "Quarter Past Midnight", durationMs: 199000 },
  { isrc: "GBUM71901234", title: "Bad Decisions", durationMs: 190000 },
];
const DELUXE_TRACKS = [
  ...STANDARD_TRACKS,
  { isrc: "GBUM71901235", title: "Another Place", durationMs: 205000 },
  { isrc: "GBUM71901236", title: "Joy", durationMs: 210000 },
];

/** TIDAL covers the deluxe fully; Apple's standard release covers only 1-2. */
function ingestProviders(): void {
  ingestProviderEdition({
    provider: "tidal",
    providerId: "tidal-deluxe",
    canonicalReleaseId: DELUXE_EDITION_ID,
    quality: "lossless",
    recordings: DELUXE_TRACKS,
  });
  // One Provider Edition, two different canonical relations: exact to the
  // standard Edition and a subset of the deluxe one.
  ingestProviderEdition({
    provider: "apple-music",
    providerId: "apple-standard",
    canonicalReleaseId: STANDARD_EDITION_ID,
    quality: "hires-lossless",
    recordings: STANDARD_TRACKS,
  });
  ingestProviderEdition({
    provider: "apple-music",
    providerId: "apple-standard",
    canonicalReleaseId: DELUXE_EDITION_ID,
    quality: "hires-lossless",
    recordings: STANDARD_TRACKS,
  });
}

function planEverything(): void {
  const planning = new AcquisitionPlanningService(db);
  for (const editionId of [STANDARD_EDITION_ID, DELUXE_EDITION_ID]) {
    planning.compute({
      libraryId: LIBRARY_ID,
      editionId,
      providerPriority: ["tidal", "apple-music"],
      plannerVersion: 1,
    });
  }
}

function monitoredEditionIds(): number[] {
  return (db.prepare(`
    SELECT edition_id FROM LibraryEditions WHERE library_id = ? ORDER BY edition_id
  `).all(LIBRARY_ID) as Array<{ edition_id: number }>).map(({ edition_id }) => edition_id);
}

function planCount(editionId: number): number {
  return (db.prepare(`
    SELECT COUNT(*) AS count FROM AcquisitionPlans WHERE library_id = ? AND edition_id = ?
  `).get(LIBRARY_ID, editionId) as { count: number }).count;
}

function curate(): void {
  new LibraryCurationService(db).curateLibrary({
    libraryId: LIBRARY_ID,
    curationVersion: 1,
    acquisitionPlannerVersion: 1,
    providerPriority: ["tidal", "apple-music"],
  });
}

// ---------------------------------------------------------------------------
// Canonical contents are never redefined by what a provider happens to offer
// ---------------------------------------------------------------------------

test("planning needs no monitored row, and leaves monitoring alone", () => {
  seedCatalog();
  ingestProviders();

  planEverything();

  assert.deepEqual(monitoredEditionIds(), [],
    "ingestion and planning must not monitor anything");
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM LibraryAlbums").get() as { count: number }).count,
    0,
    "no Album became monitored either",
  );
  assert.ok(planCount(STANDARD_EDITION_ID) > 0, "the standard edition has candidate plans");
  assert.ok(planCount(DELUXE_EDITION_ID) > 0, "the deluxe edition has candidate plans");
});

test("a plan reports the canonical tracks it cannot deliver", () => {
  seedCatalog();
  ingestProviders();
  planEverything();

  // Apple's standard release covers 2 of the deluxe Edition's 4 tracks.
  const partial = db.prepare(`
    SELECT id, coverage, target_track_count
    FROM AcquisitionPlans
    WHERE library_id = ? AND edition_id = ? AND provider = 'apple-music'
    ORDER BY coverage DESC LIMIT 1
  `).get(LIBRARY_ID, DELUXE_EDITION_ID) as {
    id: number; coverage: number; target_track_count: number;
  } | undefined;
  assert.ok(partial, "a partial plan is still a plan");
  assert.equal(partial.target_track_count, 4, "the denominator is the canonical track count");
  assert.equal(partial.coverage, 2);

  const missing = (db.prepare(`
    SELECT track.position
    FROM Tracks track
    WHERE track.album_edition_id = ?
      AND NOT EXISTS (
        SELECT 1 FROM AcquisitionPlanTracks assignment
        WHERE assignment.plan_id = ? AND assignment.track_id = track.id
      )
    ORDER BY track.position
  `).all(DELUXE_EDITION_ID, partial.id) as Array<{ position: number }>).map((t) => t.position);
  assert.deepEqual(missing, [3, 4], "uncovered canonical tracks are named, not dropped");
});

test("the canonical track list is never trimmed to what a provider offers", () => {
  seedCatalog();
  ingestProviders();
  planEverything();
  curate();

  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM Tracks WHERE album_edition_id = ?")
      .get(DELUXE_EDITION_ID) as { count: number }).count,
    4,
    "all four canonical tracks survive planning and curation",
  );
});

// ---------------------------------------------------------------------------
// Curation is the only step that decides what is monitored
// ---------------------------------------------------------------------------

test("curation inserts the library rows, and row existence is the monitored state", () => {
  seedCatalog();
  ingestProviders();
  curate();

  assert.ok(monitoredEditionIds().length > 0, "curation monitored something");
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM LibraryAlbums WHERE library_id = ?")
      .get(LIBRARY_ID) as { count: number }).count,
    1,
    "the album is monitored because its row exists",
  );
  assert.deepEqual(
    db.prepare("SELECT name FROM pragma_table_info('LibraryEditions') WHERE name = 'monitored'").all(),
    [],
    "there is no second way to say an edition is monitored",
  );
});

test("an edition curation passed over still carries its plans as alternatives", () => {
  seedCatalog();
  ingestProviders();
  curate();

  const monitored = monitoredEditionIds();
  const unmonitored = [STANDARD_EDITION_ID, DELUXE_EDITION_ID]
    .filter((editionId) => !monitored.includes(editionId));
  assert.ok(unmonitored.length > 0, "curation picked a subset, which is the point");
  for (const editionId of unmonitored) {
    assert.ok(planCount(editionId) > 0,
      `edition ${editionId} is unmonitored but still offerable`);
  }

  // ...and the Album page can see them.
  const availability = new LibraryReleaseSelectionService(db).getAvailability(ALBUM_MBID);
  const unmonitoredViews = availability.libraries[0].selections
    .filter((selection) => !selection.monitored);
  assert.ok(unmonitoredViews.length > 0);
  assert.ok(unmonitoredViews.every((selection) => selection.plans.length > 0),
    "availability exposes plans beneath unmonitored editions");
  assert.ok(unmonitoredViews.every((selection) => selection.plan === null),
    "but none of them is the plan that executes");
});

test("selected-only readers exclude unmonitored editions for free", () => {
  seedCatalog();
  ingestProviders();
  planEverything();

  // Plans exist for both editions, but nothing is monitored.
  assert.ok(planCount(STANDARD_EDITION_ID) > 0 && planCount(DELUXE_EDITION_ID) > 0);
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM SelectedAcquisitionPlans")
      .get() as { count: number }).count,
    0,
    "no monitored edition means no plan executes",
  );

  new LibraryReleaseSelectionService(db).selectRelease({
    releaseGroupMbid: ALBUM_MBID,
    libraryId: LIBRARY_ID,
    editionId: DELUXE_EDITION_ID,
  });
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM SelectedAcquisitionPlans")
      .get() as { count: number }).count,
    1,
    "exactly one plan executes once one edition is monitored",
  );
});

// ---------------------------------------------------------------------------
// Standard versus deluxe: the offers a user is actually shown
// ---------------------------------------------------------------------------

test("each canonical edition is offered the plans that target it", () => {
  seedCatalog();
  ingestProviders();
  planEverything();

  const availability = new LibraryReleaseSelectionService(db).getAvailability(ALBUM_MBID);
  const byEdition = new Map(availability.libraries[0].selections
    .map((selection) => [selection.editionId, selection]));

  const standard = byEdition.get(STANDARD_EDITION_ID)!;
  assert.deepEqual(
    [...new Set(standard.plans.map((plan) => plan.provider))],
    ["apple-music"],
    "only Apple has an offer for the standard edition",
  );
  assert.ok(standard.plans.every((plan) => plan.coverage === 2 && plan.targetTrackCount === 2));

  const deluxe = byEdition.get(DELUXE_EDITION_ID)!;
  assert.ok(deluxe.plans.some((plan) => plan.provider === "tidal" && plan.coverage === 4),
    "TIDAL covers the deluxe edition completely");
  assert.ok(deluxe.plans.every((plan) => plan.targetTrackCount === 4),
    "every deluxe plan is measured against the deluxe edition");
  // The Apple offer that is exact for the standard edition targets the deluxe
  // edition only as a partial alternative. It never monitors the standard one.
  assert.ok(deluxe.plans.some((plan) => plan.provider === "apple-music" && plan.coverage === 2));
  assert.equal(monitoredEditionIds().length, 0, "listing offers monitors nothing");
});

// ---------------------------------------------------------------------------
// Selecting: exclusive by default, additive on request
// ---------------------------------------------------------------------------

test("a normal plan click monitors that edition alone and runs that exact plan", () => {
  seedCatalog();
  ingestProviders();
  planEverything();
  const service = new LibraryReleaseSelectionService(db);

  // Start from the standard edition monitored, to prove replacement.
  service.selectRelease({
    releaseGroupMbid: ALBUM_MBID, libraryId: LIBRARY_ID, editionId: STANDARD_EDITION_ID,
  });
  assert.deepEqual(monitoredEditionIds(), [STANDARD_EDITION_ID]);

  const deluxePlans = service.getAvailability(ALBUM_MBID).libraries[0].selections
    .find((selection) => selection.editionId === DELUXE_EDITION_ID)!.plans;
  const tidal = deluxePlans.find((plan) => plan.provider === "tidal" && plan.coverage === 4)!;

  const after = service.choosePlan({
    releaseGroupMbid: ALBUM_MBID,
    libraryId: LIBRARY_ID,
    editionId: DELUXE_EDITION_ID,
    planKey: tidal.planKey,
  });

  assert.deepEqual(monitoredEditionIds(), [DELUXE_EDITION_ID],
    "use only this: the standard edition is no longer monitored");
  const selection = after.libraries[0].selections
    .find((entry) => entry.editionId === DELUXE_EDITION_ID)!;
  assert.equal(selection.representative, true, "the clicked edition becomes Primary");
  assert.equal(selection.plan?.planKey, tidal.planKey, "the exact clicked plan executes");
  assert.equal(selection.planSelectionMode, "manual");
  assert.equal(
    (db.prepare("SELECT locked FROM LibraryAlbums WHERE library_id = ? AND release_group_id = 1")
      .get(LIBRARY_ID) as { locked: number }).locked,
    0,
    "an ordinary selection must not press Lock",
  );
});

test("an additive click keeps the current editions and the current Primary", () => {
  seedCatalog();
  ingestProviders();
  planEverything();
  const service = new LibraryReleaseSelectionService(db);

  service.selectRelease({
    releaseGroupMbid: ALBUM_MBID, libraryId: LIBRARY_ID, editionId: DELUXE_EDITION_ID,
  });
  const standardPlan = service.getAvailability(ALBUM_MBID).libraries[0].selections
    .find((selection) => selection.editionId === STANDARD_EDITION_ID)!.plans[0];

  const after = service.choosePlan({
    releaseGroupMbid: ALBUM_MBID,
    libraryId: LIBRARY_ID,
    editionId: STANDARD_EDITION_ID,
    planKey: standardPlan.planKey,
    mode: "additive",
  });

  assert.deepEqual(monitoredEditionIds(), [STANDARD_EDITION_ID, DELUXE_EDITION_ID],
    "both editions stay monitored");
  const byEdition = new Map(after.libraries[0].selections
    .map((selection) => [selection.editionId, selection]));
  assert.equal(byEdition.get(DELUXE_EDITION_ID)!.representative, true,
    "the existing Primary is preserved");
  assert.equal(byEdition.get(STANDARD_EDITION_ID)!.representative, false,
    "the added edition is supplemental");
  assert.equal(byEdition.get(STANDARD_EDITION_ID)!.plan?.planKey, standardPlan.planKey);
});

test("switching a plan beneath one of several editions leaves the others alone", () => {
  seedCatalog();
  ingestProviders();
  planEverything();
  const service = new LibraryReleaseSelectionService(db);
  service.selectRelease({
    releaseGroupMbid: ALBUM_MBID, libraryId: LIBRARY_ID, editionId: DELUXE_EDITION_ID,
  });
  service.selectRelease({
    releaseGroupMbid: ALBUM_MBID, libraryId: LIBRARY_ID, editionId: STANDARD_EDITION_ID,
    mode: "additive",
  });

  const deluxePlans = service.getAvailability(ALBUM_MBID).libraries[0].selections
    .find((selection) => selection.editionId === DELUXE_EDITION_ID)!.plans;
  const alternative = deluxePlans.find((plan) => plan.provider === "apple-music")!;

  const after = service.choosePlan({
    releaseGroupMbid: ALBUM_MBID,
    libraryId: LIBRARY_ID,
    editionId: DELUXE_EDITION_ID,
    planKey: alternative.planKey,
    mode: "additive",
  });

  assert.deepEqual(monitoredEditionIds(), [STANDARD_EDITION_ID, DELUXE_EDITION_ID]);
  assert.equal(
    after.libraries[0].selections.find((s) => s.editionId === DELUXE_EDITION_ID)!.plan?.planKey,
    alternative.planKey,
  );
  assert.equal(
    after.libraries[0].selections.find((s) => s.editionId === DELUXE_EDITION_ID)!.representative,
    true,
    "an additive plan switch does not reshuffle the Primary",
  );
});

// ---------------------------------------------------------------------------
// Removing editions
// ---------------------------------------------------------------------------

test("removing one edition keeps the others; removing the Primary promotes deterministically", () => {
  seedCatalog();
  ingestProviders();
  planEverything();
  const service = new LibraryReleaseSelectionService(db);
  service.selectRelease({
    releaseGroupMbid: ALBUM_MBID, libraryId: LIBRARY_ID, editionId: DELUXE_EDITION_ID,
  });
  service.selectRelease({
    releaseGroupMbid: ALBUM_MBID, libraryId: LIBRARY_ID, editionId: STANDARD_EDITION_ID,
    mode: "additive",
  });

  const afterRemoval = service.removeEdition({
    releaseGroupMbid: ALBUM_MBID, libraryId: LIBRARY_ID, editionId: DELUXE_EDITION_ID,
  });
  assert.deepEqual(monitoredEditionIds(), [STANDARD_EDITION_ID]);
  assert.equal(
    afterRemoval.libraries[0].selections
      .find((selection) => selection.editionId === STANDARD_EDITION_ID)!.representative,
    true,
    "the remaining edition is promoted rather than left with no Primary",
  );
});

test("removing the last edition unmonitors the album but keeps its plans and files", () => {
  seedCatalog();
  ingestProviders();
  planEverything();
  const service = new LibraryReleaseSelectionService(db);
  service.selectRelease({
    releaseGroupMbid: ALBUM_MBID, libraryId: LIBRARY_ID, editionId: DELUXE_EDITION_ID,
  });

  service.removeEdition({
    releaseGroupMbid: ALBUM_MBID, libraryId: LIBRARY_ID, editionId: DELUXE_EDITION_ID,
  });

  assert.deepEqual(monitoredEditionIds(), []);
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM LibraryAlbums WHERE library_id = ?")
      .get(LIBRARY_ID) as { count: number }).count,
    0,
    "no monitored edition means the album is no longer monitored here",
  );
  assert.ok(planCount(DELUXE_EDITION_ID) > 0,
    "candidate plans survive unmonitoring, so the album can be offered again");
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM Tracks").get() as { count: number }).count,
    6,
    "canonical metadata survives unmonitoring",
  );
});

// ---------------------------------------------------------------------------
// Lock
// ---------------------------------------------------------------------------

test("a locked album refuses every monitoring change until it is unlocked", () => {
  seedCatalog();
  ingestProviders();
  planEverything();
  const service = new LibraryReleaseSelectionService(db);
  service.selectRelease({
    releaseGroupMbid: ALBUM_MBID, libraryId: LIBRARY_ID, editionId: DELUXE_EDITION_ID,
  });
  AlbumCommandService.updateAlbum(ALBUM_MBID, true, true, { kind: "library", libraryId: LIBRARY_ID });

  const standardPlanKey = service.getAvailability(ALBUM_MBID).libraries[0].selections
    .find((selection) => selection.editionId === STANDARD_EDITION_ID)!.plans[0].planKey;

  assert.throws(() => service.selectRelease({
    releaseGroupMbid: ALBUM_MBID, libraryId: LIBRARY_ID, editionId: STANDARD_EDITION_ID,
  }), /locked/i, "edition replacement is blocked");
  assert.throws(() => service.choosePlan({
    releaseGroupMbid: ALBUM_MBID, libraryId: LIBRARY_ID, editionId: STANDARD_EDITION_ID,
    planKey: standardPlanKey, mode: "additive",
  }), /locked/i, "additive selection is blocked");
  assert.throws(() => service.removeEdition({
    releaseGroupMbid: ALBUM_MBID, libraryId: LIBRARY_ID, editionId: DELUXE_EDITION_ID,
  }), /locked/i, "removal is blocked");
  assert.throws(() => service.makeRepresentative({
    releaseGroupMbid: ALBUM_MBID, libraryId: LIBRARY_ID, editionId: DELUXE_EDITION_ID,
  }), /locked/i, "representative change is blocked");

  assert.deepEqual(monitoredEditionIds(), [DELUXE_EDITION_ID], "nothing moved");

  AlbumCommandService.updateAlbum(ALBUM_MBID, true, false, { kind: "library", libraryId: LIBRARY_ID });
  service.selectRelease({
    releaseGroupMbid: ALBUM_MBID, libraryId: LIBRARY_ID, editionId: STANDARD_EDITION_ID,
  });
  assert.deepEqual(monitoredEditionIds(), [STANDARD_EDITION_ID],
    "an explicit unlock is what releases it — never a silent one");
});

test("curation may not drop a locked album's editions", () => {
  seedCatalog();
  ingestProviders();
  planEverything();
  new LibraryReleaseSelectionService(db).selectRelease({
    releaseGroupMbid: ALBUM_MBID, libraryId: LIBRARY_ID, editionId: STANDARD_EDITION_ID,
  });
  AlbumCommandService.updateAlbum(ALBUM_MBID, true, true, { kind: "library", libraryId: LIBRARY_ID });

  curate();

  assert.ok(monitoredEditionIds().includes(STANDARD_EDITION_ID),
    "the locked choice survives a curation cycle");
});

// ---------------------------------------------------------------------------
// Provider availability policy
// ---------------------------------------------------------------------------

test("require_provider_availability decides eligibility without inventing a plan", () => {
  // With availability required and no provider data at all, curation monitors
  // nothing rather than monitoring something it cannot acquire.
  seedCatalog({ requireProviderAvailability: true });
  curate();
  assert.deepEqual(monitoredEditionIds(), [],
    "no viable plan means no automatic monitoring");

  // With it disabled, the same catalogue is monitored and simply has no plan.
  seedCatalog({ requireProviderAvailability: false });
  curate();
  const monitored = monitoredEditionIds();
  assert.ok(monitored.length > 0, "availability is optional, so an edition is still monitored");
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM AcquisitionPlans").get() as { count: number }).count,
    0,
    "and no plan was fabricated to justify it",
  );
  const availability = new LibraryReleaseSelectionService(db).getAvailability(ALBUM_MBID);
  assert.ok(availability.libraries[0].selections
    .some((selection) => selection.monitored && selection.plan === null),
    "the UI can say: monitored, no provider offer currently available");
});
