import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { before, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-unlink-"));
process.env.DB_PATH = path.join(tempDir, "unlink.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let dup: typeof import("./duplicate-track-files.js");
before(async () => {
    dbModule = await import("../../database.js");
    dbModule.initDatabase();
    dup = await import("./duplicate-track-files.js");
});

test("unlinking a track file moves its link to UnmappedFiles and leaves the file path untouched", () => {
    const { db } = dbModule;
    const id = Number(db.prepare(`
        INSERT INTO TrackFiles (file_path, relative_path, library_root, filename, extension, file_type, duration)
        VALUES ('/music/A/01 - x.flac', 'A/01 - x.flac', '/music', '01 - x.flac', 'flac', 'track', 212)
    `).run().lastInsertRowid);
    assert.equal(dup.moveToUnmapped(id, "Re-match"), true);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM TrackFiles WHERE id = ?").get(id) as { n: number }).n, 0);
    const row = db.prepare("SELECT file_path, reason, duration FROM UnmappedFiles WHERE file_path = '/music/A/01 - x.flac'").get() as { file_path: string; reason: string; duration: number };
    assert.equal(row.reason, "Re-match");
    assert.equal(row.duration, 212);
    assert.equal(dup.moveToUnmapped(id, "again"), false);
});
