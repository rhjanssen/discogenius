import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { prepareActiveSchemaEnv, openActiveSchemaDb, closeActiveSchemaDb } from '../../test-support/active-schema-fixture.js';
const { tempDir } = prepareActiveSchemaEnv('execution-manifest');
const { db, dbModule } = await openActiveSchemaDb();
const { applyTrackProgress } = await import('../../contracts/track-progress.js');
const { validateExecutionManifest } = await import('./execution-manifest.js');
after(() => closeActiveSchemaDb(dbModule, tempDir));

test('stereo destination is authoritative without an accepted provider edition match', () => {
    const library = db.prepare("SELECT id, root_path FROM Libraries WHERE name = 'Stereo'").get() as { id: number; root_path: string };
    assert.ok(library);
    const target = validateExecutionManifest(db, { provider: 'apple-music', libraryId: library.id, slot: 'stereo' });
    assert.equal(target?.rootPath, library.root_path);
    assert.equal(target?.slot, 'stereo');
    assert.throws(() => validateExecutionManifest(db, { provider: 'apple-music', libraryId: library.id, slot: 'spatial' }), /slot/);
});

test('an Apple command cannot import replacement TIDAL offers or a stale provider item ID', () => {
    const item = db.prepare("INSERT INTO ProviderItems (provider, entity_type, provider_id, title) VALUES ('tidal', 'track', '131971386', 'Laura Palmer')").run();
    const offer = { provider: 'tidal', providerTrackId: '131971386', providerTrackItemId: Number(item.lastInsertRowid) };
    assert.throws(() => validateExecutionManifest(db, { provider: 'apple-music', trackOffers: [offer] }), /command provider/);
    assert.doesNotThrow(() => validateExecutionManifest(db, { provider: 'tidal', trackOffers: [offer] }));
    assert.throws(() => validateExecutionManifest(db, { provider: 'tidal', trackOffers: [{ ...offer, providerTrackItemId: offer.providerTrackItemId + 1 }] }), /identity/);
});

test('progress honors exact identity, disc occurrence, ambiguity and skipped state', () => {
    const tracks = [
        { providerTrackId: '1', trackNum: 1, volumeNum: 1, title: 'Intro', status: 'queued' },
        { providerTrackId: '2', trackNum: 1, volumeNum: 2, title: 'Intro', status: 'queued' },
    ];
    assert.deepEqual(applyTrackProgress(tracks, { currentProviderTrackId: '1', currentTrack: 'Intro', trackStatus: 'skipped' }).map(t => t.status), ['skipped', 'queued']);
    assert.equal(applyTrackProgress(tracks, { currentTrack: 'Intro', trackStatus: 'completed' }), tracks);
    assert.equal(applyTrackProgress(tracks, { currentProviderTrackId: '3', currentTrack: 'Intro', trackStatus: 'completed' }), tracks);
    assert.deepEqual(applyTrackProgress(tracks, { currentTrackNum: 1, currentVolumeNum: 2, trackStatus: 'error' }).map(t => t.status), ['queued', 'error']);
});

test('naming formats real bitrate units and does not invent a Proper revision', async () => {
    const { renderRelativePath } = await import('../config/naming.js');
    assert.equal(renderRelativePath('{MediaInfo AudioBitRate}', { artistName: 'Bastille', bitrate: 320000 }), '320 kbps');
    assert.equal(renderRelativePath('{Quality Full}{Quality Proper}', { artistName: 'Bastille', quality: 'LOSSLESS' }), 'LOSSLESS');
});

test('failed imports observe durable cancellation at safe boundaries', async () => {
    const { CommandQueueManager, CommandNames } = await import('../commands/command-queue-manager.js');
    const { isImportDownloadCancellationRequested } = await import('../mediafiles/downloaded-tracks-import-service.js');
    const id = CommandQueueManager.push(CommandNames.DownloadTrack, { provider: 'tidal', providerId: 'test' }, 'test');
    CommandQueueManager.claimForExecution(id, 'test-owner', 90000);
    assert.equal(isImportDownloadCancellationRequested(id), false);
    CommandQueueManager.fail(id, 'test failure', 'test-owner');
    assert.equal(isImportDownloadCancellationRequested(id), true);
});
