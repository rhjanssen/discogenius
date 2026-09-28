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
