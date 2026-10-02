import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-maintenance-admission-"));
process.env.DB_PATH = path.join(root, "active.db");
process.env.DISCOGENIUS_CONFIG_DIR = root;
let database: typeof import("../../database.js");
let maintenance: typeof import("./runtime-maintenance.js");
before(async () => {
  database = await import("../../database.js");
  database.initDatabase();
  maintenance = await import("./runtime-maintenance.js");
});
after(() => {
  database.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

test("housekeeping waits for the writer before pruning stale tracked assets", async () => {
  database.db.prepare("INSERT INTO ArtistMetadata(id, mbid, name) VALUES (1, 'maintenance-artist', 'Test Artist')").run();
  database.db.prepare("INSERT INTO MetadataFiles(artist_id, file_path, relative_path, library_root, extension, type, file_type) VALUES ('maintenance-artist', ?, 'missing-cover.jpg', ?, 'jpg', 'AlbumImage', 'cover')")
    .run(path.join(root, "missing-cover.jpg"), root);
  let admit!: () => void;
  let release!: () => void;
  const admitted = new Promise<void>(resolve => { admit = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const writer = database.withSqliteWriteGate(async () => { admit(); await blocked; }, "test:held-writer");
  await admitted;
  let settled = false;
  const run = maintenance.runRuntimeMaintenance().then(result => { settled = true; return result; });
  try {
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(settled, false);
    assert.equal((database.db.prepare("SELECT COUNT(*) AS count FROM MetadataFiles").get() as { count: number }).count, 1);
  } finally { release(); }
  await writer;
  const result = await run;
  assert.equal(result.staleTrackedAssetsRemoved, 1);
  assert.equal((database.db.prepare("SELECT COUNT(*) AS count FROM MetadataFiles").get() as { count: number }).count, 0);
});

test("sidecar disk checks release writer admission and cannot delete a concurrently repaired path", async t => {
  const { LibraryFilesService } = await import("../mediafiles/library-files.js");
  const stale = path.join(root, "race-cover.jpg");
  const repaired = path.join(root, "repaired-cover.jpg");
  fs.writeFileSync(repaired, "cover");
  const id = Number(database.db.prepare(`INSERT INTO MetadataFiles
    (artist_id, file_path, relative_path, library_root, extension, type, file_type)
    VALUES ('maintenance-artist', ?, 'race-cover.jpg', ?, 'jpg', 'AlbumImage', 'cover')`).run(stale, root).lastInsertRowid);
  const stat = fs.promises.stat;
  let checking!: () => void;
  let release!: () => void;
  const checked = new Promise<void>(resolve => { checking = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(fs.promises, "stat", async (file: fs.PathLike, ...args: unknown[]) => {
    if (String(file) === stale) { checking(); await blocked; }
    return stat(file, ...args as []);
  });
  const pruning = LibraryFilesService.pruneStaleTrackedAssets();
  await checked;
  try {
    await database.withSqliteWriteGate(() => database.db.prepare(`UPDATE MetadataFiles
      SET file_path = ?, relative_path = 'repaired-cover.jpg' WHERE id = ?`).run(repaired, id), "test:repair-during-stat");
  } finally { release(); }
  assert.equal((await pruning).removed, 0);
  assert.equal((database.db.prepare("SELECT file_path FROM MetadataFiles WHERE id = ?").get(id) as { file_path: string }).file_path, repaired);
});

test("repeated housekeeping preserves distinct physical audio row identities and linked lyrics", async () => {
  const ids = ["one", "two"].map(name => {
    const file = path.join(root, `${name}.flac`);
    fs.writeFileSync(file, "fixture");
    return Number(database.db.prepare(`INSERT INTO TrackFiles
      (file_path, filename, relative_path, library_root, extension, file_type, library_slot, canonical_track_mbid, canonical_recording_mbid)
      VALUES (?, ?, ?, ?, 'flac', 'track', 'stereo', 'same-track', 'same-recording')`).run(file, `${name}.flac`, `${name}.flac`, root).lastInsertRowid);
  });
  const lyric = path.join(root, "one.lrc");
  fs.writeFileSync(lyric, "[00:01]Fixture");
  database.db.prepare(`INSERT INTO LyricFiles (artist_id, track_file_id, file_path, relative_path, library_root, extension)
    VALUES ('maintenance-artist', ?, ?, 'one.lrc', ?, 'lrc')`).run(ids[0], lyric, root);
  await maintenance.runRuntimeMaintenance();
  await maintenance.runRuntimeMaintenance();
  assert.deepEqual((database.db.prepare("SELECT id FROM TrackFiles WHERE canonical_track_mbid = 'same-track' ORDER BY id").all() as Array<{ id: number }>).map(row => row.id), ids);
  assert.equal((database.db.prepare("SELECT track_file_id FROM LyricFiles WHERE file_path = ?").get(lyric) as { track_file_id: number }).track_file_id, ids[0]);
});
