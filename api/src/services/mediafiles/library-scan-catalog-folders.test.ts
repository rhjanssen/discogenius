import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-catalog-folders-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

const dbModule = await import("../../database.js");
dbModule.initDatabase();
const { db } = dbModule;
const { persistRootReviewCandidates } = await import("./library-scan-root-review.js");
const { resolveCatalogArtistFromFolderName } = await import("./library-scan.js");
const { isArtistLibraryMonitored } = await import("../music/managed-artists.js");

function resetRows() {
  db.prepare("DELETE FROM UnmappedFiles").run();
  db.prepare("DELETE FROM TrackFiles").run();
  db.prepare("DELETE FROM LibraryArtists").run();
  db.prepare("DELETE FROM ArtistMetadata").run();
}

beforeEach(resetRows);
afterEach(resetRows);

test("resolveCatalogArtistFromFolderName matches a catalog artist by naming MBID without LibraryArtists", () => {
  db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
    .run("301b45a4-b8b9-410e-8344-4b4eaf96691a", "Marshmello");

  const match = resolveCatalogArtistFromFolderName(
    "Marshmello {mbid-301b45a4-b8b9-410e-8344-4b4eaf96691a}",
  );
  assert.ok(match);
  assert.equal(match?.mbid, "301b45a4-b8b9-410e-8344-4b4eaf96691a");
  assert.equal(match?.name, "Marshmello");
  assert.equal(isArtistLibraryMonitored(String(match?.id)), false);
});

test("resolveCatalogArtistFromFolderName returns null for an unknown folder", () => {
  db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
    .run("301b45a4-b8b9-410e-8344-4b4eaf96691a", "Marshmello");
  assert.equal(resolveCatalogArtistFromFolderName("Some Random Folder"), null);
});

test("root review persistence skips files already imported as TrackFiles", async () => {
  db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
    .run("artist-mbid", "Bastille");
  const artistId = (db.prepare("SELECT id FROM ArtistMetadata WHERE mbid = ?")
    .get("artist-mbid") as { id: number }).id;
  const importedPath = path.join(tempDir, "01 - Pompeii.flac");
  fs.writeFileSync(importedPath, "flac");
  const reviewPath = path.join(tempDir, "02 - Things We Lost.flac");
  fs.writeFileSync(reviewPath, "flac");

  db.prepare(`
    INSERT INTO TrackFiles (
      artist_metadata_id, library_slot, file_path, relative_path, library_root,
      filename, extension, file_type
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    artistId,
    "stereo",
    importedPath,
    "01 - Pompeii.flac",
    tempDir,
    "01 - Pompeii.flac",
    "flac",
    "track",
  );

  await persistRootReviewCandidates([{
    group: {
      id: "group-1",
      path: tempDir,
      rootPath: tempDir,
      libraryRoot: "music",
      files: [
        { path: importedPath, name: "01 - Pompeii.flac", size: 4, extension: ".flac" },
        { path: reviewPath, name: "02 - Things We Lost.flac", size: 4, extension: ".flac" },
      ],
      sidecars: [],
      commonTags: { artist: "Bastille", album: "Bad Blood" },
      status: "queued",
    },
    matches: [{
      item: {},
      itemType: "album",
      score: 1,
      matchType: "exact",
      rejections: ["Manual review required after root folder scan"],
    }],
  }]);

  const rows = db.prepare("SELECT file_path FROM UnmappedFiles ORDER BY file_path").all() as Array<{
    file_path: string;
  }>;
  assert.deepEqual(rows.map((row) => row.file_path), [reviewPath]);
});
