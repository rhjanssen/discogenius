import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-library-bulk-actions-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let queueModule: typeof import("../commands/command-queue-manager.js");
let serviceModule: typeof import("./library-bulk-actions.js");

function assertRetiredProviderCatalogTablesAbsent() {
    const rows = dbModule.db.prepare(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name IN ('ProviderAlbums', 'ProviderMedia', 'ProviderAlbumArtists', 'ProviderMediaArtists')
    `).all() as Array<{ name: string }>;
    assert.deepEqual(rows, []);
}

before(async () => {
    dbModule = await import("../../database.js");
    dbModule.initDatabase();

    queueModule = await import("../commands/command-queue-manager.js");
    serviceModule = await import("./library-bulk-actions.js");
});

beforeEach(() => {
    const { db } = dbModule;
    db.prepare("DELETE FROM commands").run();
    db.prepare("DELETE FROM TrackFiles").run();
    db.prepare("DELETE FROM LibraryEditionScopes").run();
    db.prepare("DELETE FROM LibraryEditions").run();
    db.prepare("DELETE FROM LibraryAlbums").run();
    db.prepare("DELETE FROM LibraryArtists").run();
    db.prepare("DELETE FROM ManagedArtists").run();
    db.prepare("DELETE FROM ProviderTrackMatches").run();
    db.prepare("DELETE FROM ProviderVideoMatches").run();
    db.prepare("DELETE FROM ProviderEditionMatches").run();
    db.prepare("DELETE FROM ProviderEditionMembers").run();
    db.prepare("DELETE FROM ProviderItemAudioVariants").run();
    db.prepare("DELETE FROM ProviderItems").run();
    db.prepare("DELETE FROM Tracks").run();
    db.prepare("DELETE FROM RecordingRelations").run();
    db.prepare("DELETE FROM Recordings").run();
    db.prepare("DELETE FROM AlbumEditions").run();
    db.prepare("DELETE FROM AlbumArtists").run();
    db.prepare("DELETE FROM ArtistReleaseGroups").run();
    db.prepare("DELETE FROM ArtistReleaseGroupCuration").run();
    db.prepare("DELETE FROM Albums").run();
    db.prepare("DELETE FROM Artists").run();
    db.prepare("DELETE FROM ArtistMetadata").run();
});

after(() => {
    dbModule.closeDatabase();
    fs.rmSync(tempDir, { recursive: true, force: true });
});

function seedLibrary() {
    dbModule.db.prepare(`
        INSERT INTO ArtistMetadata (id, mbid, name, sort_name, foreign_artist_id)
        VALUES (?, ?, ?, ?, ?)
    `).run(101, "artist-mbid-1", "Artist One", "Artist One", "artist-mbid-1");

    dbModule.db.prepare(`
        INSERT INTO Artists (id, mbid, name, monitored)
        VALUES (?, ?, ?, ?)
    `).run("1", "artist-mbid-1", "Artist One", 0);



dbModule.db.prepare(`
        INSERT INTO Albums (mbid, artist_mbid, title, primary_type, first_release_date)
        VALUES (?, ?, ?, ?, ?)
    `).run("release-group-mbid-1", "artist-mbid-1", "Album One", "Album", "2024-01-01");

    dbModule.db.prepare(`
        INSERT INTO AlbumEditions (
            id, foreign_release_id, mbid, release_group_mbid, artist_mbid, title, status, country, date, barcode, media_count, track_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(201, "release-mbid-1", "release-mbid-1", "release-group-mbid-1", "artist-mbid-1", "Album One", "Official", "XW", "2024-01-01", "123456789012", 1, 1);

    dbModule.db.prepare(`
        INSERT INTO Recordings (
            id, foreign_recording_id, mbid, artist_metadata_id, artist_mbid, title, length_ms, is_video, metadata_status, monitored, monitored_lock
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(301, "recording-mbid-1", "recording-mbid-1", 101, "artist-mbid-1", "Track One", 180000, 0, "musicbrainz", 0, 0);

    dbModule.db.prepare(`
        INSERT INTO Tracks (
            id, foreign_track_id, foreign_recording_id, mbid, edition_mbid, recording_mbid, medium_position, position, number, title, length_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(401, "track-mbid-1", "recording-mbid-1", "track-mbid-1", "release-mbid-1", "recording-mbid-1", 1, 1, "1", "Track One", 180000);

    dbModule.db.prepare(`
        INSERT INTO Recordings (
            id, foreign_recording_id, mbid, artist_metadata_id, artist_mbid, title, length_ms, is_video, metadata_status, monitored, monitored_lock
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(501, "video-recording-mbid-1", "video-recording-mbid-1", 101, "artist-mbid-1", "Video One", 200000, 1, "provider_only", 0, 0);

    const releaseGroupId = (dbModule.db.prepare(`
        SELECT id FROM Albums WHERE mbid = 'release-group-mbid-1'
    `).get() as { id: number }).id;
    const libraryId = (dbModule.db.prepare(`
        SELECT id FROM Libraries WHERE name = 'Stereo'
    `).get() as { id: number }).id;
    const managedArtistId = (dbModule.db.prepare(`
        INSERT INTO ManagedArtists (artist_id) VALUES (101) RETURNING id
    `).get() as { id: number }).id;
    const libraryArtistId = (dbModule.db.prepare(`
        INSERT INTO LibraryArtists (library_id, managed_artist_id, monitored, credited_scope)
        VALUES (?, ?, 1, 'release_and_track_credit') RETURNING id
    `).get(libraryId, managedArtistId) as { id: number }).id;
    dbModule.db.prepare(`
        INSERT INTO LibraryAlbums (
            library_id, release_group_id, monitored, selection_mode, locked, reason, curation_version
        ) VALUES (?, ?, 1, 'auto', 0, 'test', 1)
    `).run(libraryId, releaseGroupId);
    const libraryReleaseId = (dbModule.db.prepare(`
        INSERT INTO LibraryEditions (
            library_id, edition_id, selection_mode, locked, reason, curation_version
        ) VALUES (?, 201, 'auto', 0, 'test', 1)
        RETURNING id
    `).get(libraryId) as { id: number }).id;
    dbModule.db.prepare(`
        INSERT INTO LibraryEditionScopes (library_edition_id, library_artist_id, scope_type)
        VALUES (?, ?, 'primary')
    `).run(libraryReleaseId, libraryArtistId);

    const releaseItemId = (dbModule.db.prepare(`
        INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title, provider_type, availability, artwork_url
    ) VALUES ('tidal', 'release', '10', 'Album One', 'ALBUM', 'available', 'cover-10')
        RETURNING id
    `).get() as { id: number }).id;
    const trackItemId = (dbModule.db.prepare(`
        INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title, duration_ms, availability
    ) VALUES ('tidal', 'track', '100', 'Track One', 180000, 'available')
        RETURNING id
    `).get() as { id: number }).id;
    const videoItemId = (dbModule.db.prepare(`
        INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title, provider_type, availability
    ) VALUES ('tidal', 'video', '200', 'Video One', 'MUSIC_VIDEO', 'available')
        RETURNING id
    `).get() as { id: number }).id;
    const memberId = (dbModule.db.prepare(`
        INSERT INTO ProviderEditionMembers (
            provider_edition_item_id, member_item_id, medium_position, position
        ) VALUES (?, ?, 1, 1)
        RETURNING id
    `).get(releaseItemId, trackItemId) as { id: number }).id;
    const variantId = (dbModule.db.prepare(`
        INSERT INTO ProviderItemAudioVariants (
            provider_item_id, variant_key, quality_class, lossless, availability
        ) VALUES (?, 'lossless', 'lossless', 1, 'available')
        RETURNING id
    `).get(trackItemId) as { id: number }).id;
    const releaseMatchId = (dbModule.db.prepare(`
        INSERT INTO ProviderEditionMatches (
            provider_edition_item_id, edition_id, relation, match_state, decision_source,
            confidence, method, matcher_version, matched_track_count,
            source_track_count, target_track_count, source_coverage, target_coverage
        ) VALUES (?, 201, 'exact', 'accepted', 'automatic', 1, 'test', 1, 1, 1, 1, 1, 1)
        RETURNING id
    `).get(releaseItemId) as { id: number }).id;
    const trackMatchId = (dbModule.db.prepare(`
        INSERT INTO ProviderTrackMatches (
            provider_edition_member_id, provider_edition_match_id, track_id, recording_id,
            match_state, decision_source, confidence, method, matcher_version
        ) VALUES (?, ?, 401, 301, 'accepted', 'automatic', 1, 'test', 1)
        RETURNING id
    `).get(memberId, releaseMatchId) as { id: number }).id;
    dbModule.db.prepare(`
        INSERT INTO ProviderVideoMatches (
            provider_video_item_id, recording_id, match_state, decision_source,
            confidence, method, matcher_version
        ) VALUES (?, 501, 'accepted', 'automatic', 1, 'test', 1)
    `).run(videoItemId);
    const planId = (dbModule.db.prepare(`
        INSERT INTO AcquisitionPlans (
            library_edition_id, provider, composition, download_mode, state,
            planner_version, policy_hash, computed_at
        ) VALUES (?, 'tidal', 'single_source', 'album', 'current', 1, 'test', CURRENT_TIMESTAMP)
        RETURNING id
    `).get(libraryReleaseId) as { id: number }).id;
    const sourceId = (dbModule.db.prepare(`
        INSERT INTO AcquisitionPlanSources (
            plan_id, provider_edition_match_id, role, sort_order
        ) VALUES (?, ?, 'primary', 0)
        RETURNING id
    `).get(planId, releaseMatchId) as { id: number }).id;
    dbModule.db.prepare(`
        INSERT INTO AcquisitionPlanTracks (
            plan_id, track_id, source_id, provider_track_match_id,
            provider_audio_variant_id, source_quality_snapshot
        ) VALUES (?, 401, ?, ?, ?, '{"quality":"LOSSLESS"}')
    `).run(planId, sourceId, trackMatchId, variantId);

    return {
        albumId: "release-group-mbid-1",
        staleProviderAlbumId: "10",
        trackId: "track-mbid-1",
        trackLocalId: "401",
        videoId: "501",
        staleProviderTrackId: "100",
        staleProviderVideoId: "200",
    };
}

test("artist monitor bulk updates related rows and queues intake", async () => {
    seedLibrary();

    const result = await serviceModule.LibraryBulkActionService.apply("artist", "monitor", ["1"]);

    assert.equal(result.entity, "artist");
    assert.equal(result.action, "monitor");
    assert.equal(result.requested, 1);
    assert.equal(result.matched, 1);
    assert.equal(result.missing, 0);
    assert.equal(result.queued, 1);
    assert.equal(result.updated, 1);
    assert.equal(result.items[0]?.status, "queued");

    const artist = dbModule.db.prepare("SELECT monitored FROM Artists WHERE id = ?").get("1") as { monitored: number };

    assert.equal(artist.monitored, 1);
    assertRetiredProviderCatalogTablesAbsent();

    const queuedJob = dbModule.db.prepare(`
        SELECT name, ref_id as refId, status
        FROM commands
        WHERE ref_id = ?
    `).get("1") as { name: string; refId: string; status: string } | undefined;

    assert.ok(queuedJob);
    assert.equal(queuedJob?.name, queueModule.CommandNames.RefreshArtist);
    assert.equal(queuedJob?.refId, "1");
    assert.equal(queuedJob?.status, "queued");
});

test("album and video lock bulk actions write canonical state", async () => {
    const seeded = seedLibrary();

    const albumLock = await serviceModule.LibraryBulkActionService.apply("album", "lock", [seeded.albumId]);
    const trackLock = await serviceModule.LibraryBulkActionService.apply("track", "lock", [seeded.trackId]);
    const videoLock = await serviceModule.LibraryBulkActionService.apply("video", "lock", [seeded.videoId]);

    assert.equal(albumLock.matched, 1);
    assert.equal(trackLock.matched, 1);
    assert.equal(trackLock.unsupported, 1);
    assert.equal(videoLock.matched, 1);

    const album = dbModule.db.prepare(`
        SELECT locked AS monitor_lock
        FROM LibraryAlbums
        WHERE release_group_id = (SELECT id FROM Albums WHERE mbid = ?)
    `).get(seeded.albumId) as { monitor_lock: number };
    const video = dbModule.db.prepare("SELECT monitored_lock FROM Recordings WHERE id = ?").get(seeded.videoId) as { monitored_lock: number };

    assert.equal(album.monitor_lock, 1);
    assert.equal(video.monitored_lock, 1);
    assertRetiredProviderCatalogTablesAbsent();

    await serviceModule.LibraryBulkActionService.apply("album", "unlock", [seeded.albumId]);
    await serviceModule.LibraryBulkActionService.apply("video", "unlock", [seeded.videoId]);

    const unlockedAlbum = dbModule.db.prepare(`
        SELECT locked AS monitor_lock
        FROM LibraryAlbums
        WHERE release_group_id = (SELECT id FROM Albums WHERE mbid = ?)
    `).get(seeded.albumId) as { monitor_lock: number };
    const unlockedVideo = dbModule.db.prepare("SELECT monitored_lock FROM Recordings WHERE id = ?").get(seeded.videoId) as { monitored_lock: number };

    assert.equal(unlockedAlbum.monitor_lock, 0);
    assert.equal(unlockedVideo.monitored_lock, 0);
});

test("album bulk actions reject provider album IDs as catalog identity", async () => {
    const seeded = seedLibrary();

    const result = await serviceModule.LibraryBulkActionService.apply("album", "monitor", [seeded.staleProviderAlbumId]);

    assert.equal(result.matched, 0);
    assert.equal(result.missing, 1);

    const slot = dbModule.db.prepare(`
        SELECT monitored AS wanted
        FROM LibraryAlbums
        WHERE release_group_id = (SELECT id FROM Albums WHERE mbid = ?)
    `).get(seeded.albumId) as { wanted: number };

    assert.equal(slot.wanted, 1);
    assertRetiredProviderCatalogTablesAbsent();
});

test("track and video monitor bulk actions write canonical state only", async () => {
    const seeded = seedLibrary();

    await serviceModule.LibraryBulkActionService.apply("track", "unmonitor", [seeded.trackId]);
    await serviceModule.LibraryBulkActionService.apply("video", "monitor", [seeded.videoId]);

    const slot = dbModule.db.prepare(`
        SELECT monitored AS wanted
        FROM LibraryAlbums
        WHERE release_group_id = (SELECT id FROM Albums WHERE mbid = ?)
    `).get("release-group-mbid-1") as { wanted: number };
    const video = dbModule.db.prepare("SELECT monitored AS Monitor FROM Recordings WHERE id = ?").get(seeded.videoId) as { Monitor: number };

    assert.equal(slot.wanted, 0);
    assert.equal(video.Monitor, 1);
    assertRetiredProviderCatalogTablesAbsent();
});

test("bulk download queues the selected media jobs", async () => {
    const seeded = seedLibrary();

    await serviceModule.LibraryBulkActionService.apply("album", "monitor", [seeded.albumId]);
    await serviceModule.LibraryBulkActionService.apply("track", "monitor", [seeded.trackId]);
    await serviceModule.LibraryBulkActionService.apply("video", "monitor", [seeded.videoId]);

    const albumDownload = await serviceModule.LibraryBulkActionService.apply("album", "download", [seeded.albumId]);
    const trackDownload = await serviceModule.LibraryBulkActionService.apply("track", "download", [seeded.trackId]);
    const videoDownload = await serviceModule.LibraryBulkActionService.apply("video", "download", [seeded.videoId]);

    assert.equal(albumDownload.action, "download");
    assert.equal(trackDownload.action, "download");
    assert.equal(videoDownload.action, "download");

    assert.ok(albumDownload.queued > 0);
    assert.ok(trackDownload.queued > 0);
    assert.ok(videoDownload.queued > 0);

    const jobTypes = dbModule.db.prepare(`
        SELECT name
        FROM commands
        ORDER BY id ASC
    `).all() as Array<{ name: string }>;

    assert.ok(jobTypes.some((row) => row.name === queueModule.CommandNames.DownloadAlbum));
    assert.ok(jobTypes.filter((row) => row.name === queueModule.CommandNames.DownloadAlbum).length >= 2);
    assert.ok(jobTypes.some((row) => row.name === queueModule.CommandNames.DownloadVideo));
});

test("artist download queues monitored items when nothing is already queued", async () => {
    seedLibrary();

    await serviceModule.LibraryBulkActionService.apply("artist", "monitor", ["1"]);
    dbModule.db.prepare("DELETE FROM commands").run();

    const artistDownload = await serviceModule.LibraryBulkActionService.apply("artist", "download", ["1"]);

    assert.equal(artistDownload.action, "download");
    assert.equal(artistDownload.matched, 1);
    assert.ok(artistDownload.queued > 0);

    const jobTypes = dbModule.db.prepare(`
        SELECT name, payload
        FROM commands
        ORDER BY id ASC
    `).all() as Array<{ name: string; payload: string }>;

    assert.ok(jobTypes.length > 0);
    const downloadMissingJob = jobTypes.find((row) => row.name === queueModule.CommandNames.DownloadMissing);
    assert.ok(downloadMissingJob);
    assert.deepEqual(JSON.parse(downloadMissingJob.payload).artistIds, ["1"]);
});
