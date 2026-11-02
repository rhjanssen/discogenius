import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { createBaselineSchemaV41 } from "../../database.js";
import { isDerivativeProviderRelease, listDerivativeSourceFiles } from "./derivative-release.js";

test("derivative markers are karaoke, tribute, and originally-performed-by", () => {
  assert.equal(isDerivativeProviderRelease({
    title: "Song (Originally Performed by Bastille) [Karaoke Version]",
  }), true);
  assert.equal(isDerivativeProviderRelease({ title: "Tribute to Bastille" }), true);
  assert.equal(isDerivativeProviderRelease({ version: "In the style of Bastille" }), true);
  assert.equal(isDerivativeProviderRelease({
    title: "Pompeii",
    artistCredit: "Originally Performed by Bastille",
  }), true);
  assert.equal(isDerivativeProviderRelease({ title: "Pompeii", label: "Karaoke Legends" }), true);
  assert.equal(isDerivativeProviderRelease({ version: "Cover Version" }), true);
  assert.equal(isDerivativeProviderRelease({ title: "Give Me the Future", artistCredit: "Bastille" }), false);
  assert.equal(isDerivativeProviderRelease({ title: "Cover Me" }), false);
  assert.equal(isDerivativeProviderRelease({ title: "Tribute" }), false);
});

test("lists on-disk files from a karaoke source and does not delete them", () => {
  const folder = mkdtempSync(path.join(tmpdir(), "discogenius-derivative-files-"));
  const db = new Database(path.join(folder, "test.db"));
  try {
    db.pragma("foreign_keys = ON");
    createBaselineSchemaV41(db);
    db.exec(`
      INSERT INTO ArtistMetadata (id, mbid, name) VALUES (1, 'artist', 'Bastille');
      INSERT INTO Albums (id, mbid, artist_metadata_id, title, artist_mbid)
      VALUES (1, 'rg', 1, 'Pompeii', 'artist');
      INSERT INTO AlbumEditions (id, mbid, release_group_id, title, release_group_mbid, artist_mbid)
      VALUES (1, 'rel', 1, 'Pompeii', 'rg', 'artist');
      INSERT INTO ProviderItems (id, provider, entity_type, provider_id, title) VALUES
        (1, 'tidal', 'release', 'karaoke-album', 'Pompeii (Originally Performed by Bastille) [Karaoke Version]'),
        (2, 'tidal', 'track', 'karaoke-track', 'Pompeii');
      INSERT INTO ProviderEditionMatches (
        provider_edition_item_id, edition_id, relation, match_state,
        decision_source, confidence, method, matcher_version
      ) VALUES (1, 1, 'exact', 'accepted', 'automatic', 1, 'prior', 5);
      INSERT INTO TrackFiles (
        album_edition_id, provider_item_id, file_path, relative_path,
        library_root, filename, extension, file_type
      ) VALUES (
        1, 2, '/music/Pompeii.flac', 'Pompeii.flac', '/music', 'Pompeii.flac', '.flac', 'track'
      );
    `);
    const before = (db.prepare("SELECT COUNT(*) AS n FROM TrackFiles").get() as { n: number }).n;
    const files = listDerivativeSourceFiles(db);
    assert.equal(files.length, 1);
    assert.equal(files[0]?.filePath, "/music/Pompeii.flac");
    assert.equal(files[0]?.provider, "tidal");
    assert.equal(files[0]?.providerId, "karaoke-album");
    assert.equal(files[0]?.marker, "karaoke");
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM TrackFiles").get() as { n: number }).n, before);
  } finally {
    db.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
