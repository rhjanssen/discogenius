import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { seedCanonicalAlbum } from "../../test-support/normalized-provider-fixtures.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-album-artist-credit-"));
const musicRoot = path.join(tempDir, "stereo");
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;
process.env.MUSIC_PATH = musicRoot;
process.env.SPATIAL_PATH = path.join(tempDir, "spatial");
process.env.VIDEO_PATH = path.join(tempDir, "video");
process.env.DOWNLOAD_PATH = path.join(tempDir, "downloads");

const ARTIST = "artist-golden-earring";
const GROUP = "rg-complete-studio";
const RELEASE = "rel-complete-studio";
const TRACK = "track-radar-love";
const RECORDING = "rec-radar-love";

let dbModule: typeof import("../../database.js");
let tags: typeof import("./audio-tag-service.js");

before(async () => {
  fs.mkdirSync(musicRoot, { recursive: true });
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  tags = await import("./audio-tag-service.js");
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("default album artist is the MusicBrainz artist name, not the release credited-as name", () => {
  const seeded = seedCanonicalAlbum(dbModule.db, {
    artistMbid: ARTIST,
    artistName: "Golden Earring",
    releaseGroupMbid: GROUP,
    releaseMbid: RELEASE,
    title: "The Complete Studio Recordings",
    tracks: [{ trackMbid: TRACK, recordingMbid: RECORDING, title: "Radar Love", position: 1 }],
  });
  dbModule.db.prepare("UPDATE ArtistMetadata SET sort_name = ? WHERE mbid = ?").run("Earring, Golden", ARTIST);
  dbModule.db.prepare("UPDATE Recordings SET artist_credit = ?, credits = ? WHERE mbid = ?").run(
    "The Golden Earrings",
    JSON.stringify([{
      name: "The Golden Earrings",
      artist: { id: ARTIST, name: "Golden Earring" },
      join_phrase: "",
    }]),
    RECORDING,
  );
  const artistId = (dbModule.db.prepare("SELECT id FROM ArtistMetadata WHERE mbid = ?").get(ARTIST) as { id: number }).id;
  dbModule.db.prepare(`
    INSERT INTO ReleaseArtistCredits (edition_id, artist_id, ordinal, credited_name, join_phrase)
    VALUES (?, ?, 0, 'The Golden Earrings', '')
  `).run(seeded.editionId, artistId);

  const library = dbModule.db.prepare("SELECT id, root_path FROM Libraries WHERE name = 'Stereo'").get() as {
    id: number;
    root_path: string;
  };
  const filePath = path.join(musicRoot, "Golden Earring", "The Complete Studio Recordings", "01 Radar Love.flac");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "not-audio");
  const fileId = (dbModule.db.prepare(`
    INSERT INTO TrackFiles (
      artist_metadata_id, library_id, track_id, recording_id,
      canonical_artist_mbid, canonical_release_group_mbid, canonical_release_mbid,
      canonical_track_mbid, canonical_recording_mbid,
      file_path, relative_path, library_root, filename, extension, file_type, library_slot
    ) VALUES (
      ?, ?, (SELECT id FROM Tracks WHERE mbid = ?), (SELECT id FROM Recordings WHERE mbid = ?),
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, 'flac', 'track', 'stereo'
    ) RETURNING id
  `).get(
    artistId,
    library.id,
    TRACK,
    RECORDING,
    ARTIST,
    GROUP,
    RELEASE,
    TRACK,
    RECORDING,
    filePath,
    path.relative(library.root_path, filePath),
    library.root_path,
    path.basename(filePath),
  ) as { id: number }).id;

  const byKey = new Map(
    tags.AudioTagService.buildDesiredTagsForTrackFileIdsForTest([fileId]).map((tag) => [tag.key, tag.targetValue]),
  );
  assert.equal(byKey.get("album_artist"), "Golden Earring");
  assert.equal(byKey.get("album_artist_sort"), "Earring, Golden");
  assert.equal(byKey.get("album_artists"), "The Golden Earrings");
  assert.equal(byKey.get("artist"), "The Golden Earrings");
  assert.equal(byKey.get("musicbrainz_albumartistid"), ARTIST);

  const fullCredit = new Map(
    tags.AudioTagService.buildDesiredTagsForTrackFileIdsForTest([fileId], { full_album_artist_credit: true })
      .map((tag) => [tag.key, tag.targetValue]),
  );
  assert.equal(fullCredit.get("album_artist"), "The Golden Earrings");
  assert.equal(fullCredit.get("album_artist_sort"), "Earring, Golden");
});
