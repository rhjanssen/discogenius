import assert from "node:assert/strict";
import { after, test } from "node:test";
import { prepareActiveSchemaEnv, openActiveSchemaDb, closeActiveSchemaDb } from "../../test-support/active-schema-fixture.js";

const { tempDir } = prepareActiveSchemaEnv("matcher-rollout-safety");
const { db, dbModule } = await openActiveSchemaDb();
const { AcquisitionPlanningService, ACQUISITION_PLANNER_VERSION } = await import("./acquisition-planning-service.js");
const { LibraryCurationService } = await import("./library-curation-service.js");
const { evaluateAcquisitionDownload } = await import("./acquisition-download-command.js");
const { queueAcquisitionPlan } = await import("./acquisition-plan-executor.js");
const { LibraryFilesService } = await import("../mediafiles/library-files.js");
const { updateConfig } = await import("../config/config.js");
after(() => closeActiveSchemaDb(dbModule, tempDir));

test("v4 automatic matches stay monitored, keep their files, and still download", async () => {
  updateConfig("monitoring", { remove_unmonitored_files: true });
  const library = db.prepare(`
    SELECT id FROM Libraries WHERE name = 'Stereo' AND enabled = 1
  `).get() as { id: number };
  db.prepare(`
    INSERT INTO ArtistMetadata (id, mbid, name) VALUES (1, 'artist-safe', 'Safe Artist')
  `).run();
  db.prepare(`
    INSERT INTO LibraryArtists (library_id, artist_metadata_id, policy, credited_scope)
    VALUES (?, 1, 'all', 'release_and_track_credit')
  `).run(library.id);

  const seedEdition = (input: {
    editionId: number;
    title: string;
    tracks: Array<{ trackId: number; title: string; position: number; itemId: number; providerTrackId: string }>;
  }) => {
    db.prepare(`
      INSERT INTO Albums (id, mbid, artist_metadata_id, title, artist_mbid, primary_type)
      VALUES (?, ?, 1, ?, 'artist-safe', 'Album')
    `).run(input.editionId, `group-${input.title}`, input.title);
    db.prepare(`
      INSERT INTO AlbumEditions (id, mbid, release_group_id, title, release_group_mbid, artist_mbid)
      VALUES (?, ?, ?, ?, ?, 'artist-safe')
    `).run(input.editionId, `rel-${input.title}`, input.editionId, input.title, `group-${input.title}`);
    db.prepare(`
      INSERT INTO LibraryAlbums (library_id, release_group_id, selection_mode, curation_version)
      VALUES (?, ?, 'auto', 1)
    `).run(library.id, input.editionId);
    db.prepare(`
      INSERT INTO LibraryEditions (library_id, edition_id, selection_mode, reason, curation_version)
      VALUES (?, ?, 'auto', 'fixture', 1)
    `).run(library.id, input.editionId);
    const releaseItemId = input.editionId * 10;
    db.prepare(`
      INSERT INTO ProviderItems (id, provider, entity_type, provider_id, title, availability)
      VALUES (?, 'tidal', 'release', ?, ?, 'available')
    `).run(releaseItemId, `release-${input.title}`, input.title);
    db.prepare(`
      INSERT INTO ProviderEditionMatches (
        id, provider_edition_item_id, edition_id, relation, match_state,
        decision_source, confidence, method, matcher_version,
        matched_track_count, source_track_count, target_track_count,
        source_coverage, target_coverage
      ) VALUES (?, ?, ?, 'exact', 'accepted', 'automatic', 1, 'fixture', 4, ?, ?, ?, 1, 1)
    `).run(
      releaseItemId, releaseItemId, input.editionId,
      input.tracks.length, input.tracks.length, input.tracks.length,
    );
    for (const track of input.tracks) {
      db.prepare(`
        INSERT INTO Recordings (id, mbid, title, length_ms) VALUES (?, ?, ?, 180000)
      `).run(track.trackId, `rec-${track.trackId}`, track.title);
      db.prepare(`
        INSERT INTO Tracks (
          id, mbid, album_edition_id, recording_id, medium_position, position, title,
          length_ms, release_mbid, recording_mbid
        ) VALUES (?, ?, ?, ?, 1, ?, ?, 180000, ?, ?)
      `).run(
        track.trackId, `track-${track.trackId}`, input.editionId, track.trackId,
        track.position, track.title, `rel-${input.title}`, `rec-${track.trackId}`,
      );
      db.prepare(`
        INSERT INTO ProviderItems (id, provider, entity_type, provider_id, title, duration_ms, availability)
        VALUES (?, 'tidal', 'track', ?, ?, 180000, 'available')
      `).run(track.itemId, track.providerTrackId, track.title);
      db.prepare(`
        INSERT INTO ProviderEditionMembers (
          id, provider_edition_item_id, member_item_id, medium_position, position
        ) VALUES (?, ?, ?, 1, ?)
      `).run(track.trackId, releaseItemId, track.itemId, track.position);
      db.prepare(`
        INSERT INTO ProviderItemAudioVariants (
          id, provider_item_id, variant_key, quality_class, availability
        ) VALUES (?, ?, 'lossless', 'lossless', 'available')
      `).run(track.itemId, track.itemId);
      db.prepare(`
        INSERT INTO ProviderTrackMatches (
          id, provider_track_item_id, provider_edition_member_id, provider_edition_match_id,
          track_id, recording_id, match_state, decision_source, confidence, method, matcher_version
        ) VALUES (?, ?, ?, ?, ?, ?, 'accepted', 'automatic', 1, 'fixture', 4)
      `).run(track.trackId, track.itemId, track.trackId, releaseItemId, track.trackId, track.trackId);
    }
  };

  seedEdition({
    editionId: 1,
    title: "Kept",
    tracks: [
      { trackId: 1, title: "Kept One", position: 1, itemId: 101, providerTrackId: "kept-1" },
      { trackId: 2, title: "Kept Two", position: 2, itemId: 102, providerTrackId: "kept-2" },
    ],
  });
  seedEdition({
    editionId: 2,
    title: "Shared",
    tracks: [
      { trackId: 3, title: "Intro", position: 1, itemId: 201, providerTrackId: "shared-intro" },
      { trackId: 4, title: "Intro", position: 2, itemId: 202, providerTrackId: "shared-intro-2" },
    ],
  });
  db.prepare("UPDATE ProviderEditionMembers SET member_item_id = 201 WHERE id = 4").run();
  db.prepare("UPDATE ProviderTrackMatches SET provider_track_item_id = 201 WHERE id = 4").run();

  const insertFile = db.prepare(`
    INSERT INTO TrackFiles (
      artist_metadata_id, release_group_id, album_edition_id, track_id, recording_id,
      library_id, library_slot, library_root, file_path, relative_path, filename, extension,
      file_type, file_class
    ) VALUES (1, ?, ?, ?, ?, ?, 'stereo', 'stereo', ?, ?, ?, 'flac', 'track', 'audio')
  `);
  insertFile.run(1, 1, 1, 1, library.id, "/library/kept-1.flac", "kept-1.flac", "kept-1.flac");
  insertFile.run(1, 1, 2, 2, library.id, "/library/kept-2.flac", "kept-2.flac", "kept-2.flac");
  insertFile.run(2, 2, 3, 3, library.id, "/library/shared-1.flac", "shared-1.flac", "shared-1.flac");
  insertFile.run(2, 2, 4, 4, library.id, "/library/shared-2.flac", "shared-2.flac", "shared-2.flac");
  const filesBefore = (db.prepare("SELECT COUNT(*) AS n FROM TrackFiles").get() as { n: number }).n;

  const planner = new AcquisitionPlanningService(db);
  const keptPlanId = planner.compute({
    libraryId: library.id,
    editionId: 1,
    providerPriority: ["tidal"],
    plannerVersion: ACQUISITION_PLANNER_VERSION,
  });
  assert.ok(keptPlanId, "a v4 automatic match is still a candidate");
  const keptTracks = (db.prepare(`
    SELECT COUNT(*) AS n FROM AcquisitionPlanTracks WHERE plan_id = ?
  `).get(keptPlanId) as { n: number }).n;
  assert.equal(keptTracks, 2);
  assert.equal(
    evaluateAcquisitionDownload(db, keptPlanId!, { allowUnverifiedProjection: true }).status,
    "ready",
  );
  const queued = queueAcquisitionPlan(db, keptPlanId!, { notify: false });
  assert.equal(queued.queued, true);

  const sharedPlanId = planner.compute({
    libraryId: library.id,
    editionId: 2,
    providerPriority: ["tidal"],
    plannerVersion: ACQUISITION_PLANNER_VERSION,
  });
  if (sharedPlanId) {
    const sharedItems = db.prepare(`
      SELECT item.provider_id AS provider_id
      FROM AcquisitionPlanTracks plan_track
      JOIN ProviderTrackMatches track_match ON track_match.id = plan_track.provider_track_match_id
      JOIN ProviderItems item ON item.id = track_match.provider_track_item_id
      WHERE plan_track.plan_id = ?
    `).all(sharedPlanId) as Array<{ provider_id: string }>;
    assert.equal(sharedItems.some((row) => row.provider_id === "shared-intro"), false);
  }

  new LibraryCurationService(db).curateLibrary({
    libraryId: library.id,
    providerPriority: ["tidal"],
    acquisitionPlannerVersion: ACQUISITION_PLANNER_VERSION,
    curationVersion: 2,
  });

  const monitored = new Set((db.prepare(`
    SELECT edition_id FROM LibraryEditions WHERE library_id = ?
  `).all(library.id) as Array<{ edition_id: number }>).map((row) => row.edition_id));
  assert.equal(monitored.has(1), true);
  assert.equal(monitored.has(2), true);

  const pruned = LibraryFilesService.pruneUnmonitoredFiles("artist-safe");
  assert.equal(pruned.deleted, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM TrackFiles").get() as { n: number }).n, filesBefore);

  const keptAfter = db.prepare(`
    SELECT id FROM AcquisitionPlans
    WHERE library_id = ? AND edition_id = 1 AND state = 'current' AND coverage > 0
  `).get(library.id) as { id: number } | undefined;
  assert.ok(keptAfter, "curation leaves the v4 edition with plan candidates");
  assert.notEqual(
    evaluateAcquisitionDownload(db, keptAfter.id, { allowUnverifiedProjection: true }).status,
    "offer_refresh_required",
  );
});
