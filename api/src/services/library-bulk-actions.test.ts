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
    db.prepare("DELETE FROM media_artists").run();
    db.prepare("DELETE FROM album_artists").run();
    db.prepare("DELETE FROM media").run();
    db.prepare("DELETE FROM albums").run();
    db.prepare("DELETE FROM artists").run();
    db.prepare("DELETE FROM library_files").run();
});

after(() => {
    dbModule.closeDatabase();
    fs.rmSync(tempDir, { recursive: true, force: true });
});

function seedLibrary() {
    dbModule.db.prepare(`
        INSERT INTO artists (id, name, monitor)
        VALUES (?, ?, ?)
    `).run(1, "Artist One", 0);

    dbModule.db.prepare(`
        INSERT INTO albums (
            id, artist_id, title, type, explicit, quality, num_tracks, num_volumes, num_videos, duration,
            monitor, monitor_lock
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(10, 1, "Album One", "ALBUM", 0, "LOSSLESS", 2, 1, 0, 360, 0, 0);

    dbModule.db.prepare(`
        INSERT INTO media (
            id, artist_id, album_id, title, type, explicit, quality, track_number, volume_number, duration,
            monitor, monitor_lock
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(100, 1, 10, "Track One", "ALBUM", 0, "LOSSLESS", 1, 1, 180, 0, 0);

    dbModule.db.prepare(`
        INSERT INTO media (
            id, artist_id, album_id, title, type, explicit, quality, duration, monitor, monitor_lock
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(200, 1, null, "Video One", "Music Video", 0, "DOLBY_ATMOS", 200, 0, 0);

    dbModule.db.prepare(`
        INSERT INTO album_artists (album_id, artist_id, artist_name, ord, type, group_type, module)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(10, 1, "Artist One", 0, "main", "ALBUMS", "ALBUM");
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

    const artist = dbModule.db.prepare("SELECT monitor FROM artists WHERE id = 1").get() as { monitor: number };
    const album = dbModule.db.prepare("SELECT monitor FROM albums WHERE id = 10").get() as { monitor: number };
    const track = dbModule.db.prepare("SELECT monitor FROM media WHERE id = 100").get() as { monitor: number };
    const video = dbModule.db.prepare("SELECT monitor FROM media WHERE id = 200").get() as { monitor: number };

    assert.equal(artist.monitor, 1);
    assert.equal(album.monitor, 1);
    assert.equal(track.monitor, 1);
    assert.equal(video.monitor, 1);

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

test("album and track bulk actions update lock state without changing route code", async () => {
    seedLibrary();

    const albumLock = await serviceModule.LibraryBulkActionService.apply("album", "lock", ["10"]);
    const trackLock = await serviceModule.LibraryBulkActionService.apply("track", "lock", ["100"]);
    const videoLock = await serviceModule.LibraryBulkActionService.apply("video", "lock", ["200"]);

    assert.equal(albumLock.matched, 1);
    assert.equal(trackLock.matched, 1);
    assert.equal(videoLock.matched, 1);

    const album = dbModule.db.prepare("SELECT monitor_lock FROM albums WHERE id = 10").get() as { monitor_lock: number };
    const track = dbModule.db.prepare("SELECT monitor_lock FROM media WHERE id = 100").get() as { monitor_lock: number };
    const video = dbModule.db.prepare("SELECT monitor_lock FROM media WHERE id = 200").get() as { monitor_lock: number };

    assert.equal(album.monitor_lock, 1);
    assert.equal(track.monitor_lock, 1);
    assert.equal(video.monitor_lock, 1);

    await serviceModule.LibraryBulkActionService.apply("album", "unlock", ["10"]);
    await serviceModule.LibraryBulkActionService.apply("track", "unlock", ["100"]);
    await serviceModule.LibraryBulkActionService.apply("video", "unlock", ["200"]);

    const unlockedAlbum = dbModule.db.prepare("SELECT monitor_lock FROM albums WHERE id = 10").get() as { monitor_lock: number };
    const unlockedTrack = dbModule.db.prepare("SELECT monitor_lock FROM media WHERE id = 100").get() as { monitor_lock: number };
    const unlockedVideo = dbModule.db.prepare("SELECT monitor_lock FROM media WHERE id = 200").get() as { monitor_lock: number };

    assert.equal(unlockedAlbum.monitor_lock, 0);
    assert.equal(unlockedTrack.monitor_lock, 0);
    assert.equal(unlockedVideo.monitor_lock, 0);
});

test("bulk download queues the selected media jobs", async () => {
    seedLibrary();

    await serviceModule.LibraryBulkActionService.apply("album", "monitor", ["10"]);
    await serviceModule.LibraryBulkActionService.apply("track", "monitor", ["100"]);
    await serviceModule.LibraryBulkActionService.apply("video", "monitor", ["200"]);

    const albumDownload = await serviceModule.LibraryBulkActionService.apply("album", "download", ["10"]);
    const trackDownload = await serviceModule.LibraryBulkActionService.apply("track", "download", ["100"]);
    const videoDownload = await serviceModule.LibraryBulkActionService.apply("video", "download", ["200"]);

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
