import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-playlist-sync-hardening-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../database.js");
let queueModule: typeof import("./queue.js");
let syncModule: typeof import("./playlist-sync.js");
let scannerModule: typeof import("./scanner.js");

before(async () => {
    dbModule = await import("../database.js");
    dbModule.initDatabase();

    queueModule = await import("./queue.js");
    syncModule = await import("./playlist-sync.js");
    scannerModule = await import("./scanner.js");
});

beforeEach(() => {
    const { db } = dbModule;
    db.prepare("DELETE FROM playlist_tracks").run();
    db.prepare("DELETE FROM job_queue").run();
    db.prepare("DELETE FROM playlists").run();
});

after(() => {
    dbModule.closeDatabase();
    fs.rmSync(tempDir, { recursive: true, force: true });
});

function insertPlaylist(uuid: string, title: string = "Playlist Under Test") {
    dbModule.db
        .prepare("INSERT INTO playlists (uuid, tidal_id, title) VALUES (?, ?, ?)")
        .run(uuid, uuid, title);
}

test("queuePlaylistSyncByUuid rejects invalid playlist UUID format", () => {
    assert.throws(
        () => syncModule.queuePlaylistSyncByUuid("not-a-uuid"),
        (error: unknown) =>
            error instanceof syncModule.PlaylistSyncServiceError
            && error.statusCode === 400
            && error.message === "Invalid playlist UUID format",
    );
});

test("queuePlaylistSyncByUuid returns 404 contract error for missing playlist", () => {
    assert.throws(
        () => syncModule.queuePlaylistSyncByUuid("11111111-1111-1111-1111-111111111111"),
        (error: unknown) =>
            error instanceof syncModule.PlaylistSyncServiceError
            && error.statusCode === 404
            && error.message === "Playlist not found",
    );
});

test("queuePlaylistSyncByUuid queues a new playlist scan by UUID", () => {
    const uuid = "11111111-1111-1111-1111-111111111111";
    insertPlaylist(uuid);

    const result = syncModule.queuePlaylistSyncByUuid(uuid);

    assert.equal(result.success, true);
    assert.equal(result.queued, true);
    assert.ok(result.jobId > 0);
    assert.equal(result.commandPath, `/api/queue/${result.jobId}`);
    assert.equal(result.message, "Playlist sync queued");

    const row = dbModule.db.prepare(
        "SELECT type, ref_id as refId, status FROM job_queue WHERE id = ?",
    ).get(result.jobId) as { type: string; refId: string; status: string } | undefined;

    assert.ok(row);
    assert.equal(row?.type, queueModule.JobTypes.ScanPlaylist);
    assert.equal(row?.refId, uuid);
    assert.equal(row?.status, "pending");
});

test("queuePlaylistSyncByUuid returns existing queued/processing job", () => {
    const uuid = "22222222-2222-2222-2222-222222222222";
    insertPlaylist(uuid);

    const existingJobId = queueModule.TaskQueueService.addJob(
        queueModule.JobTypes.ScanPlaylist,
        { tidalId: uuid },
        uuid,
    );

    const result = syncModule.queuePlaylistSyncByUuid(uuid);

    assert.equal(result.success, true);
    assert.equal(result.queued, false);
    assert.equal(result.jobId, existingJobId);
    assert.equal(result.commandPath, `/api/queue/${existingJobId}`);
    assert.equal(result.message, "Playlist sync is already queued or processing");
});

test("validatePlaylistTrackPayload classifies empty and malformed states", () => {
    const empty = scannerModule.validatePlaylistTrackPayload(0, []);
    assert.equal(empty.state, "empty");
    assert.equal(empty.remoteItemCount, 0);

    const malformedShape = scannerModule.validatePlaylistTrackPayload(3, { items: "oops" });
    assert.equal(malformedShape.state, "malformed");

    const malformedNoIds = scannerModule.validatePlaylistTrackPayload(2, [{ foo: "bar" }, { id: null }]);
    assert.equal(malformedNoIds.state, "malformed");
});

test("validatePlaylistTrackPayload classifies partial and valid states", () => {
    const partialParse = scannerModule.validatePlaylistTrackPayload(2, [{ id: 1 }, { foo: "bar" }]);
    assert.equal(partialParse.state, "partial");
    assert.equal(partialParse.tracks.length, 1);

    const partialCount = scannerModule.validatePlaylistTrackPayload(3, [{ id: 1 }, { id: 2 }]);
    assert.equal(partialCount.state, "partial");

    const valid = scannerModule.validatePlaylistTrackPayload(2, [
        { id: 1, album_id: 11 },
        { item: { id: "2", album: { id: "22" } } },
    ]);

    assert.equal(valid.state, "valid");
    assert.equal(valid.tracks.length, 2);
    assert.deepEqual(valid.tracks, [
        { trackId: 1, position: 0, albumId: "11" },
        { trackId: 2, position: 1, albumId: "22" },
    ]);
});
