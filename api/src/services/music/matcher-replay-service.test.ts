import assert from "node:assert/strict";
import { after, test } from "node:test";
import { prepareActiveSchemaEnv, openActiveSchemaDb, closeActiveSchemaDb } from "../../test-support/active-schema-fixture.js";
import { PROVIDER_TRACK_MATCHER_VERSION } from "./provider-track-matcher.js";

const { tempDir } = prepareActiveSchemaEnv("matcher-replay");
const { db, dbModule } = await openActiveSchemaDb();
const {
  countStaleAutomaticMatches,
  replayMatcherVersionBatch,
  resetStoredMatcherReplayForTests,
} = await import("./matcher-replay-service.js");
after(() => closeActiveSchemaDb(dbModule, tempDir));

db.prepare(
  "INSERT OR IGNORE INTO ArtistMetadata (id, mbid, name) VALUES (1, 'artist-replay', 'Replay')",
).run();

function seedRelease(input: {
  editionId: number;
  releaseItemId: number;
  tracks: Array<{ trackId: number; title: string; position: number; itemId: number; providerTrackId: string }>;
}): void {
  const mbid = `rel-${input.editionId}`;
  db.prepare(`
    INSERT INTO Albums (id, mbid, title, artist_mbid, primary_type)
    VALUES (?, ?, ?, 'artist-replay', 'Album')
  `).run(input.editionId, `group-${input.editionId}`, `Album ${input.editionId}`);
  db.prepare(`
    INSERT INTO AlbumEditions (id, mbid, release_group_id, title, release_group_mbid, artist_mbid)
    VALUES (?, ?, ?, ?, ?, 'artist-replay')
  `).run(input.editionId, mbid, input.editionId, `Album ${input.editionId}`, `group-${input.editionId}`);
  db.prepare(`
    INSERT INTO ProviderItems (id, provider, entity_type, provider_id, title, availability)
    VALUES (?, 'tidal', 'release', ?, ?, 'available')
  `).run(input.releaseItemId, `release-${input.releaseItemId}`, `Album ${input.editionId}`);
  db.prepare(`
    INSERT INTO ProviderEditionMatches (
      id, provider_edition_item_id, edition_id, relation, match_state,
      decision_source, confidence, method, matcher_version,
      matched_track_count, source_track_count, target_track_count,
      source_coverage, target_coverage
    ) VALUES (?, ?, ?, 'exact', 'accepted', 'automatic', 1, 'fixture', 4, ?, ?, ?, 1, 1)
  `).run(
    input.releaseItemId,
    input.releaseItemId,
    input.editionId,
    input.tracks.length,
    input.tracks.length,
    input.tracks.length,
  );
  for (const track of input.tracks) {
    db.prepare(`
      INSERT INTO Recordings (id, mbid, title, length_ms, is_video)
      VALUES (?, ?, ?, 180000, 0)
    `).run(track.trackId, `rec-${track.trackId}`, track.title);
    db.prepare(`
      INSERT INTO Tracks (
        id, mbid, album_edition_id, recording_id, medium_position, position, title,
        length_ms, release_mbid, recording_mbid
      ) VALUES (?, ?, ?, ?, 1, ?, ?, 180000, ?, ?)
    `).run(
      track.trackId,
      `track-${track.trackId}`,
      input.editionId,
      track.trackId,
      track.position,
      track.title,
      mbid,
      `rec-${track.trackId}`,
    );
    db.prepare(`
      INSERT INTO ProviderItems (
        id, provider, entity_type, provider_id, title, duration_ms, availability
      ) VALUES (?, 'tidal', 'track', ?, ?, 180000, 'available')
    `).run(track.itemId, track.providerTrackId, track.title);
    db.prepare(`
      INSERT INTO ProviderEditionMembers (
        id, provider_edition_item_id, member_item_id, medium_position, position,
        contextual_title, contextual_duration_ms
      ) VALUES (?, ?, ?, 1, ?, ?, 180000)
    `).run(track.trackId, input.releaseItemId, track.itemId, track.position, track.title);
    db.prepare(`
      INSERT INTO ProviderTrackMatches (
        id, provider_track_item_id, provider_edition_member_id, provider_edition_match_id,
        track_id, recording_id, match_state, decision_source, confidence, method, matcher_version
      ) VALUES (?, ?, ?, ?, ?, ?, 'accepted', 'automatic', 1, 'fixture', 4)
    `).run(
      track.trackId,
      track.itemId,
      track.trackId,
      input.releaseItemId,
      track.trackId,
      track.trackId,
    );
  }
}

test("replay walks stale releases in batches and a second pass is a no-op", async () => {
  resetStoredMatcherReplayForTests();
  seedRelease({
    editionId: 1,
    releaseItemId: 10,
    tracks: [
      { trackId: 1, title: "One", position: 1, itemId: 101, providerTrackId: "t-1" },
      { trackId: 2, title: "Two", position: 2, itemId: 102, providerTrackId: "t-2" },
    ],
  });
  seedRelease({
    editionId: 2,
    releaseItemId: 20,
    tracks: [
      { trackId: 3, title: "Three", position: 1, itemId: 103, providerTrackId: "t-3" },
    ],
  });
  assert.equal(countStaleAutomaticMatches(), 3);

  const first = await replayMatcherVersionBatch({ limit: 1 });
  assert.equal(first, 1);
  const versions = db.prepare(`
    SELECT provider_edition_match_id AS edition_match_id, matcher_version
    FROM ProviderTrackMatches
    WHERE match_state = 'accepted'
    ORDER BY id
  `).all() as Array<{ edition_match_id: number; matcher_version: number }>;
  assert.equal(versions.filter((row) => row.matcher_version === PROVIDER_TRACK_MATCHER_VERSION).length, 2);
  assert.equal(versions.filter((row) => row.matcher_version === 4).length, 1);

  const second = await replayMatcherVersionBatch({ limit: 1 });
  assert.equal(second, 1);
  assert.equal(countStaleAutomaticMatches(), 0);
  const third = await replayMatcherVersionBatch({ limit: 1 });
  assert.equal(third, 0);
  assert.equal(countStaleAutomaticMatches(), 0);
});

test("replay drops a shared item and keeps a duplicate listing of one track", async () => {
  resetStoredMatcherReplayForTests();
  seedRelease({
    editionId: 3,
    releaseItemId: 30,
    tracks: [
      { trackId: 31, title: "Intro", position: 1, itemId: 301, providerTrackId: "intro" },
      { trackId: 32, title: "Intro", position: 2, itemId: 302, providerTrackId: "intro-b" },
    ],
  });
  db.prepare(`
    UPDATE ProviderEditionMembers
    SET member_item_id = 301, contextual_title = 'Intro', contextual_duration_ms = 180000
    WHERE id = 32
  `).run();
  db.prepare(`
    UPDATE ProviderTrackMatches
    SET provider_track_item_id = 301, matcher_version = 4
    WHERE id = 32
  `).run();

  seedRelease({
    editionId: 4,
    releaseItemId: 40,
    tracks: [
      { trackId: 41, title: "Loop", position: 1, itemId: 401, providerTrackId: "loop" },
    ],
  });
  db.prepare(`
    INSERT INTO ProviderEditionMembers (
      id, provider_edition_item_id, member_item_id, medium_position, position,
      contextual_title, contextual_duration_ms
    ) VALUES (42, 40, 401, 1, 2, 'Loop', 180000)
  `).run();
  db.prepare(`
    INSERT INTO ProviderTrackMatches (
      id, provider_track_item_id, provider_edition_member_id, provider_edition_match_id,
      track_id, recording_id, match_state, decision_source, confidence, method, matcher_version
    ) VALUES (42, 401, 42, 40, 41, 41, 'accepted', 'automatic', 1, 'fixture', 4)
  `).run();

  const committed = await replayMatcherVersionBatch({ limit: 6 });
  assert.equal(committed, 2);

  const sharedAccepted = db.prepare(`
    SELECT COUNT(*) AS n FROM ProviderTrackMatches
    WHERE provider_edition_match_id = 30 AND match_state = 'accepted'
  `).get() as { n: number };
  assert.equal(sharedAccepted.n, 0, "one item viable for two tracks is accepted for neither");

  const duplicateAccepted = db.prepare(`
    SELECT COUNT(*) AS n FROM ProviderTrackMatches
    WHERE provider_track_item_id = 401 AND match_state = 'accepted' AND matcher_version = ?
  `).get(PROVIDER_TRACK_MATCHER_VERSION) as { n: number };
  assert.equal(duplicateAccepted.n, 1, "a duplicate listing of one track stays accepted");

  const again = await replayMatcherVersionBatch({ limit: 6 });
  assert.equal(again, 0);
});

test("a monitored edition with a missing file is replayed before an earlier stale row", async () => {
  resetStoredMatcherReplayForTests();
  seedRelease({
    editionId: 5,
    releaseItemId: 50,
    tracks: [
      { trackId: 51, title: "Early", position: 1, itemId: 501, providerTrackId: "early" },
    ],
  });
  seedRelease({
    editionId: 6,
    releaseItemId: 60,
    tracks: [
      { trackId: 61, title: "Needed", position: 1, itemId: 601, providerTrackId: "needed" },
    ],
  });
  const library = db.prepare("SELECT id FROM Libraries WHERE name = 'Stereo'").get() as { id: number };
  db.prepare(`
    INSERT INTO LibraryEditions (library_id, edition_id, selection_mode, reason, curation_version)
    VALUES (?, 6, 'auto', 'fixture', 1)
  `).run(library.id);
  const first = await replayMatcherVersionBatch({ limit: 1 });
  assert.equal(first, 1);
  const needed = db.prepare(`
    SELECT matcher_version FROM ProviderTrackMatches WHERE id = 61
  `).get() as { matcher_version: number };
  const early = db.prepare(`
    SELECT matcher_version FROM ProviderTrackMatches WHERE id = 51
  `).get() as { matcher_version: number };
  assert.equal(needed.matcher_version, PROVIDER_TRACK_MATCHER_VERSION);
  assert.equal(early.matcher_version, 4);
});

function matcherVersion(trackMatchId: number): number {
  return (db.prepare(
    "SELECT matcher_version FROM ProviderTrackMatches WHERE id = ?",
  ).get(trackMatchId) as { matcher_version: number }).matcher_version;
}

test("an in-use plan defers only its release and the replay continues", async () => {
  resetStoredMatcherReplayForTests();
  seedRelease({
    editionId: 70,
    releaseItemId: 700,
    tracks: [
      { trackId: 700, title: "Owned", position: 1, itemId: 1700, providerTrackId: "owned" },
    ],
  });
  seedRelease({
    editionId: 71,
    releaseItemId: 710,
    tracks: [
      { trackId: 710, title: "Free", position: 1, itemId: 1710, providerTrackId: "free" },
    ],
  });
  seedRelease({
    editionId: 72,
    releaseItemId: 720,
    tracks: [
      { trackId: 720, title: "Later", position: 1, itemId: 1720, providerTrackId: "later" },
    ],
  });
  const library = db.prepare("SELECT id FROM Libraries WHERE name = 'Stereo'").get() as { id: number };
  const monitor = db.prepare(`
    INSERT INTO LibraryEditions (library_id, edition_id, selection_mode, reason, curation_version)
    VALUES (?, ?, 'auto', 'fixture', 1)
  `);
  monitor.run(library.id, 70);
  monitor.run(library.id, 71);
  db.prepare(`
    INSERT INTO AcquisitionPlans (
      id, library_id, edition_id, provider, composition, download_mode, state,
      plan_key, coverage, target_track_count, planner_version, policy_hash, computed_at
    ) VALUES (?, ?, 70, 'tidal', 'single_source', 'album', 'current', 'owned-70', 1, 1, 3, 'owned', CURRENT_TIMESTAMP)
  `).run(7001, library.id);
  db.prepare(`
    INSERT INTO commands (name, payload, status)
    VALUES ('DownloadAlbum', ?, 'started')
  `).run(JSON.stringify({ acquisitionPlanId: 7001 }));

  await replayMatcherVersionBatch({ limit: 6 });
  assert.equal(matcherVersion(710), PROVIDER_TRACK_MATCHER_VERSION);
  assert.equal(matcherVersion(700), 4);
  assert.equal(matcherVersion(720), 4);

  await replayMatcherVersionBatch({ limit: 6 });
  assert.equal(matcherVersion(720), PROVIDER_TRACK_MATCHER_VERSION, "the cursor walk is not pinned by the in-use release");
  assert.equal(matcherVersion(700), 4);

  db.prepare("DELETE FROM commands WHERE json_extract(payload, '$.acquisitionPlanId') = 7001").run();
  await replayMatcherVersionBatch({ limit: 6 });
  assert.equal(matcherVersion(700), PROVIDER_TRACK_MATCHER_VERSION);
});

test("a version-only replay bumps the plan hash without rebuilding it", async () => {
  resetStoredMatcherReplayForTests();
  seedRelease({
    editionId: 80,
    releaseItemId: 800,
    tracks: [
      { trackId: 800, title: "Steady", position: 1, itemId: 1800, providerTrackId: "steady" },
    ],
  });
  db.prepare(`
    INSERT INTO ProviderItemAudioVariants (id, provider_item_id, variant_key, quality_class, availability)
    VALUES (1800, 1800, 'lossless', 'lossless', 'available')
  `).run();
  const library = db.prepare("SELECT id FROM Libraries WHERE name = 'Stereo'").get() as { id: number };
  db.prepare(`
    INSERT INTO LibraryEditions (library_id, edition_id, selection_mode, reason, curation_version)
    VALUES (?, 80, 'auto', 'fixture', 1)
  `).run(library.id);
  const { AcquisitionPlanningService, ACQUISITION_PLANNER_VERSION, getAcquisitionProviderPriority } = await import("./acquisition-planning-service.js");
  const planner = new AcquisitionPlanningService(db);
  const planId = planner.compute({
    libraryId: library.id,
    editionId: 80,
    providerPriority: getAcquisitionProviderPriority(),
    plannerVersion: ACQUISITION_PLANNER_VERSION,
  });
  assert.ok(planId);
  const before = db.prepare(`
    SELECT id, policy_hash, computed_at FROM AcquisitionPlans WHERE id = ?
  `).get(planId) as { id: number; policy_hash: string; computed_at: string };
  const tracksBefore = db.prepare(`
    SELECT id FROM AcquisitionPlanTracks WHERE plan_id = ? ORDER BY id
  `).all(planId);

  await replayMatcherVersionBatch({ limit: 6 });
  assert.equal(matcherVersion(800), PROVIDER_TRACK_MATCHER_VERSION);
  const after = db.prepare(`
    SELECT id, policy_hash, computed_at, state FROM AcquisitionPlans WHERE id = ?
  `).get(planId) as { id: number; policy_hash: string; computed_at: string; state: string };
  assert.equal(after.id, before.id);
  assert.equal(after.state, "current");
  assert.equal(after.computed_at, before.computed_at);
  assert.notEqual(after.policy_hash, before.policy_hash);
  assert.deepEqual(
    db.prepare("SELECT id FROM AcquisitionPlanTracks WHERE plan_id = ? ORDER BY id").all(planId),
    tracksBefore,
  );

  planner.compute({
    libraryId: library.id,
    editionId: 80,
    providerPriority: getAcquisitionProviderPriority(),
    plannerVersion: ACQUISITION_PLANNER_VERSION,
  });
  assert.equal(
    (db.prepare("SELECT computed_at FROM AcquisitionPlans WHERE id = ?").get(planId) as { computed_at: string }).computed_at,
    before.computed_at,
  );

  db.prepare(`
    UPDATE ProviderItemAudioVariants
    SET quality_class = 'hires-lossless', variant_key = 'hires'
    WHERE id = 1800
  `).run();
  planner.compute({
    libraryId: library.id,
    editionId: 80,
    providerPriority: getAcquisitionProviderPriority(),
    plannerVersion: ACQUISITION_PLANNER_VERSION,
  });
  const rebuilt = db.prepare(`
    SELECT computed_at FROM AcquisitionPlans WHERE library_id = ? AND edition_id = 80 ORDER BY rank LIMIT 1
  `).get(library.id) as { computed_at: string } | undefined;
  assert.ok(rebuilt);
  assert.notEqual(rebuilt.computed_at, before.computed_at);
});

test("artist rematch defers an in-use release and commits its neighbour", async () => {
  resetStoredMatcherReplayForTests();
  seedRelease({
    editionId: 90,
    releaseItemId: 900,
    tracks: [
      { trackId: 900, title: "Held", position: 1, itemId: 1900, providerTrackId: "held" },
    ],
  });
  seedRelease({
    editionId: 91,
    releaseItemId: 910,
    tracks: [
      { trackId: 910, title: "Open", position: 1, itemId: 1910, providerTrackId: "open" },
    ],
  });
  const library = db.prepare("SELECT id FROM Libraries WHERE name = 'Stereo'").get() as { id: number };
  const monitor = db.prepare(`
    INSERT INTO LibraryEditions (library_id, edition_id, selection_mode, reason, curation_version)
    VALUES (?, ?, 'auto', 'fixture', 1)
  `);
  monitor.run(library.id, 90);
  monitor.run(library.id, 91);
  db.prepare(`
    INSERT INTO AcquisitionPlans (
      id, library_id, edition_id, provider, composition, download_mode, state,
      plan_key, coverage, target_track_count, planner_version, policy_hash, computed_at
    ) VALUES (9001, ?, 90, 'tidal', 'single_source', 'album', 'current', 'held-90', 1, 1, 3, 'held', CURRENT_TIMESTAMP)
  `).run(library.id);
  db.prepare(`
    INSERT INTO commands (name, payload, status)
    VALUES ('DownloadAlbum', ?, 'started')
  `).run(JSON.stringify({ acquisitionPlanId: 9001 }));
  const { RefreshAlbumService } = await import("./refresh-album-service.js");

  assert.equal(await RefreshAlbumService.rematchStoredProviderRelease("tidal", "release-900"), null);
  assert.equal(matcherVersion(900), 4);
  assert.ok(await RefreshAlbumService.rematchStoredProviderRelease("tidal", "release-910"));
  assert.equal(matcherVersion(910), PROVIDER_TRACK_MATCHER_VERSION);
  assert.equal(matcherVersion(900), 4);

  db.prepare("DELETE FROM commands WHERE json_extract(payload, '$.acquisitionPlanId') = 9001").run();
  assert.ok(await RefreshAlbumService.rematchStoredProviderRelease("tidal", "release-900"));
  assert.equal(matcherVersion(900), PROVIDER_TRACK_MATCHER_VERSION);
});
