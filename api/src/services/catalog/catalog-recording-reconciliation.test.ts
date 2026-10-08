import assert from "node:assert/strict";
import {after,test} from "node:test";
import {prepareActiveSchemaEnv,openActiveSchemaDb,closeActiveSchemaDb} from "../../test-support/active-schema-fixture.js";
import {seedTestLibrary} from "../../test-support/library-fixtures.js";
import {reconcileRecordingRedirects,RECORDING_OWNERS} from "./catalog-recording-reconciliation.js";
const {tempDir}=prepareActiveSchemaEnv('recording-reconciliation');
const {db,dbModule}=await openActiveSchemaDb();
const library=seedTestLibrary(db,{name:'Recording merge',rootPath:tempDir});
after(()=>closeActiveSchemaDb(dbModule,tempDir));
const incoming=[{Id:'track',RecordingId:'new',OldRecordingIds:['old'],TrackName:'New title',TrackNumber:'1',TrackPosition:1,MediumNumber:1,DurationMs:1000}];
function fixture(run:()=>void){db.exec('BEGIN IMMEDIATE');try{
    db.exec(`INSERT INTO ArtistMetadata(id,mbid,name) VALUES(1,'artist','Artist');
        INSERT INTO Albums(id,mbid,artist_mbid,title) VALUES(1,'group','artist','Group');
        INSERT INTO AlbumEditions(id,mbid,release_group_mbid,artist_mbid,title) VALUES(1,'release','group','artist','Edition');
        INSERT INTO Recordings(id,mbid,title) VALUES(1,'old','Old title'),(2,'new','New title'),(3,'other','Other');
        INSERT INTO Tracks(id,mbid,release_mbid,recording_mbid,medium_position,position,title) VALUES(1,'track','release','old',1,1,'Track');
        INSERT INTO ProviderItems(id,provider,entity_type,provider_id) VALUES(1,'tidal','release','album'),(2,'tidal','track','track');
        INSERT INTO ProviderEditionMembers(id,provider_edition_item_id,member_item_id,medium_position,position) VALUES(1,1,2,1,1);
        INSERT INTO ProviderEditionMatches(id,provider_edition_item_id,edition_id,relation,match_state,decision_source,confidence,method,matcher_version) VALUES(1,1,1,'exact','accepted','manual',1,'test',1);
        INSERT INTO ProviderTrackMatches(id,provider_track_item_id,provider_edition_member_id,provider_edition_match_id,track_id,recording_id,match_state,decision_source,confidence,method,matcher_version) VALUES(1,2,1,1,1,1,'accepted','manual',1,'test',1);
        INSERT INTO ProviderItemAudioVariants(id,provider_item_id,variant_key,quality_class) VALUES(1,2,'lossless','lossless');
        INSERT INTO RecordingArtistCredits(recording_id,artist_id,ordinal,credited_name) VALUES(1,1,0,'Artist');
        INSERT INTO RecordingRelations(source_recording_id,target_recording_id,source_foreign_recording_id,target_foreign_recording_id,relation_type) VALUES(1,3,'old','other','version');
        INSERT INTO ArtistTopTracks(artist_metadata_id,track_id,recording_id,rank) VALUES(1,1,1,1);
        INSERT INTO TrackLibraryIndex(track_id,album_edition_id,recording_id) VALUES(1,1,1);`);
    db.prepare(`INSERT INTO TrackFiles(id,library_id,artist_metadata_id,track_id,recording_id,album_edition_id,canonical_track_mbid,canonical_recording_mbid,file_path,relative_path,filename,extension,library_root,file_type,quality,codec,file_size)
        VALUES(1,?,1,1,1,1,'track','old','/music/audio.flac','audio.flac','audio.flac','flac','music','track','LOSSLESS','flac',123)`).run(library);
    for(const table of ['MetadataFiles','LyricFiles','ExtraFiles']){
        db.prepare(`INSERT INTO ${table}(artist_id,track_file_id,file_path,relative_path,library_root,extension,canonical_recording_mbid${table==='ExtraFiles'?',file_type':table==='MetadataFiles'?',type,file_type':''})
            VALUES('artist',1,?,?, 'music','jpg','old'${table==='ExtraFiles'?",'cover'":table==='MetadataFiles'?",'cover','cover'":''})`).run('/music/'+table+'.jpg',table+'.jpg');
    }
    run();
}finally{db.exec('ROLLBACK');}}
function plan(){const id=Number(db.prepare(`INSERT INTO AcquisitionPlans(library_id,edition_id,provider,composition,download_mode,state,plan_key,coverage,target_track_count,planner_version,policy_hash,computed_at)
    VALUES(?,1,'tidal','single_source','album','current','chosen',1,1,1,'policy',CURRENT_TIMESTAMP)`).run(library).lastInsertRowid);
    const source=Number(db.prepare("INSERT INTO AcquisitionPlanSources(plan_id,provider_edition_match_id,role,sort_order) VALUES(?,1,'primary',0)").run(id).lastInsertRowid);
    db.prepare("INSERT INTO AcquisitionPlanTracks(plan_id,track_id,source_id,provider_track_match_id,provider_audio_variant_id,source_quality_snapshot) VALUES(?,1,?,1,1,'{\"quality\":\"lossless\"}')").run(id,source);
    db.prepare("INSERT INTO LibraryEditions(library_id,edition_id,selection_mode,preferred_plan_key,curation_version) VALUES(?,1,'manual','chosen',1)").run(library);
    return id;}
function snapshot(){return JSON.stringify(['Recordings','Tracks','TrackFiles','MetadataFiles','LyricFiles','ExtraFiles','ProviderTrackMatches','RecordingArtistCredits','RecordingRelations','ArtistTopTracks','TrackLibraryIndex','AcquisitionPlans','AcquisitionPlanTracks','LibraryEditions','DownloadQueue'].map(t=>db.prepare(`SELECT * FROM ${t}`).all()));}

test('standalone recording intent uses its partial expression index',()=>{
    const plan=db.prepare("EXPLAIN QUERY PLAN SELECT id FROM DownloadQueue WHERE plan_id IS NULL AND json_extract(payload,'$.canonicalRecordingMbid')=? LIMIT 1").all('old') as {detail:string}[];
    assert.ok(plan.some(row=>row.detail.includes('idx_download_queue_standalone_recording')));
    const byId=db.prepare("EXPLAIN QUERY PLAN SELECT id FROM DownloadQueue WHERE plan_id IS NULL AND CAST(json_extract(payload,'$.canonicalRecordingId') AS TEXT)=? LIMIT 1").all('1') as {detail:string}[];
    assert.ok(byId.some(row=>row.detail.includes('idx_download_queue_standalone_recording_id')));
});
test('integer-only standalone and active recording snapshots are retained',()=>fixture(()=>{
    db.exec("INSERT INTO DownloadQueue(ref_key,media_kind,command_name,payload,queue_order) VALUES('video','video','DownloadVideo','{\"canonicalRecordingId\":1}',1)");
    const before=snapshot();assert.throws(()=>reconcileRecordingRedirects(db,incoming),/standalone waiting/);assert.equal(snapshot(),before);
    db.exec("DELETE FROM DownloadQueue; INSERT INTO commands(name,payload,status) VALUES('ImportDownload','{\"resolved\":{\"canonicalRecordingId\":\"1\"}}','started')");
    const active=snapshot();assert.throws(()=>reconcileRecordingRedirects(db,incoming),/executing media snapshot/);assert.equal(snapshot(),active);
}));
test('recording reconciliation requires caller transaction ownership',()=>{
    assert.throws(()=>reconcileRecordingRedirects(db,incoming),/active transaction/);
});
test('active media commands retain the entire pre-merge database snapshot',()=>fixture(()=>{
    plan();
    db.exec("INSERT INTO commands(name,payload,status) VALUES('DownloadTrack','{\"canonicalRecordingMbid\":\"old\"}','started')");
    const before=snapshot();
    assert.throws(()=>reconcileRecordingRedirects(db,incoming),/executing media snapshot/);
    assert.equal(snapshot(),before);
}));
test('a later caller failure rolls back the completed recording merge',()=>fixture(()=>{
    const before=snapshot();
    assert.throws(()=>db.transaction(()=>{reconcileRecordingRedirects(db,incoming);throw new Error('later edition failure');})(),/later edition failure/);
    assert.equal(snapshot(),before);
}));
test('redirects retain canonical target facts and only fill supplemental holes',()=>fixture(()=>{
    db.exec("UPDATE Recordings SET cover_image_url='old-cover',copyright='old-rights' WHERE id=1; UPDATE Recordings SET cover_image_url='selected-cover' WHERE id=2");
    reconcileRecordingRedirects(db,incoming);
    assert.deepEqual(db.prepare('SELECT title,cover_image_url,copyright FROM Recordings WHERE id=2').get(),{title:'New title',cover_image_url:'selected-cover',copyright:'old-rights'});
}));
test('audio/video identity changes refuse all owner mutations',()=>fixture(()=>{
    db.exec('UPDATE Recordings SET is_video=1 WHERE id=2');
    const before=snapshot();assert.throws(()=>reconcileRecordingRedirects(db,incoming),/presentation identity/);assert.equal(snapshot(),before);
}));
test('identical credits consolidate without choosing between conflicting facts',()=>fixture(()=>{
    db.exec("INSERT INTO RecordingArtistCredits(recording_id,artist_id,ordinal,credited_name) VALUES(2,1,0,'Artist')");
    reconcileRecordingRedirects(db,incoming);
    assert.deepEqual(db.prepare('SELECT recording_id,artist_id,ordinal,credited_name FROM RecordingArtistCredits').all(),[{recording_id:2,artist_id:1,ordinal:0,credited_name:'Artist'}]);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
}));
test('artwork URL identities survive until their file relocation is reconciled',()=>fixture(()=>{
    db.exec("INSERT INTO ArtworkSources(cover_entity,entity_id,cover_type,source_url) VALUES('Video','1','cover','https://example.test/source.jpg')");
    const before=snapshot();assert.throws(()=>reconcileRecordingRedirects(db,incoming),/artwork requiring identity relocation/);assert.equal(snapshot(),before);
    assert.equal((db.prepare("SELECT entity_id FROM ArtworkSources WHERE cover_entity='Video'").get() as {entity_id:string}).entity_id,'1');
}));
test('video redirects preserve exact provider decision and manual placement',()=>fixture(()=>{
    db.exec("DELETE FROM ProviderTrackMatches; UPDATE Recordings SET is_video=1 WHERE id IN (1,2); INSERT INTO ProviderItems(id,provider,entity_type,provider_id) VALUES(3,'tidal','video','video'); INSERT INTO ProviderVideoMatches(id,provider_video_item_id,recording_id,match_state,decision_source,confidence,method,matcher_version) VALUES(1,3,1,'accepted','manual',1,'test',1)");
    db.prepare("INSERT INTO LibraryVideos(id,library_id,video_recording_id,preferred_offer_key,selection_mode,placement_mode,placement_library_id,inline_track_id,inline_slot,placement_selection_mode) VALUES(1,?,1,'[\"tidal\",\"video\"]','manual','inline',?,1,'video','manual')").run(library,library);
    db.exec("UPDATE Recordings SET youtube_video_id='abcdefghijk' WHERE id=1");
    reconcileRecordingRedirects(db,incoming);
    assert.deepEqual(db.prepare('SELECT id,recording_id,decision_source FROM ProviderVideoMatches').get(),{id:1,recording_id:2,decision_source:'manual'});
    assert.deepEqual(db.prepare('SELECT id,video_recording_id,preferred_offer_key,inline_track_id,placement_selection_mode FROM LibraryVideos').get(),{id:1,video_recording_id:2,preferred_offer_key:'["tidal","video"]',inline_track_id:1,placement_selection_mode:'manual'});
    assert.equal((db.prepare('SELECT youtube_video_id FROM Recordings WHERE id=2').get() as {youtube_video_id:string}).youtube_video_id,'abcdefghijk');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
}));

test('recording owners cover every active runtime recording foreign key',()=>{
    const expected=new Set(RECORDING_OWNERS.map(([table,col])=>table+'.'+col));
    const actual=new Set<string>();
    for(const {name} of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[]){
        for(const fk of db.prepare(`PRAGMA foreign_key_list("${name}")`).all() as {table:string;from:string;to:string}[]){
            if(fk.table==='Recordings' && fk.to==='id') actual.add(name+'.'+fk.from);
        }
    }
    assert.deepEqual([...actual].sort(),[...expected].sort());
});
test('authoritative merge retains media, sidecar links, decisions, credits and projections',()=>fixture(()=>{
    assert.equal(reconcileRecordingRedirects(db,incoming),1);
    assert.equal(db.prepare("SELECT id FROM Recordings WHERE mbid='old'").get(),undefined);
    assert.deepEqual(db.prepare('SELECT recording_id,recording_mbid FROM Tracks WHERE id=1').get(),{recording_id:2,recording_mbid:'new'});
    assert.deepEqual(db.prepare('SELECT id,file_path,codec,file_size,recording_id,canonical_recording_mbid FROM TrackFiles WHERE id=1').get(),{id:1,file_path:'/music/audio.flac',codec:'flac',file_size:123,recording_id:2,canonical_recording_mbid:'new'});
    for(const table of ['MetadataFiles','LyricFiles','ExtraFiles']) assert.deepEqual(db.prepare(`SELECT track_file_id,canonical_recording_mbid FROM ${table}`).get(),{track_file_id:1,canonical_recording_mbid:'new'});
    assert.deepEqual(db.prepare('SELECT track_id,recording_id,decision_source FROM ProviderTrackMatches WHERE id=1').get(),{track_id:1,recording_id:2,decision_source:'manual'});
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
    assert.equal(reconcileRecordingRedirects(db,incoming),0);
}));
test('selected waiting plans retain their source and follow the recanonicalized key',()=>fixture(()=>{
    const id=plan();db.prepare("INSERT INTO DownloadQueue(ref_key,media_kind,command_name,plan_id,payload,queue_order) VALUES('waiting','album','DownloadAlbum',?,'{}',1)").run(id);
    reconcileRecordingRedirects(db,incoming);
    const p=db.prepare('SELECT state,plan_key FROM AcquisitionPlans WHERE id=?').get(id) as {state:string;plan_key:string};
    assert.equal(p.state,'stale');assert.notEqual(p.plan_key,'chosen');
    assert.equal((db.prepare('SELECT preferred_plan_key FROM LibraryEditions').get() as any).preferred_plan_key,p.plan_key);
    assert.equal((db.prepare('SELECT provider_track_match_id FROM AcquisitionPlanTracks WHERE plan_id=?').get(id) as any).provider_track_match_id,1);
    assert.equal((db.prepare('SELECT plan_id FROM DownloadQueue').get() as any).plan_id,id);
}));
test('claimed plans leave all ownership and waiting payloads unchanged',()=>fixture(()=>{
    const id=plan();db.prepare("INSERT INTO DownloadQueue(ref_key,media_kind,command_name,plan_id,command_id,payload,queue_order) VALUES('waiting','album','DownloadAlbum',?,123,'{}',1)").run(id);
    const before=snapshot();assert.throws(()=>reconcileRecordingRedirects(db,incoming),/owned by a download/);assert.equal(snapshot(),before);
}));
test('a uniqueness collision rolls back earlier owner transfers even when caught by caller',()=>fixture(()=>{
    db.exec("INSERT INTO RecordingArtistCredits(recording_id,artist_id,ordinal,credited_name) VALUES(2,1,0,'Conflicting credit')");
    const before=snapshot();assert.throws(()=>reconcileRecordingRedirects(db,incoming),/UNIQUE/);assert.equal(snapshot(),before);
}));
test('standalone waiting intent and inconsistent file identities are preserved for reconciliation',()=>fixture(()=>{
    db.exec("INSERT INTO DownloadQueue(ref_key,media_kind,command_name,payload,queue_order) VALUES('standalone','track','DownloadTrack','{\"canonicalRecordingMbid\":\"old\"}',1)");
    let before=snapshot();assert.throws(()=>reconcileRecordingRedirects(db,incoming),/standalone waiting/);assert.equal(snapshot(),before);
    db.exec("DELETE FROM DownloadQueue; UPDATE TrackFiles SET canonical_recording_mbid='other'");
    before=snapshot();assert.throws(()=>reconcileRecordingRedirects(db,incoming),/conflicting file identity/);assert.equal(snapshot(),before);
    db.exec("UPDATE TrackFiles SET recording_id=3,canonical_recording_mbid='old'");
    before=snapshot();assert.throws(()=>reconcileRecordingRedirects(db,incoming),/conflicting file identity/);assert.equal(snapshot(),before);
}));
test('an exact soft recording owner acquires the canonical FK without altering its media facts',()=>fixture(()=>{
    db.exec('UPDATE TrackFiles SET recording_id=NULL');
    reconcileRecordingRedirects(db,incoming);
    assert.deepEqual(db.prepare('SELECT id,recording_id,canonical_recording_mbid,file_size FROM TrackFiles').get(),{id:1,recording_id:2,canonical_recording_mbid:'new',file_size:123});
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
}));
