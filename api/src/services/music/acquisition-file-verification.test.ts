import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { prepareActiveSchemaEnv, openActiveSchemaDb, closeActiveSchemaDb } from '../../test-support/active-schema-fixture.js';
import { seedTestLibrary } from '../../test-support/library-fixtures.js';
const { tempDir } = prepareActiveSchemaEnv('acquisition-file-verification');
const { db, dbModule } = await openActiveSchemaDb();
const { withVerifiedAcquisitionFiles, importedQualitySatisfies } = await import('./acquisition-file-verification.js');
const { QualityProfileRepository } = await import('./quality-profile-policy.js');
const { DownloadWaitQueue } = await import('../download/download-wait-queue.js');
const { acquireMediaFileLocks } = await import('../mediafiles/media-file-lock.js');
const { DownloadProcessor } = await import('../download/download-processor.js');
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
function wav(seconds = 1, bitDepth = 16): Buffer {
    const bytes = Math.round(44100 * seconds) * 2 * (bitDepth / 8);
    const value = Buffer.alloc(44 + bytes);
    value.write('RIFF', 0);
    value.writeUInt32LE(36 + bytes, 4);
    value.write('WAVEfmt ', 8);
    value.writeUInt32LE(16, 16);
    value.writeUInt16LE(1, 20);
    value.writeUInt16LE(2, 22);
    value.writeUInt32LE(44100, 24);
    value.writeUInt32LE(44100 * 2 * (bitDepth / 8), 28);
    value.writeUInt16LE(2 * (bitDepth / 8), 32);
    value.writeUInt16LE(bitDepth, 34);
    value.write('data', 36);
    value.writeUInt32LE(bytes, 40);
    return value;
}
beforeEach(async () => {
    db.exec('DELETE FROM DownloadQueue; DELETE FROM commands; DELETE FROM TrackFiles;');
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
