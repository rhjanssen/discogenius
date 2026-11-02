import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { seedLibraryArtistMonitoring } from "../../test-support/active-schema-fixture.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-naming-quality-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;
process.env.MUSIC_PATH = path.join(tempDir, "stereo");
process.env.SPATIAL_PATH = path.join(tempDir, "spatial");
process.env.VIDEO_PATH = path.join(tempDir, "video");
process.env.DOWNLOAD_PATH = path.join(tempDir, "downloads");

const STRAVINSKY_MBID = "c278de2c-da48-4c8e-8e8c-7c6c3d1e0e0e";
const STRAVINSKY_CYRILLIC = "Игорь Фёдорович Стравинский";
const FIREBIRD_TITLE = "The Firebird (Zhar-ptitsa), K010 (revised 1945 version): Tableau I. Introduction. Kashchei's Enchanted Garden. Appearance of the Firebird pursued by Ivan Tsarevich. Dance of the Firebird. Capture of the Firebird by Ivan Tsarevich. The Firebird's supplication (1945)";

let dbModule: typeof import("../../database.js");
let naming: typeof import("./naming.js");
let artistPaths: typeof import("../music/artist-paths.js");
let configModule: typeof import("./config.js");
before(async () => {
  fs.mkdirSync(process.env.MUSIC_PATH!, { recursive: true });
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  naming = await import("./naming.js");
  artistPaths = await import("../music/artist-paths.js");
  configModule = await import("./config.js");
});

beforeEach(() => {
  dbModule.db.prepare("DELETE FROM ArtistLocaleAliases").run();
  dbModule.db.prepare("DELETE FROM LibraryArtists").run();
  dbModule.db.prepare("DELETE FROM ArtistMetadata").run();
  const config = configModule.readConfig();
  config.path.music_path = process.env.MUSIC_PATH!;
  config.naming.artist_folder = "{Artist Name} {mbid-{Artist MbId}}";
  config.naming.album_track_path_single = "{Edition Title} ({Release Year}) {mbid-{Edition MbId}}/{track:00} - {Track Title}";
  config.metadata.translate_artist_names = true;
  config.metadata.artist_name_locales = "en,nl";
  config.metadata.translate_artist_names_skip_latin = true;
  configModule.writeConfig(config);
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function seedStravinskyAlias(): void {
  dbModule.db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name, sort_name) VALUES (?, ?, ?)
  `).run(STRAVINSKY_MBID, STRAVINSKY_CYRILLIC, "Стравинский, Игорь Фёдорович");
  seedLibraryArtistMonitoring(dbModule.db, STRAVINSKY_MBID);
  dbModule.db.prepare(`
    INSERT INTO ArtistLocaleAliases (artist_mbid, ordinal, name, sort_name, locale, primary_for_locale, alias_type)
    VALUES (?, 0, 'Igor Stravinsky', 'Stravinsky, Igor', 'en', 1, 'Artist name')
  `).run(STRAVINSKY_MBID);
}

test("Cyrillic MusicBrainz name plus English alias renders Igor Stravinsky folder", () => {
  seedStravinskyAlias();
  const folder = naming.resolveArtistFolder(STRAVINSKY_CYRILLIC, STRAVINSKY_MBID);
  assert.equal(folder, `Igor Stravinsky {mbid-${STRAVINSKY_MBID}}`);
  const trackArtist = naming.renderFileStem("{Track ArtistName}", {
    artistName: STRAVINSKY_CYRILLIC,
    artistMbId: STRAVINSKY_MBID,
    trackArtistName: STRAVINSKY_CYRILLIC,
    trackArtistMbId: STRAVINSKY_MBID,
    trackTitle: "Firebird",
  });
  assert.equal(trackArtist, "Igor Stravinsky");
});

test("existing old-name folder of the same MBID is reused, not duplicated", () => {
  seedStravinskyAlias();
  const musicRoot = configModule.Config.getMusicPath();
  const oldFolder = `Igor Stravinsky {mbid-${STRAVINSKY_MBID}}`;
  fs.mkdirSync(path.join(musicRoot, oldFolder), { recursive: true });
  fs.writeFileSync(path.join(musicRoot, oldFolder, "keep.txt"), "x");

  const imported = artistPaths.resolveArtistFolderForImport({
    artistName: STRAVINSKY_CYRILLIC,
    artistMbId: STRAVINSKY_MBID,
  }, musicRoot);
  assert.equal(imported, oldFolder);

  const expected = artistPaths.resolveArtistFolderForExpectedPath({
    artistName: STRAVINSKY_CYRILLIC,
    artistMbId: STRAVINSKY_MBID,
    existingPath: `Игорь Фёдорович Стравинский {mbid-${STRAVINSKY_MBID}}`,
  });
  assert.equal(expected, oldFolder);
  assert.equal(fs.existsSync(path.join(musicRoot, `Игорь Фёдорович Стравинский {mbid-${STRAVINSKY_MBID}}`)), false);
});

test("Firebird title that was 276 bytes is capped to 255, keeping track prefix and extension", () => {
  const uncapped = `108 - ${FIREBIRD_TITLE}.flac`;
  assert.equal(Buffer.byteLength(uncapped, "utf8"), 276);

  const relative = naming.renderRelativePath("{track:00} - {Track Title}", {
    artistName: "Igor Stravinsky",
    trackTitle: FIREBIRD_TITLE,
    trackNumber: 108,
  });
  const fileName = naming.joinCappedFileName(relative, ".flac");
  assert.ok(Buffer.byteLength(fileName, "utf8") <= naming.MAX_PATH_COMPONENT_BYTES);
  assert.ok(fileName.startsWith("108 - "));
  assert.ok(fileName.endsWith(".flac"));
  assert.equal(fileName, naming.joinCappedFileName(fileName.replace(/\.flac$/, ""), ".flac"));

  const truncated = naming.truncateUtf8Bytes("éééé", 5);
  assert.equal(Buffer.byteLength(truncated, "utf8") <= 5, true);
  assert.equal(truncated.includes("\uFFFD"), false);
  assert.ok(["éé", "ééé"].includes(truncated));
});

test("album folder {mbid-…} suffix is kept when the title is truncated", () => {
  const editionMbid = "a1a8c886-df06-44ec-b851-f76156a086cf";
  const longTitle = "A".repeat(300);
  const folder = naming.renderRelativePath("{Edition Title} ({Release Year}) {mbid-{Edition MbId}}", {
    artistName: "Igor Stravinsky",
    editionTitle: longTitle,
    releaseYear: "2022",
    editionMbId: editionMbid,
  });
  assert.ok(Buffer.byteLength(folder, "utf8") <= 255);
  assert.ok(folder.endsWith(`{mbid-${editionMbid}}`));
});

test("Shostakovich: an existing Latin folder is kept while the artist's aliases were never synced", () => {
  const mbid = "519dd32e-8f30-4380-8826-7aa99169e1bb";
  const stored = `Shostakovich {mbid-${mbid}}`;
  const expected = artistPaths.resolveArtistFolderForExpectedPath({
    artistName: "Дмитрий Дмитриевич Шостакович",
    artistMbId: mbid,
    existingPath: stored,
  });
  assert.equal(expected, stored);
});
