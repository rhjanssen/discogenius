import assert from "node:assert/strict";
import { after, test } from "node:test";
import { prepareActiveSchemaEnv, openActiveSchemaDb, closeActiveSchemaDb } from "../../test-support/active-schema-fixture.js";
import { seedTestLibrary } from "../../test-support/library-fixtures.js";
import { prepareEditionTrackPositions } from "./catalog-track-reconciliation.js";
import { AcquisitionPlanRepository } from "../music/acquisition-plan-repository.js";

const { tempDir } = prepareActiveSchemaEnv("catalog-plan-invalidation");
const { db, dbModule } = await openActiveSchemaDb();
const library = seedTestLibrary(db, { name: "Plan invalidation", rootPath: tempDir });
after(() => closeActiveSchemaDb(dbModule, tempDir));

function fixture(run: (planId: number) => void): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      INSERT INTO ArtistMetadata(id,mbid,name) VALUES(1,'artist','Artist');
      INSERT INTO Albums(id,mbid,artist_mbid,title) VALUES(1,'group','artist','Group');
      INSERT INTO AlbumEditions(id,mbid,release_group_mbid,artist_mbid,title) VALUES(1,'release','group','artist','Edition');
      INSERT INTO Recordings(id,mbid,title) VALUES(1,'recording-1','One'),(2,'recording-2','Two');
      INSERT INTO Tracks(id,mbid,release_mbid,recording_mbid,medium_position,position,title)
        VALUES(1,'track-1','release','recording-1',1,1,'One'),(2,'track-2','release','recording-2',1,2,'Two');
      INSERT INTO ProviderItems(id,provider,entity_type,provider_id)
        VALUES(1,'tidal','release','source-release'),(2,'tidal','track','source-track');
      INSERT INTO ProviderEditionMatches(id,provider_edition_item_id,edition_id,relation,match_state,decision_source,confidence,method,matcher_version)
        VALUES(1,1,1,'exact','accepted','automatic',1,'test',1);
      INSERT INTO ProviderTrackMatches(id,provider_track_item_id,recording_id,match_state,decision_source,confidence,method,matcher_version)
        VALUES(1,2,1,'accepted','automatic',1,'test',1);
      INSERT INTO ProviderItemAudioVariants(id,provider_item_id,variant_key,quality_class)
        VALUES(1,2,'lossless','lossless');
    `);
    const plan = Number(db.prepare(`INSERT INTO AcquisitionPlans(library_id,edition_id,provider,composition,download_mode,state,plan_key,coverage,target_track_count,quality_tier,planner_version,policy_hash,computed_at)
      VALUES(?,1,'tidal','single_source','album','current','candidate',1,2,'lossless',1,'policy',CURRENT_TIMESTAMP)`).run(library).lastInsertRowid);
    const source = Number(db.prepare("INSERT INTO AcquisitionPlanSources(plan_id,provider_edition_match_id,role,sort_order) VALUES(?,1,'primary',0)").run(plan).lastInsertRowid);
    db.prepare("INSERT INTO AcquisitionPlanTracks(plan_id,track_id,source_id,provider_track_match_id,provider_audio_variant_id) VALUES(?,1,?,1,1)").run(plan, source);
    run(plan);
  } finally { db.exec("ROLLBACK"); }
}

function reconcile(): void {
  prepareEditionTrackPositions(db, "release", [{ Id: "track-2", RecordingId: "recording-2", MediumNumber: 1, TrackPosition: 1, TrackNumber: "1", TrackName: "Two", DurationMs: 1000 }]);
  db.prepare("UPDATE Tracks SET medium_position=1,position=1 WHERE id=2").run();
}

test("catalog reconciliation discards unused candidate plans and removes only obsolete tracks", () => fixture(plan => {
  reconcile();
  assert.equal(db.prepare("SELECT id FROM AcquisitionPlans WHERE id=?").get(plan), undefined);
  assert.equal(db.prepare("SELECT id FROM AcquisitionPlanTracks WHERE plan_id=?").get(plan), undefined);
  assert.equal(db.prepare("SELECT id FROM Tracks WHERE id=1").get(), undefined);
  assert.ok(db.prepare("SELECT id FROM ProviderTrackMatches WHERE id=1").get());
  assert.deepEqual(db.pragma("foreign_key_check"), []);
}));

for (const holder of ["selected", "queued"] as const) test(`catalog reconciliation expires derived coverage but preserves a ${holder} request`, () => fixture(plan => {
  db.prepare("INSERT INTO LibraryAlbums(library_id,release_group_id,selection_mode,locked,curation_version) VALUES(?,1,'manual',1,1)").run(library);
  db.prepare("INSERT INTO LibraryEditions(library_id,edition_id,selection_mode,curation_version,preferred_plan_key,plan_selection_mode) VALUES(?,1,'manual',1,'candidate','manual')").run(library);
  if (holder === "queued") db.prepare("INSERT INTO DownloadQueue(ref_key,media_kind,command_name,plan_id,payload,queue_order) VALUES('waiting','album','DownloadAlbum',?,'{}',7)").run(plan);
  db.prepare("UPDATE ProviderTrackMatches SET track_id=1 WHERE id=1").run();
  reconcile();
  assert.deepEqual(db.prepare("SELECT state,coverage FROM AcquisitionPlans WHERE id=?").get(plan), { state: 'stale', coverage: 0 });
  assert.equal(db.prepare("SELECT id FROM Tracks WHERE id=1").get(), undefined);
  assert.deepEqual(db.prepare("SELECT recording_id,track_id,match_state FROM ProviderTrackMatches WHERE id=1").get(), { recording_id: 1, track_id: null, match_state: 'accepted' });
  assert.deepEqual(db.prepare("SELECT preferred_plan_key,plan_selection_mode FROM LibraryEditions WHERE library_id=?").get(library), { preferred_plan_key: 'candidate', plan_selection_mode: 'manual' });
  assert.ok(db.prepare("SELECT id FROM AcquisitionPlanSources WHERE plan_id=?").get(plan));
  assert.equal((db.prepare("SELECT locked FROM LibraryAlbums WHERE library_id=?").get(library) as { locked: number }).locked, 1);
  if (holder === "queued") {
    const row = db.prepare("SELECT payload,queue_order,command_id FROM DownloadQueue WHERE plan_id=?").get(plan) as { payload: string; queue_order: number; command_id: number | null };
    assert.deepEqual(JSON.parse(row.payload), { libraryId: library, releaseMbid: 'release', provider: 'tidal' });
    assert.equal(row.queue_order, 7); assert.equal(row.command_id, null);
  }
}));

for (const holder of ["started download", "queued import"] as const) test(`catalog reconciliation preserves removed tracks held by a ${holder} plan`, () => fixture(plan => {
  db.prepare("INSERT INTO commands(name,payload,status) VALUES(?,?,?)").run(holder === "queued import" ? "ImportDownload" : "DownloadAlbum", JSON.stringify({ acquisitionPlanId: plan }), holder === "queued import" ? "queued" : "started");
  assert.throws(() => db.transaction(reconcile)(), /executing acquisition plan/);
  assert.ok(db.prepare("SELECT id FROM AcquisitionPlans WHERE id=?").get(plan));
  assert.equal((db.prepare("SELECT position FROM Tracks WHERE id=1").get() as { position: number }).position, 1);
  assert.equal((db.prepare("SELECT position FROM Tracks WHERE id=2").get() as { position: number }).position, 2);
  assert.deepEqual(db.pragma("foreign_key_check"), []);
}));

test("removed provider occurrence context cannot rewrite an active standalone media snapshot", () => fixture(() => {
  db.prepare("UPDATE ProviderTrackMatches SET track_id=1 WHERE id=1").run();
  db.prepare("INSERT INTO commands(name,payload,status) VALUES('DownloadTrack',?,'started')").run(JSON.stringify({ canonicalTrackMbid: 'track-1' }));
  assert.throws(() => db.transaction(reconcile)(), /executing media snapshot/);
  assert.equal((db.prepare("SELECT track_id FROM ProviderTrackMatches WHERE id=1").get() as { track_id: number }).track_id, 1);
}));

test("waiting standalone track intent blocks occurrence expiry until it can be reconciled", () => fixture(() => {
  db.prepare("INSERT INTO DownloadQueue(ref_key,media_kind,command_name,payload,queue_order) VALUES('standalone','track','DownloadTrack',?,1)").run(JSON.stringify({ canonicalTrackMbid: 'track-1' }));
  assert.throws(() => db.transaction(reconcile)(), /waiting standalone media request/);
  assert.ok(db.prepare("SELECT id FROM Tracks WHERE id=1").get());
}));

test("a claimed waiting plan cannot be expired even after its command leaves live history", () => fixture(plan => {
  db.prepare("INSERT INTO DownloadQueue(ref_key,media_kind,command_name,plan_id,command_id,payload,queue_order) VALUES('claimed','album','DownloadAlbum',?,987,'{}',1)").run(plan);
  assert.throws(() => db.transaction(reconcile)(), /claimed acquisition plan/);
  assert.ok(db.prepare("SELECT id FROM AcquisitionPlanTracks WHERE plan_id=?").get(plan));
}));

test("contradictory waiting intent rolls back plan expiration", () => fixture(plan => {
  db.prepare("INSERT INTO DownloadQueue(ref_key,media_kind,command_name,plan_id,payload,queue_order) VALUES('waiting','album','DownloadAlbum',?,?,1)").run(plan, JSON.stringify({ releaseMbid: 'other-release' }));
  assert.throws(() => db.transaction(reconcile)(), /Conflicting acquisition intent/);
  assert.equal((db.prepare("SELECT state FROM AcquisitionPlans WHERE id=?").get(plan) as { state: string }).state, 'current');
  assert.ok(db.prepare("SELECT id FROM Tracks WHERE id=1").get());
}));

test("owned obsolete audio blocks expiry before any plan or provider context changes", () => fixture(plan => {
  db.prepare("UPDATE ProviderTrackMatches SET track_id=1 WHERE id=1").run();
  db.prepare(`INSERT INTO TrackFiles(library_id,artist_metadata_id,file_path,relative_path,filename,extension,file_type,library_root,track_id,album_edition_id,recording_id)
    VALUES(?,1,'/music/owned.flac','owned.flac','owned.flac','flac','track','music',1,1,1)`).run(library);
  assert.throws(() => db.transaction(reconcile)(), /still referenced by TrackFiles/);
  assert.equal((db.prepare("SELECT state FROM AcquisitionPlans WHERE id=?").get(plan) as { state: string }).state, 'current');
  assert.equal((db.prepare("SELECT track_id FROM ProviderTrackMatches WHERE id=1").get() as { track_id: number }).track_id, 1);
}));

test("failed later catalogue writes restore selected assignments and original waiting payload", () => fixture(plan => {
  db.prepare("INSERT INTO DownloadQueue(ref_key,media_kind,command_name,plan_id,payload,queue_order) VALUES('waiting','album','DownloadAlbum',?,'{}',1)").run(plan);
  db.prepare("UPDATE ProviderTrackMatches SET track_id=1 WHERE id=1").run();
  assert.throws(() => db.transaction(() => { reconcile(); throw new Error('later write'); })(), /later write/);
  assert.equal((db.prepare("SELECT payload FROM DownloadQueue WHERE plan_id=?").get(plan) as { payload: string }).payload, '{}');
  assert.ok(db.prepare("SELECT id FROM AcquisitionPlanTracks WHERE plan_id=? AND track_id=1").get(plan));
  assert.equal((db.prepare("SELECT track_id FROM ProviderTrackMatches WHERE id=1").get() as { track_id: number }).track_id, 1);
}));

test("failed catalog writes roll back candidate invalidation with the track reconciliation", () => fixture(plan => {
  assert.throws(() => db.transaction(() => { reconcile(); throw new Error("later edition write failed"); })(), /later edition write failed/);
  assert.ok(db.prepare("SELECT id FROM AcquisitionPlans WHERE id=?").get(plan));
  assert.ok(db.prepare("SELECT id FROM Tracks WHERE id=1").get());
  assert.deepEqual(db.pragma("foreign_key_check"), []);
}));

test("catalog plan invalidation requires an admitted transaction", () => {
  assert.throws(() => new AcquisitionPlanRepository(db).discardUnusedPlansForTrack(1), /requires an active transaction/);
});

test("plan holder lookups use indexes on the active schema", () => {
  for (const [sql, expected] of [
    ["SELECT 1 FROM DownloadQueue WHERE plan_id=1 LIMIT 1", "idx_download_queue_plan"],
    ["SELECT 1 FROM commands WHERE status IN ('queued','started') AND CAST(json_extract(payload,'$.acquisitionPlanId') AS INTEGER)=1 LIMIT 1", "idx_commands_live_acquisition_plan"],
  ]) {
    const detail = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map(row => row.detail).join(" ");
    assert.match(detail, new RegExp(expected));
    assert.doesNotMatch(detail, /SCAN (commands|DownloadQueue)/);
  }
});
