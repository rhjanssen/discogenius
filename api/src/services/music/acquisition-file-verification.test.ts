import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import { after, beforeEach, test } from 'node:test';
import { prepareActiveSchemaEnv, openActiveSchemaDb, closeActiveSchemaDb } from '../../test-support/active-schema-fixture.js';
import { seedTestLibrary } from '../../test-support/library-fixtures.js';
const { tempDir } = prepareActiveSchemaEnv('acquisition-file-verification');
const { db, dbModule } = await openActiveSchemaDb();
const { withVerifiedAcquisitionFiles, importedQualitySatisfies, importedFidelitySatisfies } = await import('./acquisition-file-verification.js');
const { observedFactsFromFile } = await import('../providers/audio-facts.js');
const { QualityProfileRepository } = await import('./quality-profile-policy.js');
const { DownloadWaitQueue } = await import('../download/download-wait-queue.js');
const { acquireMediaFileLocks } = await import('../mediafiles/media-file-lock.js');
const { DownloadProcessor } = await import('../download/download-processor.js');
const {persistDownloadedProviderProvenance} = await import('../mediafiles/downloaded-tracks-import-service.js');
const {Config} = await import('../config/config.js');
const root = path.join(tempDir, 'music');
await fs.mkdir(root);
const filePath = path.join(root, 'Pompeii.wav');
const library = seedTestLibrary(db, { name: 'Verified Bastille', rootPath: root });
db.exec(`
  INSERT INTO ArtistMetadata(id,mbid,name) VALUES(1,'artist','Bastille');
  INSERT INTO Albums(id,mbid,artist_mbid,title) VALUES(1,'group','artist','Bad Blood');
  INSERT INTO AlbumEditions(id,mbid,release_group_mbid,artist_mbid,title) VALUES(1,'release','group','artist','Bad Blood');
  INSERT INTO Recordings(id,mbid,title,length_ms) VALUES(1,'recording','Pompeii',1000);
  INSERT INTO Tracks(id,mbid,release_mbid,recording_mbid,medium_position,position,title,length_ms) VALUES(1,'track','release','recording',1,1,'Pompeii',1000);
  INSERT INTO ProviderItems(id,provider,entity_type,provider_id,title) VALUES(1,'tidal','release','source-release','Bad Blood'),(2,'tidal','track','source-track','Pompeii');
  INSERT INTO ProviderEditionMembers(id,provider_edition_item_id,member_item_id,medium_position,position) VALUES(1,1,2,1,1);
  INSERT INTO ProviderEditionMatches(id,provider_edition_item_id,edition_id,relation,match_state,decision_source,confidence,method,matcher_version) VALUES(1,1,1,'exact','accepted','automatic',1,'proof',1);
  INSERT INTO ProviderTrackMatches(id,provider_track_item_id,provider_edition_member_id,provider_edition_match_id,track_id,recording_id,match_state,decision_source,confidence,method,matcher_version) VALUES(1,2,1,1,1,1,'accepted','automatic',1,'proof',1);
  INSERT INTO ProviderItemAudioVariants(id,provider_item_id,variant_key,quality_class,bit_depth,sample_rate,codec) VALUES(1,2,'lossless','lossless',16,44100,'flac');
`);
db.prepare(`INSERT INTO AcquisitionPlans(id,library_id,edition_id,provider,composition,download_mode,state,plan_key,coverage,target_track_count,planner_version,policy_hash,computed_at)
 VALUES(1,?,1,'tidal','single_source','album','current','verified',1,1,1,'proof',CURRENT_TIMESTAMP)`).run(library);
db.exec(`INSERT INTO AcquisitionPlanSources(id,plan_id,provider_edition_match_id,role,sort_order) VALUES(1,1,1,'primary',0);
 INSERT INTO AcquisitionPlanTracks(plan_id,track_id,source_id,provider_track_match_id,provider_audio_variant_id,source_quality_snapshot) VALUES(1,1,1,1,1,'{"quality":"lossless"}');`);
db.prepare("INSERT INTO LibraryEditions(library_id,edition_id,selection_mode,curation_version,preferred_plan_key) VALUES(?,1,'auto',1,'verified')").run(library);
const profileId = (db.prepare('SELECT quality_profile_id AS id FROM Libraries WHERE id=?').get(library) as {
    id: number;
}).id;
function wav(seconds = 1, bitDepth = 16, sampleRate = 44100): Buffer {
    const bytes = Math.round(sampleRate * seconds) * 2 * (bitDepth / 8);
    const value = Buffer.alloc(44 + bytes);
    value.write('RIFF', 0);
    value.writeUInt32LE(36 + bytes, 4);
    value.write('WAVEfmt ', 8);
    value.writeUInt32LE(16, 16);
    value.writeUInt16LE(1, 20);
    value.writeUInt16LE(2, 22);
    value.writeUInt32LE(sampleRate, 24);
    value.writeUInt32LE(sampleRate * 2 * (bitDepth / 8), 28);
    value.writeUInt16LE(2 * (bitDepth / 8), 32);
    value.writeUInt16LE(bitDepth, 34);
    value.write('data', 36);
    value.writeUInt32LE(bytes, 40);
    return value;
}
beforeEach(async () => {
    db.exec('DELETE FROM DownloadQueue; DELETE FROM commands; DELETE FROM TrackFiles; UPDATE AcquisitionPlanTracks SET provider_audio_variant_id=1; DELETE FROM ProviderItemAudioVariants WHERE id>1; UPDATE ProviderEditionMembers SET provider_edition_item_id=1 WHERE id=1; DELETE FROM ProviderItems WHERE id>2;');
    db.prepare(`UPDATE quality_profiles SET allowed_source_formats='["hires-lossless","lossless","lossy"]',preference_order='["hires-lossless","lossless","lossy"]',cutoff='lossless',continue_upgrades=0,output_format='{"codec":"preserve","lossless":true}',transcode_policy='preserve' WHERE id=?`).run(profileId);
    db.exec("UPDATE AcquisitionPlans SET state='current',coverage=1,target_track_count=1; UPDATE Tracks SET length_ms=1000; UPDATE AcquisitionPlanTracks SET source_quality_snapshot='{\"quality\":\"lossless\"}'; UPDATE ProviderItemAudioVariants SET bit_depth=16,sample_rate=44100;");
    db.prepare(`INSERT INTO TrackFiles(library_id,album_edition_id,track_id,recording_id,file_path,relative_path,filename,extension,file_class,library_root,file_type,quality)
   VALUES(?,1,1,1,?,'Pompeii.wav','Pompeii.wav','wav','audio',?,'track','HIRES_LOSSLESS')`).run(library, filePath, root);
    await fs.writeFile(filePath, wav());
});
after(() => closeActiveSchemaDb(dbModule, tempDir));
async function proof(): Promise<number[]> {
    return withVerifiedAcquisitionFiles(db, 1, [], async (verified, current) => {
        assert.equal(db.inTransaction, false, 'filesystem verification must release the database transaction');
        assert.equal(current(), true);
        return [...verified];
    });
}
test('real audio is verified from its own metrics rather than the stored quality label', async () => {
    assert.deepEqual(await proof(), [1]);
    db.prepare("UPDATE quality_profiles SET cutoff='hires-lossless',continue_upgrades=1 WHERE id=?").run(profileId);
    db.exec("UPDATE AcquisitionPlanTracks SET source_quality_snapshot='{\"quality\":\"hires-lossless\"}'; UPDATE ProviderItemAudioVariants SET bit_depth=24;");
    assert.deepEqual(await proof(), [], '16-bit file must not suppress an available 24-bit upgrade');
    await fs.writeFile(filePath, wav(1, 24));
    assert.deepEqual(await proof(), [1]);
});
test('missing imported files do not satisfy acquisition', async () => { await fs.unlink(filePath); assert.deepEqual(await proof(), []); });
test('corrupt imported files do not satisfy acquisition', async () => { await fs.writeFile(filePath, 'not audio'); assert.deepEqual(await proof(), []); });
test('a large duration mismatch does not satisfy the canonical track', async () => { db.exec('UPDATE Tracks SET length_ms=60000'); assert.deepEqual(await proof(), []); });
test('a tracked path outside the configured library cannot satisfy acquisition', async () => {
    const outside = path.join(tempDir, 'outside.wav');
    await fs.writeFile(outside, wav());
    db.prepare('UPDATE TrackFiles SET file_path=?').run(outside);
    assert.deepEqual(await proof(), []);
});
test('file verification observes changed catalogue or policy before committing', async () => {
    await withVerifiedAcquisitionFiles(db, 1, [], async (verified, current) => {
        assert.deepEqual([...verified], [1]);
        assert.equal(current(), true);
        db.exec('UPDATE Tracks SET length_ms=60000');
        assert.equal(current(), false);
    });
});
test('file writers are held until the verified admission callback ends', async () => {
    let writerAcquired = false;
    let writer: Promise<void> | undefined;
    await withVerifiedAcquisitionFiles(db, 1, [], async (verified) => {
        assert.deepEqual([...verified], [1]);
        writer = acquireMediaFileLocks([filePath]).then(release => { writerAcquired = true; release(); });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(writerAcquired, false);
    });
    await writer;
    assert.equal(writerAcquired, true);
});
test('verified complete acquisition retires its exact waiting row with completed history', async () => {
    const wait = DownloadWaitQueue.enqueue({ refKey: 'verified-request', mediaKind: 'album', commandName: 'DownloadAlbum', planId: 1, provider: 'tidal', payload: { libraryId: library, releaseMbid: 'release', provider: 'tidal' } });
    assert.equal(DownloadWaitQueue.claim(wait.id), null);
    assert.equal(DownloadWaitQueue.get(wait.id)?.payload.acquisitionWaitReason, 'imported_files_need_verification');
    await withVerifiedAcquisitionFiles(db, 1, [], async (verified, current) => {
        assert.equal(current(), true);
        assert.equal(DownloadWaitQueue.claim(wait.id, verified), null);
    });
    assert.equal(DownloadWaitQueue.get(wait.id), null);
    const history = db.prepare('SELECT status,payload FROM commands').all() as Array<{
        status: string;
        payload: string;
    }>;
    assert.equal(history.length, 1);
    assert.equal(history[0].status, 'completed');
    assert.equal(JSON.parse(history[0].payload).downloadState.statusMessage, 'Already imported; files verified');
});
test('verified partial offer cannot retire a whole-edition request', async () => {
    db.exec('UPDATE AcquisitionPlans SET target_track_count=2');
    const wait = DownloadWaitQueue.enqueue({ refKey: 'partial-request', mediaKind: 'album', commandName: 'DownloadAlbum', planId: 1, provider: 'tidal', payload: { libraryId: library, releaseMbid: 'release', provider: 'tidal' } });
    await withVerifiedAcquisitionFiles(db, 1, [], async (verified) => { assert.equal(DownloadWaitQueue.claim(wait.id, verified), null); });
    assert.equal(DownloadWaitQueue.get(wait.id)?.payload.acquisitionWaitReason, 'missing_assignments');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM commands').get() as {
        n: number;
    }).n, 0);
});
test('missing physical file is claimed for download rather than retired', async () => {
    await fs.unlink(filePath);
    const wait = DownloadWaitQueue.enqueue({ refKey: 'missing-request', mediaKind: 'album', commandName: 'DownloadAlbum', planId: 1, provider: 'tidal', payload: { libraryId: library, releaseMbid: 'release', provider: 'tidal' } });
    await withVerifiedAcquisitionFiles(db, 1, [], async (verified) => { assert.ok(DownloadWaitQueue.claim(wait.id, verified)); });
    assert.ok(DownloadWaitQueue.get(wait.id)?.command_id);
    assert.equal((db.prepare('SELECT status FROM commands').get() as {
        status: string;
    }).status, 'queued');
});
test('cutoff policy and spatial separation govern verified quality', () => {
    const profile = new QualityProfileRepository(db).get(profileId);
    assert.equal(importedQualitySatisfies(profile, 'lossless', { quality: 'hires-lossless', bitDepth: 24 }), true);
    assert.equal(importedQualitySatisfies({ ...profile, continueUpgradesAfterCutoff: true }, 'lossless', { quality: 'hires-lossless', bitDepth: 24 }), false);
    assert.equal(importedQualitySatisfies(profile, 'lossy', { quality: 'lossless' }), false);
    assert.equal(importedQualitySatisfies(profile, 'spatial', { quality: 'lossless' }), false);
    assert.equal(importedQualitySatisfies({ ...profile, allowedQualities: new Set(['spatial']) }, 'lossless', { quality: 'spatial' }), false);
});
for (const condition of ['pause', 'changed-request', 'import-backpressure'] as const) {
    test(`worker rechecks ${condition} after asynchronous file verification`, async () => {
        const wait = DownloadWaitQueue.enqueue({ refKey: 'recheck', mediaKind: 'album', commandName: 'DownloadAlbum', planId: 1, provider: 'tidal', payload: { libraryId: library, releaseMbid: 'release', provider: 'tidal' } });
        const processor = new DownloadProcessor() as any;
        processor.isPaused = false;
        processor.scheduleNext = () => { };
        const release = await acquireMediaFileLocks([filePath]);
        const verification = processor.verifyWaitingFiles(wait.id, 0, null);
        try {
            if (condition === 'pause')
                processor.isPaused = true;
            else if (condition === 'changed-request')
                db.prepare("UPDATE DownloadQueue SET payload=json_set(payload,'$.releaseMbid','another-edition') WHERE id=?").run(wait.id);
            else
                processor.importBackpressureReached = () => true;
        }
        finally {
            release();
        }
        await verification;
        assert.equal(DownloadWaitQueue.get(wait.id)?.command_id, null);
        assert.equal((db.prepare('SELECT COUNT(*) AS n FROM commands').get() as {
            n: number;
        }).n, 0);
    });
}

test('different hi-res delivery requires a real within-tier upgrade', async () => {
    db.prepare("UPDATE quality_profiles SET cutoff='hires-lossless',continue_upgrades=1 WHERE id=?").run(profileId);
    db.exec("UPDATE AcquisitionPlanTracks SET source_quality_snapshot='{\"quality\":\"hires-lossless\"}'; UPDATE ProviderItemAudioVariants SET bit_depth=24,sample_rate=96000;");
    await fs.writeFile(filePath,wav(1,24,48000));
    assert.deepEqual(await proof(),[],'24/48 is below the distinct 24/96 offer');
    await fs.writeFile(filePath,wav(1,24,96000));
    assert.deepEqual(await proof(),[1]);
});

test('same native delivery below a representative estimate does not loop downloads', async () => {
    db.prepare("UPDATE quality_profiles SET cutoff='hires-lossless',continue_upgrades=1 WHERE id=?").run(profileId);
    db.exec("UPDATE AcquisitionPlanTracks SET source_quality_snapshot='{\"quality\":\"hires-lossless\"}'; UPDATE ProviderItemAudioVariants SET bit_depth=24,sample_rate=96000;");
    const audio = wav(1,24,48000); await fs.writeFile(filePath,audio);
    db.prepare("UPDATE TrackFiles SET provider_item_id=2,source_audio_variant_id=1,provider='tidal',provider_entity_type='track',provider_id='source-track',codec='PCM',bit_depth=24,sample_rate=48000,channels=2,file_size=?").run(audio.length);
    assert.deepEqual(await proof(),[1],'the unchanged measured delivery of this exact variant is valid');
    db.exec("INSERT INTO ProviderItemAudioVariants(id,provider_item_id,variant_key,quality_class,bit_depth,sample_rate,codec) VALUES(2,2,'distinct-hires','hires-lossless',24,96000,'flac'); UPDATE AcquisitionPlanTracks SET provider_audio_variant_id=2;");
    assert.deepEqual(await proof(),[],'another native variant does not inherit the first delivery proof');
});

test('stale probe or conflicting provider identity cannot grandfather a same-variant file',async () => {
    db.prepare("UPDATE quality_profiles SET cutoff='hires-lossless',continue_upgrades=1 WHERE id=?").run(profileId);
    db.exec("UPDATE AcquisitionPlanTracks SET source_quality_snapshot='{\"quality\":\"hires-lossless\"}'; UPDATE ProviderItemAudioVariants SET bit_depth=24,sample_rate=96000;");
    const audio=wav(1,24,48000); await fs.writeFile(filePath,audio);
    db.prepare("UPDATE TrackFiles SET provider_item_id=2,source_audio_variant_id=1,provider='tidal',provider_entity_type='track',provider_id='source-track',codec='PCM',bit_depth=24,sample_rate=96000,channels=2,file_size=?").run(audio.length);
    assert.deepEqual(await proof(),[],'stored 96kHz contradicts the current 48kHz file');
    db.exec("UPDATE TrackFiles SET sample_rate=48000,provider_id='another-track'");
    assert.deepEqual(await proof(),[],'provider identity is a full triple, not a shared variant id');
});

test('lossy upgrade comparison is codec aware and preserves measured same-source VBR',() => {
    const profile = {...new QualityProfileRepository(db).get(profileId),continueUpgradesAfterCutoff:true};
    const desired = {quality:'lossy',codec:'aac',bitrate:96000} as const;
    assert.equal(importedFidelitySatisfies(profile,'lossy',observedFactsFromFile({codec:'opus',bitrate:96}),desired),true);
    assert.equal(importedFidelitySatisfies(profile,'lossy',observedFactsFromFile({codec:'mp3',bitrate:96}),desired),false);
    const high = {quality:'lossy',codec:'aac',bitrate:320000} as const;
    const vbr = observedFactsFromFile({codec:'MPEG-4/AAC',bitrate:147});
    assert.equal(vbr.codec,'aac','music-metadata codec names must use the shared codec vocabulary');
    assert.equal(importedFidelitySatisfies(profile,'lossy',vbr,high),false);
    assert.equal(importedFidelitySatisfies(profile,'lossy',vbr,high,true),true,
        'actual average bitrate is not the declared encoder target');
    const cutoff = {...profile,continueUpgradesAfterCutoff:false,cutoff:'lossy' as const};
    assert.equal(importedFidelitySatisfies(cutoff,'lossy',vbr,high),true,'stopping at the lossy cutoff is respected');
});

test('verification uses the same explicit 24-bit conformity policy as import',()=>{
    const profile = {...new QualityProfileRepository(db).get(profileId),continueUpgradesAfterCutoff:true};
    const source = {quality:'hires-lossless',codec:'alac',bitDepth:24,sampleRate:96000} as const;
    const cd = observedFactsFromFile({codec:'FLAC',bit_depth:16,sample_rate:44100,channel_count:2});
    assert.equal(importedFidelitySatisfies(profile,'lossless',cd,source),false);
    assert.equal(importedFidelitySatisfies(profile,'lossless',cd,source,false,{conformToTarget:true}),true,
        'a permitted 16/44.1 output must not trigger perpetual 24-bit redownloads');
});

test('conformity setting is applied to real files and included in the admission snapshot',async context=>{
    db.prepare("UPDATE quality_profiles SET cutoff='hires-lossless',continue_upgrades=1 WHERE id=?").run(profileId);
    db.exec("UPDATE AcquisitionPlanTracks SET source_quality_snapshot='{\"quality\":\"hires-lossless\"}'; UPDATE ProviderItemAudioVariants SET bit_depth=24,sample_rate=96000;");
    const original = Config.getQualityConfig.bind(Config);
    let conform = true;
    context.mock.method(Config,'getQualityConfig',()=>({...original(),downconvert_existing_files:conform}));
    await withVerifiedAcquisitionFiles(db,1,[],async(verified,current)=>{
        assert.deepEqual([...verified],[1],'the actual 16-bit WAV is the configured converted output');
        assert.equal(current(),true);
        conform = false;
        assert.equal(current(),false,'a changed output policy must reject the old proof');
    });
    assert.deepEqual(await proof(),[]);
});

test('release-level variant facts are valid only in the exact source occurrence',async () => {
    db.exec("INSERT INTO ProviderItemAudioVariants(id,provider_item_id,variant_key,quality_class,bit_depth,sample_rate,codec) VALUES(2,1,'release-lossless','lossless',16,44100,'flac'); UPDATE AcquisitionPlanTracks SET provider_audio_variant_id=2;");
    assert.deepEqual(await proof(),[1],'the source release may supply its member track capability');
    db.exec("INSERT INTO ProviderItems(id,provider,entity_type,provider_id,title) VALUES(3,'tidal','release','unrelated-release','Unrelated'); UPDATE ProviderItemAudioVariants SET provider_item_id=3 WHERE id=2;");
    assert.deepEqual(await proof(),[],'a different release is not the assignment source occurrence');
});

test('import provenance accepts a release variant through its explicit member occurrence',() => {
    db.exec("INSERT INTO ProviderItemAudioVariants(id,provider_item_id,variant_key,quality_class,bit_depth,sample_rate,codec) VALUES(2,1,'release-lossless','lossless',16,44100,'flac');");
    const file = db.prepare('SELECT id FROM TrackFiles WHERE track_id=1').get() as {id:number};
    const organized = {processedTrackIds:['source-track'],importedTrackFileIds:{'source-track':file.id}} as any;
    const offer = {provider:'tidal',providerTrackId:'source-track',providerTrackItemId:2,
        providerAudioVariantId:2,providerEditionItemId:1,providerAlbumId:'source-release'};
    persistDownloadedProviderProvenance(library,organized,[offer]);
    assert.deepEqual(db.prepare('SELECT provider_item_id,source_audio_variant_id FROM TrackFiles WHERE id=?').get(file.id),
        {provider_item_id:2,source_audio_variant_id:2});
    assert.throws(()=>persistDownloadedProviderProvenance(library,organized,[{...offer,providerAlbumId:'another-release'}]),/exact source edition/);
    assert.throws(()=>persistDownloadedProviderProvenance(library,organized,[{...offer,providerEditionItemId:undefined}]),/exact source edition/);
    db.exec("INSERT INTO ProviderItems(id,provider,entity_type,provider_id,title) VALUES(3,'tidal','release','different-parent','Other'); UPDATE ProviderEditionMembers SET provider_edition_item_id=3 WHERE id=1;");
    assert.throws(()=>persistDownloadedProviderProvenance(library,organized,[offer]),/exact source edition/);
    assert.deepEqual(db.prepare('SELECT provider_item_id,source_audio_variant_id FROM TrackFiles WHERE id=?').get(file.id),
        {provider_item_id:2,source_audio_variant_id:2},'failed admission rolls back rather than clearing provenance');
});


test('spatial admission requires observed Atmos even for the same measured native variant',() => {
    const profile = {...new QualityProfileRepository(db).get(profileId),allowedQualities:new Set(['spatial'] as const)};
    const desired = {quality:'spatial'} as const;
    const surround = observedFactsFromFile({codec:'eac3',channel_count:6});
    assert.equal(importedFidelitySatisfies(profile,'spatial',surround,desired,true),false);
    const atmos = observedFactsFromFile({codec:'eac3',channel_count:6,codec_profile:'Dolby Digital Plus + Dolby Atmos'});
    assert.equal(importedFidelitySatisfies(profile,'spatial',atmos,desired),true);
    const other = observedFactsFromFile({codec:'mpegh',channel_count:6,spatial_format:'360ra'});
    assert.equal(importedFidelitySatisfies(profile,'spatial',other,desired),false);
});


test('native surround cannot retire a spatial acquisition request',async (t) => {
    if (spawnSync('ffmpeg',['-version']).status !== 0) {t.skip('ffmpeg not installed');return;}
    db.prepare("UPDATE quality_profiles SET allowed_source_formats='[\"spatial\"]',preference_order='[\"spatial\"]',cutoff='spatial' WHERE id=?").run(profileId);
    db.exec("UPDATE AcquisitionPlanTracks SET source_quality_snapshot='{\"quality\":\"spatial\"}'; UPDATE ProviderItemAudioVariants SET quality_class='spatial',codec='eac3';");
    const encoded = spawnSync('ffmpeg',['-v','error','-y','-f','lavfi','-i','anullsrc=r=48000:cl=5.1','-t','1','-c:a','eac3','-b:a','640k','-f','mp4',filePath]);
    assert.equal(encoded.status,0,encoded.stderr.toString());
    assert.deepEqual(await proof(),[],'a matching row and provider Atmos offer cannot replace object-audio evidence');
});
