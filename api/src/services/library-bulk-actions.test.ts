import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-library-bulk-actions-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../database.js");
let queueModule: typeof import("./queue.js");
let serviceModule: typeof import("./library-bulk-actions.js");

before(async () => {
    dbModule = await import("../database.js");
    dbModule.initDatabase();

    queueModule = await import("./queue.js");
    serviceModule = await import("./library-bulk-actions.js");
});

beforeEach(() => {
    const { db } = dbModule;
    db.prepare("DELETE FROM job_queue").run();
    db.prepare("DELETE FROM ProviderItems").run();
    db.prepare("DELETE FROM TrackFiles").run();
    db.prepare("DELETE FROM Tracks").run();
    db.prepare("DELETE FROM RecordingRelations").run();
    db.prepare("DELETE FROM Recordings").run();
    db.prepare("DELETE FROM AlbumReleaseMedia").run();
    db.prepare("DELETE FROM AlbumReleases").run();
    db.prepare("DELETE FROM AlbumArtists").run();
    db.prepare("DELETE FROM ArtistReleaseGroups").run();
    db.prepare("DELETE FROM ArtistReleaseGroupCuration").run();
    db.prepare("DELETE FROM ReleaseGroupSlots").run();
    db.prepare("DELETE FROM Albums").run();
    db.prepare("DELETE FROM ProviderMediaArtists").run();
    db.prepare("DELETE FROM ProviderAlbumArtists").run();
    db.prepare("DELETE FROM ProviderMedia").run();
    db.prepare("DELETE FROM ProviderAlbums").run();
    db.prepare("DELETE FROM Artists").run();
    db.prepare("DELETE FROM ArtistMetadata").run();
});

after(() => {
    dbModule.closeDatabase();
    fs.rmSync(tempDir, { recursive: true, force: true });
});

function seedLibrary() {
    dbModule.db.prepare(`
        INSERT INTO ArtistMetadata (Id, mbid, name, sort_name, ForeignArtistId)
        VALUES (?, ?, ?, ?, ?)
    `).run(101, "artist-mbid-1", "Artist One", "Artist One", "artist-mbid-1");

    dbModule.db.prepare(`
        INSERT INTO Artists (id, mbid, name, monitor)
        VALUES (?, ?, ?, ?)
    `).run("1", "artist-mbid-1", "Artist One", 0);

    dbModule.db.prepare(`
        INSERT INTO ProviderAlbums (
            id, artist_id, title, type, explicit, quality, num_tracks, num_volumes, num_videos, duration,
            monitor, monitor_lock
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("10", "1", "Album One", "ALBUM", 0, "LOSSLESS", 2, 1, 0, 360, 0, 0);

    dbModule.db.prepare(`
        INSERT INTO ProviderMedia (
            id, artist_id, album_id, title, type, explicit, quality, track_number, volume_number, duration,
            monitor, monitor_lock
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("100", "1", "10", "Track One", "ALBUM", 0, "LOSSLESS", 1, 1, 180, 0, 0);

    dbModule.db.prepare(`
        INSERT INTO ProviderMedia (
            id, artist_id, album_id, title, type, explicit, quality, duration, monitor, monitor_lock
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("200", "1", null, "Video One", "Music Video", 0, "DOLBY_ATMOS", 200, 0, 0);

    dbModule.db.prepare(`
        INSERT INTO ProviderAlbumArtists (album_id, artist_id, artist_name, ord, type, group_type, module)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("10", "artist-mbid-1", "Artist One", 0, "main", "ALBUMS", "ALBUM");

    dbModule.db.prepare(`
        INSERT INTO Albums (mbid, artist_mbid, title, primary_type, first_release_date)
        VALUES (?, ?, ?, ?, ?)
    `).run("release-group-mbid-1", "artist-mbid-1", "Album One", "Album", "2024-01-01");

    dbModule.db.prepare(`
        INSERT INTO AlbumReleases (
            Id, ForeignReleaseId, mbid, release_group_mbid, artist_mbid, title, status, country, date, barcode, media_count, track_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(201, "release-mbid-1", "release-mbid-1", "release-group-mbid-1", "artist-mbid-1", "Album One", "Official", "XW", "2024-01-01", "123456789012", 1, 1);

    dbModule.db.prepare(`
        INSERT INTO Recordings (
            Id, ForeignRecordingId, mbid, ArtistMetadataId, artist_mbid, title, length_ms, IsVideo, MetadataStatus, Monitor, MonitorLock
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(301, "recording-mbid-1", "recording-mbid-1", 101, "artist-mbid-1", "Track One", 180000, 0, "musicbrainz", 0, 0);

    dbModule.db.prepare(`
        INSERT INTO Tracks (
            Id, ForeignTrackId, ForeignRecordingId, mbid, release_mbid, recording_mbid, medium_position, position, number, title, length_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(401, "track-mbid-1", "recording-mbid-1", "track-mbid-1", "release-mbid-1", "recording-mbid-1", 1, 1, "1", "Track One", 180000);

    dbModule.db.prepare(`
        INSERT INTO Recordings (
            Id, ForeignRecordingId, mbid, ArtistMetadataId, artist_mbid, title, length_ms, IsVideo, MetadataStatus, Monitor, MonitorLock
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(501, "video-recording-mbid-1", "video-recording-mbid-1", 101, "artist-mbid-1", "Video One", 200000, 1, "provider_only", 0, 0);

    dbModule.db.prepare(`
        INSERT INTO ProviderItems (
            provider, entity_type, provider_id, artist_mbid, release_group_mbid, release_mbid, track_mbid,
            recording_mbid, title, quality, artist_metadata_id, album_id, album_release_id, track_id, recording_id,
            match_status, match_confidence, match_method
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        "tidal", "track", "100", "artist-mbid-1", "release-group-mbid-1", "release-mbid-1", "track-mbid-1",
        "recording-mbid-1", "Track One", "LOSSLESS", 101, null, 201, 401, 301, "verified", 1, "test",
    );

    dbModule.db.prepare(`
        INSERT INTO ProviderItems (
            provider, entity_type, provider_id, artist_mbid, recording_mbid, title, quality,
            artist_metadata_id, recording_id, match_status, match_confidence, match_method
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        "tidal", "video", "200", "artist-mbid-1", "video-recording-mbid-1", "Video One", "DOLBY_ATMOS",
        101, 501, "verified", 1, "test",
    );

    dbModule.db.prepare(`
        INSERT INTO ReleaseGroupSlots (
            artist_mbid, release_group_mbid, slot, wanted, selected_provider, selected_provider_id,
            quality, match_status, match_confidence, match_method, provider_data
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        "artist-mbid-1",
        "release-group-mbid-1",
        "stereo",
        1,
        "tidal",
        "10",
        "LOSSLESS",
        "verified",
        1,
        "test-provider-slot",
        JSON.stringify({ title: "Album One", cover: null, artist: { name: "Artist One" }, quality: "LOSSLESS" }),
    );

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

    const artist = dbModule.db.prepare("SELECT monitor FROM Artists WHERE id = ?").get("1") as { monitor: number };
    const album = dbModule.db.prepare("SELECT monitor FROM ProviderAlbums WHERE id = ?").get("10") as { monitor: number };
    const track = dbModule.db.prepare("SELECT monitor FROM ProviderMedia WHERE id = ?").get("100") as { monitor: number };
    const video = dbModule.db.prepare("SELECT monitor FROM ProviderMedia WHERE id = ?").get("200") as { monitor: number };

    assert.equal(artist.monitor, 1);
    assert.equal(album.monitor, 0);
    assert.equal(track.monitor, 0);
    assert.equal(video.monitor, 0);

    const queuedJob = dbModule.db.prepare(`
        SELECT type, ref_id as refId, status
        FROM job_queue
        WHERE ref_id = ?
    `).get("1") as { type: string; refId: string; status: string } | undefined;

    assert.ok(queuedJob);
    assert.equal(queuedJob?.type, queueModule.JobTypes.RefreshArtist);
    assert.equal(queuedJob?.refId, "1");
    assert.equal(queuedJob?.status, "pending");
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

    const album = dbModule.db.prepare("SELECT monitor_lock FROM ReleaseGroupSlots WHERE release_group_mbid = ? AND slot = 'stereo'").get(seeded.albumId) as { monitor_lock: number };
    const track = dbModule.db.prepare("SELECT monitor_lock FROM ProviderMedia WHERE id = ?").get("100") as { monitor_lock: number };
    const staleVideo = dbModule.db.prepare("SELECT monitor_lock FROM ProviderMedia WHERE id = ?").get("200") as { monitor_lock: number };
    const video = dbModule.db.prepare("SELECT MonitorLock FROM Recordings WHERE Id = ?").get(seeded.videoId) as { MonitorLock: number };

    assert.equal(album.monitor_lock, 1);
    assert.equal(track.monitor_lock, 0);
    assert.equal(staleVideo.monitor_lock, 0);
    assert.equal(video.MonitorLock, 1);

    await serviceModule.LibraryBulkActionService.apply("album", "unlock", [seeded.albumId]);
    await serviceModule.LibraryBulkActionService.apply("video", "unlock", [seeded.videoId]);

    const unlockedAlbum = dbModule.db.prepare("SELECT monitor_lock FROM ReleaseGroupSlots WHERE release_group_mbid = ? AND slot = 'stereo'").get(seeded.albumId) as { monitor_lock: number };
    const unlockedTrack = dbModule.db.prepare("SELECT monitor_lock FROM ProviderMedia WHERE id = ?").get("100") as { monitor_lock: number };
    const unlockedVideo = dbModule.db.prepare("SELECT MonitorLock FROM Recordings WHERE Id = ?").get(seeded.videoId) as { MonitorLock: number };

    assert.equal(unlockedAlbum.monitor_lock, 0);
    assert.equal(unlockedTrack.monitor_lock, 0);
    assert.equal(unlockedVideo.MonitorLock, 0);
});

test("album bulk actions reject provider album IDs as catalog identity", async () => {
    const seeded = seedLibrary();

    const result = await serviceModule.LibraryBulkActionService.apply("album", "monitor", [seeded.staleProviderAlbumId]);

    assert.equal(result.matched, 0);
    assert.equal(result.missing, 1);

    const providerAlbum = dbModule.db.prepare("SELECT monitor FROM ProviderAlbums WHERE id = ?").get(seeded.staleProviderAlbumId) as { monitor: number };
    const slot = dbModule.db.prepare("SELECT wanted FROM ReleaseGroupSlots WHERE release_group_mbid = ? AND slot = 'stereo'").get(seeded.albumId) as { wanted: number };

    assert.equal(providerAlbum.monitor, 0);
    assert.equal(slot.wanted, 1);
});

test("track and video monitor bulk actions write canonical state only", async () => {
    const seeded = seedLibrary();

    await serviceModule.LibraryBulkActionService.apply("track", "unmonitor", [seeded.trackId]);
    await serviceModule.LibraryBulkActionService.apply("video", "monitor", [seeded.videoId]);

    const slot = dbModule.db.prepare(`
        SELECT wanted
        FROM ReleaseGroupSlots
        WHERE release_group_mbid = ? AND slot = 'stereo'
    `).get("release-group-mbid-1") as { wanted: number };
    const video = dbModule.db.prepare("SELECT Monitor FROM Recordings WHERE Id = ?").get(seeded.videoId) as { Monitor: number };
    const staleTrack = dbModule.db.prepare("SELECT monitor FROM ProviderMedia WHERE id = ?").get(seeded.staleProviderTrackId) as { monitor: number };
    const staleVideo = dbModule.db.prepare("SELECT monitor FROM ProviderMedia WHERE id = ?").get(seeded.staleProviderVideoId) as { monitor: number };

    assert.equal(slot.wanted, 0);
    assert.equal(video.Monitor, 1);
    assert.equal(staleTrack.monitor, 0);
    assert.equal(staleVideo.monitor, 0);
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
        SELECT type
        FROM job_queue
        ORDER BY id ASC
    `).all() as Array<{ type: string }>;

    assert.ok(jobTypes.some((row) => row.type === queueModule.JobTypes.DownloadAlbum));
    assert.ok(jobTypes.some((row) => row.type === queueModule.JobTypes.DownloadTrack));
    assert.ok(jobTypes.some((row) => row.type === queueModule.JobTypes.DownloadVideo));
});

test("artist download queues monitored items when nothing is already queued", async () => {
    seedLibrary();

    await serviceModule.LibraryBulkActionService.apply("artist", "monitor", ["1"]);
    dbModule.db.prepare("DELETE FROM job_queue").run();

    const artistDownload = await serviceModule.LibraryBulkActionService.apply("artist", "download", ["1"]);

    assert.equal(artistDownload.action, "download");
    assert.equal(artistDownload.matched, 1);
    assert.ok(artistDownload.queued > 0);

    const jobTypes = dbModule.db.prepare(`
        SELECT type
        FROM job_queue
        ORDER BY id ASC
    `).all() as Array<{ type: string }>;

    assert.ok(jobTypes.length > 0);
    assert.ok(jobTypes.some((row) => row.type === queueModule.JobTypes.DownloadAlbum || row.type === queueModule.JobTypes.DownloadTrack || row.type === queueModule.JobTypes.DownloadVideo));
});
