import assert from "node:assert/strict";
import { after, test } from "node:test";
import { prepareActiveSchemaEnv, openActiveSchemaDb, closeActiveSchemaDb } from "../../test-support/active-schema-fixture.js";
import { seedTestLibrary } from "../../test-support/library-fixtures.js";
import { AcquisitionPlanRepository } from "./acquisition-plan-repository.js";
import { ProviderMatchRepository } from "./provider-match-repository.js";

import { assertAcquisitionPlansQuiescent } from "./acquisition-plan-ownership.js";

const { tempDir } = prepareActiveSchemaEnv("plan-ownership");
const { ProviderReleaseIngestionService } = await import("../providers/provider-release-ingestion-service.js");
const { AcquisitionPlanningService } = await import("./acquisition-planning-service.js");
const { resolveWaitingAcquisitionPlan } = await import("../download/waiting-acquisition-plan.js");
const { db, dbModule } = await openActiveSchemaDb();
const library = seedTestLibrary(db, { name: "Ownership", rootPath: tempDir });
after(() => closeActiveSchemaDb(dbModule, tempDir));
const decision = { matchState: "accepted", decisionSource: "automatic", confidence: 1, method: "proof", matcherVersion: 1 } as const;
const track = { providerEditionMemberId: 1, trackId: 1, recordingId: 1, ...decision };

function fixture(run: () => void): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      INSERT INTO ArtistMetadata(id,mbid,name) VALUES(1,'artist','Bastille');
      INSERT INTO Albums(id,mbid,artist_mbid,title) VALUES(1,'group','artist','Group');
      INSERT INTO AlbumEditions(id,mbid,release_group_mbid,artist_mbid,title) VALUES(1,'release','group','artist','Edition');
      INSERT INTO Recordings(id,mbid,title) VALUES(1,'recording','Song');
      INSERT INTO Tracks(id,mbid,release_mbid,recording_mbid,medium_position,position,title) VALUES(1,'track','release','recording',1,1,'Song');
      INSERT INTO ProviderItems(id,provider,entity_type,provider_id,title) VALUES(1,'tidal','release','source-release','Original'),(2,'tidal','track','source-track','Song');
      INSERT INTO ProviderEditionMembers(id,provider_edition_item_id,member_item_id,medium_position,position) VALUES(1,1,2,1,1);
      INSERT INTO ProviderEditionMatches(id,provider_edition_item_id,edition_id,relation,match_state,decision_source,confidence,method,matcher_version) VALUES(1,1,1,'exact','accepted','automatic',1,'proof',1);
      INSERT INTO ProviderTrackMatches(id,provider_track_item_id,provider_edition_member_id,provider_edition_match_id,track_id,recording_id,match_state,decision_source,confidence,method,matcher_version) VALUES(1,2,1,1,1,1,'accepted','automatic',1,'proof',1);
      INSERT INTO ProviderItemAudioVariants(id,provider_item_id,variant_key,quality_class) VALUES(1,2,'lossless','lossless');
    `);
    db.prepare(`INSERT INTO AcquisitionPlans(id,library_id,edition_id,provider,composition,download_mode,state,plan_key,coverage,target_track_count,planner_version,policy_hash,computed_at)
      VALUES(1,?,1,'tidal','single_source','album','current','original',1,1,1,'proof',CURRENT_TIMESTAMP)`).run(library);
    db.exec(`INSERT INTO AcquisitionPlanSources(id,plan_id,provider_edition_match_id,role,sort_order) VALUES(1,1,1,'primary',0);
      INSERT INTO AcquisitionPlanTracks(plan_id,track_id,source_id,provider_track_match_id,provider_audio_variant_id) VALUES(1,1,1,1,1);`);
    db.prepare("INSERT INTO LibraryEditions(library_id,edition_id,selection_mode,curation_version,preferred_plan_key) VALUES(?,1,'auto',1,'original')").run(library);
    run();
    assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally { db.exec("ROLLBACK"); }
}

const operations = {
  replan: () => new AcquisitionPlanRepository(db).replacePlans({ libraryId: library, editionId: 1, targetTrackCount: 1,
    plannerVersion: 2, policyHash: "changed", plans: [{ provider: "tidal", composition: "single_source", downloadMode: "album",
      sourceIds: [1], preferredSourceId: 1, coverage: 1, qualityTier: "lossless", explicitContent: "unknown",
      explicitnessCounts: { explicitTrackCount: 0, cleanTrackCount: 0, unknownExplicitnessCount: 1 }, planKey: "changed",
      tracks: [{ trackId: 1, providerEditionMatchId: 1, providerTrackMatchId: 1, providerEditionMemberId: 1, providerAudioVariantId: 1, sourceQuality: "lossless" }] }] }),
  clear: () => new AcquisitionPlanRepository(db).clear(library, 1),
  rematch: () => new ProviderMatchRepository(db).replaceReleaseMatch({ providerEditionItemId: 1, editionId: 1,
    decision: { ...decision, confidence: 0.8 }, targetTrackIds: new Set([1]), sourceMemberIds: new Set([1]), trackMatches: [track] }),
  reingest: () => new ProviderReleaseIngestionService(db).ingest({ canonicalReleaseId: 1, matcherVersion: 2,
    release: { provider: "tidal", entityType: "release", providerId: "source-release", title: "Changed" },
    members: [{ item: { provider: "tidal", entityType: "track", providerId: "source-track", title: "Song" }, mediumPosition: 1, position: 1 }] }),
};

function snapshot(): unknown {
  return ["AcquisitionPlans", "AcquisitionPlanSources", "AcquisitionPlanTracks", "LibraryEditions", "ProviderItems",
    "ProviderEditionMatches", "ProviderTrackMatches", "ProviderEditionMembers", "ProviderItemAudioVariants"]
    .map(table => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all());
}

for (const [name, mutate] of Object.entries(operations)) {
  for (const holder of ["download", "import", "claimed"] as const) test(`${name} preserves the exact plan and source rows owned by a ${holder}`, () => fixture(() => {
    if (holder === "claimed") db.prepare("INSERT INTO DownloadQueue(ref_key,media_kind,command_name,plan_id,command_id,queue_order) VALUES('claim','album','DownloadAlbum',1,987,1)").run();
    else db.prepare("INSERT INTO commands(name,payload,status) VALUES(?,?,'started')").run(holder === "import" ? "ImportDownload" : "DownloadAlbum", JSON.stringify({ acquisitionPlanId: 1 }));
    const before = snapshot();
    assert.throws(mutate, /owned by a download or import/);
    assert.deepEqual(snapshot(), before);
  }));
  test(`${name} can replace quiescent derived plans`, () => fixture(() => { assert.doesNotThrow(mutate); }));
}

test("acquisition plan ownership admission requires the writer transaction", () => {
  assert.throws(() => assertAcquisitionPlansQuiescent(db, [1]), /active transaction/);
});

for (const locked of [0, 1]) test(`provider refresh preserves the exact manual offer and waiting intent with album lock ${locked}`, () => fixture(() => {
  const planner = new AcquisitionPlanningService(db);
  const compute = () => planner.compute({ libraryId: library, editionId: 1, providerPriority: ['tidal'], plannerVersion: 1 });
  compute();
  const before = db.prepare("SELECT preferred_plan_key FROM LibraryEditions WHERE library_id=? AND edition_id=1").get(library) as {preferred_plan_key:string};
  assert.ok(before.preferred_plan_key);
  db.prepare("UPDATE LibraryEditions SET plan_selection_mode='manual' WHERE library_id=?").run(library);
  db.prepare("INSERT INTO LibraryAlbums(library_id,release_group_id,selection_mode,locked,curation_version) VALUES(?,1,'manual',?,1)").run(library,locked);
  const original = db.prepare("SELECT id FROM AcquisitionPlans WHERE plan_key=?").get(before.preferred_plan_key) as {id:number};
  // Existing live plans have keys derived from replaceable match row IDs.
  db.prepare("UPDATE AcquisitionPlans SET plan_key='old-row-binding-key' WHERE id=?").run(original.id);
  db.prepare("UPDATE LibraryEditions SET preferred_plan_key='old-row-binding-key' WHERE library_id=?").run(library);
  db.prepare("INSERT INTO DownloadQueue(ref_key,media_kind,command_name,plan_id,provider,payload,queue_order) VALUES('intent','album','DownloadAlbum',?,'tidal','{}',1)").run(original.id);
  for (let repeat=0; repeat<2; repeat++) {
    const result = new ProviderReleaseIngestionService(db).ingest({canonicalReleaseId:1,matcherVersion:repeat+2,
      release:{provider:'tidal',entityType:'release',providerId:'source-release',title:'Refreshed source'},
      members:[{item:{provider:'tidal',entityType:'track',providerId:'source-track',title:'Song'},mediumPosition:1,position:1}]});
    assert.equal(result.acceptedTrackCount,1);
    const selected = db.prepare("SELECT preferred_plan_key,plan_selection_mode FROM LibraryEditions WHERE library_id=?").get(library);
    assert.deepEqual(selected,{preferred_plan_key:before.preferred_plan_key,plan_selection_mode:'manual'});
    assert.equal((db.prepare("SELECT id FROM ProviderTrackMatches WHERE match_state='accepted'").get() as {id:number}).id,1);
    const waiting = db.prepare("SELECT plan_id,payload FROM DownloadQueue WHERE ref_key='intent'").get() as {plan_id:number|null;payload:string};
    const payload = JSON.parse(waiting.payload);
    assert.deepEqual(payload,{libraryId:library,releaseMbid:'release',provider:'tidal'});
    assert.ok(resolveWaitingAcquisitionPlan(db,waiting.plan_id ?? -1,payload,'tidal'));
    assert.equal((db.prepare("SELECT locked FROM LibraryAlbums WHERE library_id=?").get(library) as {locked:number}).locked,locked);
  }
}));

test("an unavailable manual offer retains its identity and refuses a waiting download", () => fixture(() => {
  new AcquisitionPlanningService(db).compute({libraryId:library,editionId:1,providerPriority:['tidal'],plannerVersion:1});
  db.prepare("UPDATE LibraryEditions SET plan_selection_mode='manual' WHERE library_id=?").run(library);
  const before = db.prepare("SELECT preferred_plan_key FROM LibraryEditions WHERE library_id=?").get(library) as {preferred_plan_key:string};
  new ProviderReleaseIngestionService(db).ingest({canonicalReleaseId:1,matcherVersion:2,
    release:{provider:'tidal',entityType:'release',providerId:'source-release',title:'Removed source'},members:[]});
  const selected = db.prepare(`SELECT plan.state,plan.plan_key FROM AcquisitionPlans plan JOIN LibraryEditions selected
    ON selected.library_id=plan.library_id AND selected.edition_id=plan.edition_id AND selected.preferred_plan_key=plan.plan_key
    WHERE plan.library_id=?`).get(library);
  assert.deepEqual(selected,{state:'unavailable',plan_key:before.preferred_plan_key});
  assert.equal(resolveWaitingAcquisitionPlan(db,-1,{libraryId:library,releaseMbid:'release',provider:'tidal'},'tidal'),null);
  new ProviderReleaseIngestionService(db).ingest({canonicalReleaseId:1,matcherVersion:3,
    release:{provider:'tidal',entityType:'release',providerId:'source-release',title:'Returned source'},
    members:[{item:{provider:'tidal',entityType:'track',providerId:'source-track',title:'Song'},mediumPosition:1,position:1}]});
  const recovered = db.prepare(`SELECT plan.state,plan.plan_key FROM AcquisitionPlans plan JOIN LibraryEditions selected
    ON selected.library_id=plan.library_id AND selected.edition_id=plan.edition_id AND selected.preferred_plan_key=plan.plan_key
    WHERE plan.library_id=?`).get(library);
  assert.deepEqual(recovered,{state:'current',plan_key:before.preferred_plan_key});
  assert.ok((db.prepare("SELECT id FROM ProviderTrackMatches WHERE match_state='accepted'").get() as {id:number}).id > 1,
    'recovered resource identity must survive regenerated match/member rows');
}));
