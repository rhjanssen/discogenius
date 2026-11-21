import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-trackfile-route-"));
const musicRoot = path.join(tempDir, "music");
fs.mkdirSync(musicRoot, { recursive: true });
process.env.DB_PATH = path.join(tempDir, "discogenius.trackfile-route.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let mutexModule: typeof import("../../database/sqlite-write-mutex.js");
let trackFileRouter: typeof import("./trackfile.js").default;
let fixtures: typeof import("../../test-support/library-fixtures.js");

before(async () => {
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  mutexModule = await import("../../database/sqlite-write-mutex.js");
  trackFileRouter = (await import("./trackfile.js")).default;
  fixtures = await import("../../test-support/library-fixtures.js");
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function deleteHandler(): (req: any, res: any) => Promise<void> | void {
  const layer = (trackFileRouter as any).stack.find((entry: any) => entry.route?.path === "/:fileId" && entry.route?.methods?.delete);
  assert.ok(layer, "Expected DELETE /:fileId");
  return layer.route.stack[0].handle;
}

test("deleting a file while a worker holds the writer waits instead of orphaning its row", async () => {
  const { db } = dbModule;
  db.prepare("INSERT INTO ArtistMetadata (id, mbid, name) VALUES (7, 'artist-mbid', 'Bastille')").run();
  const libraryId = fixtures.seedTestLibrary(db, { name: "Lossless", rootPath: musicRoot });
  const relativePath = path.join("Bastille", "Bad Blood", "01 Pompeii.flac");
  const filePath = path.join(musicRoot, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "audio");
  const fileId = (db.prepare(`
    INSERT INTO TrackFiles (
      artist_metadata_id, file_type, library_slot, library_root, library_id,
      file_path, relative_path, filename, extension
    ) VALUES (7, 'track', 'stereo', 'music', ?, ?, ?, '01 Pompeii.flac', 'flac')
    RETURNING id
  `).get(libraryId, filePath, relativePath) as { id: number }).id;

  // A command worker mid-write: the writer mutex is owned outside this request.
  let releaseWriter!: () => void;
  let writerHeld!: () => void;
  const held = new Promise<void>((resolve) => { writerHeld = resolve; });
  const worker = mutexModule.withSqliteWriteMutexAsync(
    () => new Promise<void>((resolve) => { releaseWriter = resolve; writerHeld(); }),
    "test:busy-worker",
  );
  await held;

  const response = { statusCode: 200, body: undefined as any,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; } };
  const request = deleteHandler()({ params: { fileId: String(fileId) }, query: { allLibraries: "true" } }, response);
  setTimeout(() => releaseWriter(), 50);
  await request;
  await worker;

  const rowLeft = db.prepare("SELECT COUNT(*) AS c FROM TrackFiles WHERE id = ?").get(fileId) as { c: number };
  assert.equal(response.statusCode, 200, JSON.stringify(response.body));
  assert.equal(fs.existsSync(filePath), false);
  assert.equal(rowLeft.c, 0, "a deleted file must not leave its TrackFiles row behind");
});
