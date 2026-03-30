import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-managed-artists-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.managed-artists.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../database.js");
let managedArtistsModule: typeof import("./managed-artists.js");

before(async () => {
    dbModule = await import("../database.js");
    managedArtistsModule = await import("./managed-artists.js");

    dbModule.initDatabase();
});

beforeEach(() => {
    dbModule.db.prepare("DELETE FROM album_artists").run();
    dbModule.db.prepare("DELETE FROM albums").run();
    dbModule.db.prepare("DELETE FROM library_files").run();
    dbModule.db.prepare("DELETE FROM artists").run();
});

after(() => {
    dbModule.closeDatabase();
    fs.rmSync(tempDir, { recursive: true, force: true });
});

test("getManagedArtistsDueForRefresh respects configured refresh days and keeps stalest artists first", () => {
    dbModule.db.prepare(`
        INSERT INTO artists (id, name, monitor, path, last_scanned)
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