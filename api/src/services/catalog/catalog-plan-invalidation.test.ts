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
        VALUES(1,2,2,'accepted','automatic',1,'test',1);
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

for (const holder of ["selected", "queued", "started download", "queued import"] as const) test(`catalog reconciliation preserves removed tracks held by a ${holder} plan`, () => fixture(plan => {
  if (holder === "selected") db.prepare("INSERT INTO LibraryEditions(library_id,edition_id,selection_mode,curation_version,preferred_plan_key,plan_selection_mode) VALUES(?,1,'auto',1,'candidate','manual')").run(library);
  else if (holder === "queued") db.prepare("INSERT INTO DownloadQueue(ref_key,media_kind,command_name,plan_id,payload,queue_order) VALUES('waiting','album','DownloadAlbum',?,'{}',1)").run(plan);
  else db.prepare("INSERT INTO commands(name,payload,status) VALUES(?,?,?)").run(holder === "queued import" ? "ImportDownload" : "DownloadAlbum", JSON.stringify({ acquisitionPlanId: plan }), holder === "queued import" ? "queued" : "started");
  assert.throws(() => db.transaction(reconcile)(), /still referenced by AcquisitionPlanTracks/);
  assert.ok(db.prepare("SELECT id FROM AcquisitionPlans WHERE id=?").get(plan));
  assert.equal((db.prepare("SELECT position FROM Tracks WHERE id=1").get() as { position: number }).position, 1);
  assert.equal((db.prepare("SELECT position FROM Tracks WHERE id=2").get() as { position: number }).position, 2);
  assert.deepEqual(db.pragma("foreign_key_check"), []);
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
