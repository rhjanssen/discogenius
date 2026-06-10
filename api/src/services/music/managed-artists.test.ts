import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-managed-artists-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.managed-artists.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let managedArtistsModule: typeof import("./managed-artists.js");

before(async () => {
    dbModule = await import("../../database.js");
    managedArtistsModule = await import("./managed-artists.js");

    dbModule.initDatabase();
});

beforeEach(() => {
    dbModule.db.prepare("DELETE FROM ReleaseGroupSlots").run();
    dbModule.db.prepare("DELETE FROM Recordings").run();
    dbModule.db.prepare("DELETE FROM Albums").run();
    dbModule.db.prepare("DELETE FROM ArtistMetadata").run();
    dbModule.db.prepare("DELETE FROM ProviderAlbumArtists").run();
    dbModule.db.prepare("DELETE FROM ProviderMedia").run();
    dbModule.db.prepare("DELETE FROM ProviderAlbums").run();
    dbModule.db.prepare("DELETE FROM TrackFiles").run();
    dbModule.db.prepare("DELETE FROM Artists").run();
});

after(() => {
    dbModule.closeDatabase();
    fs.rmSync(tempDir, { recursive: true, force: true });
});

test("getManagedArtistsDueForRefresh respects configured refresh days and keeps stalest artists first", () => {
    dbModule.db.prepare(`
        INSERT INTO Artists (id, name, monitored, path, last_scanned)
        VALUES
            ('1', 'Never Scanned', 1, 'Never Scanned', NULL),
            ('2', 'Recently Scanned', 1, 'Recently Scanned', datetime('now', '-5 days')),
            ('3', 'Stale Scan', 1, 'Stale Scan', datetime('now', '-45 days'))
    `).run();

    const dueArtists = managedArtistsModule.getManagedArtistsDueForRefresh({ refreshDays: 30 });

    assert.deepEqual(
        dueArtists.map((artist) => String(artist.id)),
        ["1", "3"],
    );
});

test("artist completion predicate uses canonical locks instead of provider catalog locks", () => {
    dbModule.db.prepare(`
        INSERT INTO Artists (id, name, mbid, monitored, path)
        VALUES
            ('1', 'provider Locked', 'provider-locked-mbid', 0, 'provider Locked'),
            ('2', 'Slot Locked', 'slot-locked-mbid', 0, 'Slot Locked'),
            ('3', 'Video Locked', 'video-locked-mbid', 0, 'Video Locked')
    `).run();
    dbModule.db.prepare(`
        INSERT INTO ArtistMetadata (mbid, name)
        VALUES
            ('provider-locked-mbid', 'provider Locked'),
            ('slot-locked-mbid', 'Slot Locked'),
            ('video-locked-mbid', 'Video Locked')
    `).run();

    dbModule.db.prepare(`
        INSERT INTO ProviderAlbums (
            id, artist_id, title, type, explicit, quality,
            num_tracks, num_volumes, num_videos, duration, monitored_lock
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("provider-album-1", "1", "provider Album", "ALBUM", 0, "LOSSLESS", 1, 1, 0, 180, 1);
    dbModule.db.prepare(`
        INSERT INTO ProviderMedia (
            id, artist_id, album_id, title, type, explicit, quality, monitored_lock
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("provider-track-1", "1", "provider-album-1", "provider Track", "Track", 0, "LOSSLESS", 1);

    dbModule.db.prepare(`
        INSERT INTO Albums (mbid, artist_mbid, title, primary_type)
        VALUES (?, ?, ?, ?)
    `).run("slot-rg-mbid", "slot-locked-mbid", "Slot Album", "album");
    dbModule.db.prepare(`
        INSERT INTO ReleaseGroupSlots (artist_mbid, release_group_mbid, slot, monitored, monitored_lock)
        VALUES (?, ?, ?, ?, ?)
    `).run("slot-locked-mbid", "slot-rg-mbid", "stereo", 0, 1);
    dbModule.db.prepare(`
        INSERT INTO Recordings (mbid, artist_mbid, title, is_video, monitored_lock)
        VALUES (?, ?, ?, ?, ?)
    `).run("video-recording-mbid", "video-locked-mbid", "Video", 1, 1);

    const predicate = managedArtistsModule.buildArtistCompletionPredicate("a");
    const rows = dbModule.db.prepare(`
        SELECT id
        FROM Artists a
        WHERE ${predicate}
        ORDER BY id
    `).all() as Array<{ id: string }>;

    assert.deepEqual(rows.map((row) => row.id), ["2", "3"]);
});
