// One-time deletion of full-resolution files in the MediaCover cache.
//
// The cache keeps 250 and 500 JPEG proxies. Full-resolution art belongs next
// to the media, in the library. Run this only after import or retag has
// written those sidecars. A cache original is removed when ArtworkLibraryLinks
// already points at a regular file on disk. Proxies, markers and originals
// without that sidecar stay. Without --apply the script only prints counts.
//
// Do not open the host copy of the live database while the container is
// running. Use a readonly connection inside the container, after the retag
// round, and only then pass --apply.
//
//   node api/scripts/drop-media-cover-originals.mjs --self-test
//   node api/scripts/drop-media-cover-originals.mjs --cache /config/media-cover --db /config/discogenius.db
//   node api/scripts/drop-media-cover-originals.mjs --cache /config/media-cover --db /config/discogenius.db --apply

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const FAMILIES = { Albums: "Album", AlbumEditions: "Edition", Videos: "Video" };
const ORIGINAL_NAME = /^[a-z0-9_-]+\.(jpg|jpeg|png|webp|gif)$/i;

export function isCacheOriginalName(name) {
  return ORIGINAL_NAME.test(name) && !/-\d+\.[^.]+$/i.test(name) && !name.startsWith(".");
}

function coverTypeOf(filename) {
  return path.parse(filename).name.toLowerCase();
}

export function listCacheOriginals(root) {
  const cacheRoot = path.resolve(root);
  const found = [];
  const consider = (folder, coverEntity, entityId) => {
    let entries;
    try { entries = fs.readdirSync(folder, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink() || !isCacheOriginalName(entry.name)) continue;
      const file = path.resolve(folder, entry.name);
      if (file !== cacheRoot && !file.startsWith(`${cacheRoot}${path.sep}`)) {
        throw new Error(`MediaCover path escaped ${cacheRoot}`);
      }
      found.push({ coverEntity, entityId, coverType: coverTypeOf(entry.name), file });
    }
  };
  for (const [directory, coverEntity] of Object.entries(FAMILIES)) {
    const base = path.join(cacheRoot, directory);
    let entities = [];
    try { entities = fs.readdirSync(base, { withFileTypes: true }); }
    catch { continue; }
    for (const entity of entities) {
      if (!entity.isDirectory() || entity.isSymbolicLink()) continue;
      consider(path.join(base, entity.name), coverEntity, entity.name);
    }
  }
  let top = [];
  try { top = fs.readdirSync(cacheRoot, { withFileTypes: true }); }
  catch { return found; }
  for (const entity of top) {
    if (!entity.isDirectory() || entity.isSymbolicLink() || FAMILIES[entity.name]) continue;
    consider(path.join(cacheRoot, entity.name), "Artist", entity.name);
  }
  return found;
}

function librarySidecarExists(db, original) {
  const rows = db.prepare(`SELECT file_path FROM ArtworkLibraryLinks
    WHERE cover_entity = ? AND entity_id = ? AND cover_type = ?`).all(
    original.coverEntity, original.entityId, original.coverType,
  );
  return rows.some((row) => {
    try {
      const stat = fs.lstatSync(row.file_path);
      return stat.isFile() && !stat.isSymbolicLink() && stat.size > 0;
    } catch { return false; }
  });
}

export function dropCacheOriginals(root, db, { apply = false } = {}) {
  const summary = { eligible: 0, eligibleBytes: 0, skipped: 0, removed: 0 };
  for (const original of listCacheOriginals(root)) {
    if (!librarySidecarExists(db, original)) {
      summary.skipped += 1;
      continue;
    }
    const size = fs.lstatSync(original.file).size;
    summary.eligible += 1;
    summary.eligibleBytes += size;
    if (apply) {
      fs.unlinkSync(original.file);
      summary.removed += 1;
    }
  }
  return summary;
}

function printSummary(summary, apply) {
  const verb = apply ? "removed" : "would remove";
  console.log(`${verb} ${summary.eligible} cache original(s), ${summary.eligibleBytes} bytes`);
  console.log(`kept ${summary.skipped} original(s) with no library sidecar`);
  if (apply) console.log(`unlinked ${summary.removed}`);
}

function selfTest() {
  assert.equal(isCacheOriginalName("cover.jpg"), true);
  assert.equal(isCacheOriginalName("fanart.png"), true);
  assert.equal(isCacheOriginalName("cover-250.jpg"), false);
  assert.equal(isCacheOriginalName("cover-500.jpeg"), false);
  assert.equal(isCacheOriginalName(".cover.source.json"), false);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-drop-originals-"));
  const library = path.join(root, "library");
  const cache = path.join(root, "media-cover");
  const sidecar = path.join(library, "cover.jpg");
  fs.mkdirSync(path.dirname(sidecar), { recursive: true });
  fs.writeFileSync(sidecar, "library-master");
  const album = path.join(cache, "Albums", "album-1");
  fs.mkdirSync(album, { recursive: true });
  fs.writeFileSync(path.join(album, "cover.jpg"), "cached-original");
  fs.writeFileSync(path.join(album, "cover-500.jpg"), "proxy");
  const bare = path.join(cache, "Albums", "album-2");
  fs.mkdirSync(bare, { recursive: true });
  fs.writeFileSync(path.join(bare, "cover.jpg"), "only-cache");

  const db = new Database(path.join(root, "proof.db"));
  db.exec(`CREATE TABLE ArtworkLibraryLinks (
    cover_entity TEXT, entity_id TEXT, cover_type TEXT, file_path TEXT, content_hash TEXT
  )`);
  db.prepare("INSERT INTO ArtworkLibraryLinks VALUES ('Album','album-1','cover',?, 'abc')").run(sidecar);

  const dry = dropCacheOriginals(cache, db);
  assert.equal(dry.eligible, 1);
  assert.equal(dry.skipped, 1);
  assert.equal(fs.existsSync(path.join(album, "cover.jpg")), true);
  const applied = dropCacheOriginals(cache, db, { apply: true });
  assert.equal(applied.removed, 1);
  assert.equal(fs.existsSync(path.join(album, "cover.jpg")), false);
  assert.equal(fs.readFileSync(path.join(album, "cover-500.jpg"), "utf8"), "proxy");
  assert.equal(fs.readFileSync(path.join(bare, "cover.jpg"), "utf8"), "only-cache");
  assert.equal(fs.readFileSync(sidecar, "utf8"), "library-master");
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
  console.log("self-test passed");
}

function arg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  if (process.argv.includes("--self-test")) {
    selfTest();
  } else {
    const cache = arg("--cache");
    const dbPath = arg("--db");
    if (!cache || !dbPath) {
      console.error("Pass --cache and --db, or --self-test.");
      process.exit(1);
    }
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const apply = process.argv.includes("--apply");
      printSummary(dropCacheOriginals(cache, db, { apply }), apply);
    } finally {
      db.close();
    }
  }
}
