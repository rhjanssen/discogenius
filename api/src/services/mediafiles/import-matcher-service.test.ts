import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import {
  closeActiveSchemaDb,
  openActiveSchemaDb,
  prepareActiveSchemaEnv,
  resetActiveSchemaRows,
} from "../../test-support/active-schema-fixture.js";
import type { LocalGroup } from "./import-types.js";

const { tempDir } = prepareActiveSchemaEnv("import-matcher");
const { db, dbModule } = await openActiveSchemaDb();
const { ImportMatcherService } = await import("./import-matcher-service.js");

after(() => closeActiveSchemaDb(dbModule, tempDir));
beforeEach(() => resetActiveSchemaRows(db));

const ARTIST_MBID = "11111111-1111-4111-8111-111111111111";
const GROUP_MBID = "22222222-2222-4222-8222-222222222222";
const RELEASE_MBID = "33333333-3333-4333-8333-333333333333";
const RECORDING_MBID = "44444444-4444-4444-8444-444444444444";
const TRACK_MBID = "55555555-5555-4555-8555-555555555555";
const VIDEO_MBID = "66666666-6666-4666-8666-666666666666";

function seedCanonicalAlbum() {
  db.prepare("INSERT INTO ArtistMetadata (id, mbid, name) VALUES (1, ?, 'Bastille')").run(ARTIST_MBID);
  db.prepare(`
    INSERT INTO Albums (id, mbid, artist_mbid, title)
    VALUES (1, ?, ?, 'Bad Blood')
  `).run(GROUP_MBID, ARTIST_MBID);
  db.prepare(`
    INSERT INTO AlbumEditions (
      id, mbid, release_group_id, release_group_mbid, artist_mbid, title, track_count
    ) VALUES (1, ?, 1, ?, ?, 'Bad Blood', 1)
  `).run(RELEASE_MBID, GROUP_MBID, ARTIST_MBID);
  db.prepare(`
    INSERT INTO Recordings (id, mbid, title, length_ms)
    VALUES (1, ?, 'Pompeii', 214000)
  `).run(RECORDING_MBID);
  db.prepare(`
    INSERT INTO Tracks (
      id, mbid, album_edition_id, release_mbid, recording_id, recording_mbid,
      medium_position, position, title, length_ms
    ) VALUES (1, ?, 1, ?, 1, ?, 1, 1, 'Pompeii', 214000)
  `).run(TRACK_MBID, RELEASE_MBID, RECORDING_MBID);
}

function audioGroup(): LocalGroup {
  return {
    id: "album-folder",
    path: "C:/Import/Bastille/Bad Blood",
    rootPath: "C:/Import",
    libraryRoot: "music",
    sidecars: [],
    commonTags: { artist: "Bastille", album: "Bad Blood" },
    status: "queued",
    files: [{
      path: "C:/Import/Bastille/Bad Blood/01 Pompeii.flac",
      name: "01 Pompeii.flac",
      size: 100,
      extension: ".flac",
      metadata: {
        common: { artist: "Bastille", album: "Bad Blood", title: "Pompeii" },
        format: { duration: 214 },
        native: {},
        quality: { warnings: [] },
      } as any,
    }],
  };
}

test("album discovery returns canonical release-group and Track identities only", async () => {
  seedCanonicalAlbum();
  const matches = await new ImportMatcherService().findMatchesForGroup(audioGroup(), "music");

  assert.equal(matches.length, 1);
  assert.equal(matches[0].item.id, GROUP_MBID);
  assert.equal(matches[0].itemType, "album");
  assert.equal(matches[0].trackIdsByFilePath?.[audioGroup().files[0].path], TRACK_MBID);
  assert.equal(matches[0].autoImportReady, false);
  assert.match(matches[0].rejections?.[0] || "", /Library and canonical MusicBrainz Edition/);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM ProviderItems").get() as { count: number }).count, 0);
});

test("video discovery returns a canonical Recording and never invents provider identity", async () => {
  db.prepare("INSERT INTO ArtistMetadata (id, mbid, name) VALUES (1, ?, 'Bastille')").run(ARTIST_MBID);
  db.prepare(`
    INSERT INTO Recordings (
      id, mbid, title, artist_metadata_id, artist_mbid, artist_credit,
      length_ms, is_video
    ) VALUES (10, ?, 'Pompeii', 1, ?, 'Bastille', 214000, 1)
  `).run(VIDEO_MBID, ARTIST_MBID);
  const group = audioGroup();
  group.libraryRoot = "videos";
  group.files[0].extension = ".mkv";
  group.files[0].name = "Bastille - Pompeii.mkv";

  const matches = await new ImportMatcherService().findMatchesForGroup(group, "video");

  assert.equal(matches.length, 1);
  assert.equal(matches[0].item.id, VIDEO_MBID);
  assert.equal(matches[0].itemType, "video");
  assert.equal(matches[0].autoImportReady, false);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM ProviderItems").get() as { count: number }).count, 0);
});
