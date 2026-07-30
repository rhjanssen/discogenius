import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-prune-canonical-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

const dbModule = await import("../../database.js");
dbModule.initDatabase();
const { db } = dbModule;
const { LibraryFilesService } = await import("./library-files.js");

function reset() {
  for (const t of ["TrackFiles", "LibraryAlbums", "ProviderItems", "Recordings", "Albums", "Artists", "ArtistMetadata"]) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
}
beforeEach(reset);
afterEach(reset);

let testLibraryId = 0;

function seedArtist() {
  db.prepare("INSERT INTO Artists (id, name, mbid, monitored) VALUES (?, ?, ?, ?)")
    .run("art1", "Prune Artist", "artist-mbid", 1);
  db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)").run("artist-mbid", "Prune Artist");
  db.prepare(`
    INSERT OR IGNORE INTO MetadataProfiles (name, release_type_policy)
    VALUES ('Prune Canonical', '{}')
  `).run();
  db.prepare(`
    INSERT OR IGNORE INTO Libraries (
      name, root_path, metadata_profile_id, quality_profile_id, enabled
    )
    SELECT
      'Prune Canonical',
      'C:/lib',
      metadata_profile.id,
      quality_profile.id,
      1
    FROM MetadataProfiles metadata_profile
    JOIN quality_profiles quality_profile
      ON NOT EXISTS (
        SELECT 1
        FROM json_each(COALESCE(quality_profile.allowed_source_formats, '[]')) allowed
        WHERE allowed.value = 'spatial'
      )
    WHERE metadata_profile.name = 'Prune Canonical'
    ORDER BY quality_profile.id
    LIMIT 1
  `).run();
  testLibraryId = (db.prepare(`
    SELECT id FROM Libraries WHERE name = 'Prune Canonical'
  `).get() as { id: number }).id;
}

function seedLibraryGroup(rg: string, monitored: number, lock = 0) {
  db.prepare(`INSERT INTO Albums (mbid, artist_mbid, title, primary_type) VALUES (?, ?, ?, 'album')`)
    .run(rg, "artist-mbid", `RG ${rg}`);
  db.prepare(`
    INSERT INTO LibraryAlbums (
      library_id, release_group_id, monitored, selection_mode, locked,
      curation_version
    )
    SELECT ?, id, ?, 'auto', ?, 1
    FROM Albums
    WHERE mbid = ?
  `).run(testLibraryId, monitored, lock, rg);
}

function seedVideoRecording(monitored: number, providerId: string) {
  const info = db.prepare("INSERT INTO Recordings (mbid, title, artist_mbid, is_video, monitored) VALUES (?, ?, ?, 1, ?)")
    .run(null, "A Video", "artist-mbid", monitored);
  db.prepare(`INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title
    ) VALUES ('tidal', 'video', ?, 'A Video')`).run( providerId );
}

let tfId = 0;
function insertFile(o: {
  fileType: string; slot: string; rg?: string | null; rec?: string | null;
  providerEntityType?: string | null; providerId?: string | null;
}) {
  tfId += 1;
  const info = db.prepare(`
    INSERT INTO TrackFiles (
      artist_id, library_id, release_group_id,
      canonical_release_group_mbid, canonical_recording_mbid,
      provider, provider_entity_type, provider_id, library_slot,
      file_path, relative_path, library_root, filename, extension, file_type
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "art1",
    o.rg ? testLibraryId : null,
    o.rg ? (db.prepare("SELECT id FROM Albums WHERE mbid = ?").get(o.rg) as { id: number }).id : null,
    o.rg ?? null,
    o.rec ?? null,
    o.providerId ? "tidal" : null, o.providerEntityType ?? null, o.providerId ?? null, o.slot,
    `C:/lib/f${tfId}`, `f${tfId}`, "C:/lib", `f${tfId}`, "flac", o.fileType,
  );
  return Number(info.lastInsertRowid);
}

test("selectUnmonitoredFileRows keeps monitored/locked anchors and selects only unmonitored, classifiable files", () => {
  seedArtist();
  seedLibraryGroup("rg-mon", 1);
  seedLibraryGroup("rg-unmon", 0);
  seedLibraryGroup("rg-lock", 0, 1);
  seedVideoRecording(1, "vp-mon");
  seedVideoRecording(0, "vp-unmon");

  const fMonAudio = insertFile({ fileType: "track", slot: "stereo", rg: "rg-mon" });        // keep
  const fUnmonAudio = insertFile({ fileType: "track", slot: "stereo", rg: "rg-unmon" });     // SELECT
  const fLockAudio = insertFile({ fileType: "track", slot: "stereo", rg: "rg-lock" });       // keep (locked)
  const fMonVideo = insertFile({ fileType: "video", slot: "video", providerEntityType: "video", providerId: "vp-mon" });   // keep
  const fUnmonVideo = insertFile({ fileType: "video", slot: "video", providerEntityType: "video", providerId: "vp-unmon" }); // SELECT
  const fNoAnchor = insertFile({ fileType: "track", slot: "stereo" });                       // keep (unclassifiable)

  const selectedIds = LibraryFilesService.selectUnmonitoredFileRows("art1").map((r) => r.id).sort((a, b) => a - b);

  assert.deepEqual(selectedIds, [fUnmonAudio, fUnmonVideo].sort((a, b) => a - b));
  // Sanity: the kept ones are absent.
  for (const keptId of [fMonAudio, fLockAudio, fMonVideo, fNoAnchor]) {
    assert.equal(selectedIds.includes(keptId), false, `file ${keptId} should be kept`);
  }
});

test("an unmonitored library release group does not affect monitored sibling release groups", () => {
  seedArtist();
  seedLibraryGroup("rg-a", 1);
  seedLibraryGroup("rg-b", 0);
  const keep = insertFile({ fileType: "track", slot: "stereo", rg: "rg-a" });
  const select = insertFile({ fileType: "track", slot: "stereo", rg: "rg-b" });

  const ids = LibraryFilesService.selectUnmonitoredFileRows("art1").map((r) => r.id);
  assert.deepEqual(ids, [select]);
  assert.equal(ids.includes(keep), false);
});
