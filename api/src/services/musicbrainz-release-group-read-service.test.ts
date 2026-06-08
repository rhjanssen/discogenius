import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-mb-release-group-read-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../database.js");
let readServiceModule: typeof import("./musicbrainz-release-group-read-service.js");

before(async () => {
  dbModule = await import("../database.js");
  dbModule.initDatabase();
  readServiceModule = await import("./musicbrainz-release-group-read-service.js");
});

beforeEach(() => {
  dbModule.db.prepare("DELETE FROM ProviderItems").run();
  dbModule.db.prepare("DELETE FROM ReleaseGroupSlots").run();
  dbModule.db.prepare("DELETE FROM Tracks").run();
  dbModule.db.prepare("DELETE FROM Recordings").run();
  dbModule.db.prepare("DELETE FROM AlbumReleases").run();
  dbModule.db.prepare("DELETE FROM ArtistReleaseGroups").run();
  dbModule.db.prepare("DELETE FROM Albums").run();
  dbModule.db.prepare("DELETE FROM Artists").run();
  dbModule.db.prepare("DELETE FROM ArtistMetadata").run();
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("album versions expose provider offers for all compatible MusicBrainz releases", async () => {
  const artistMbid = "artist-mbid-bastille";
  const releaseGroupMbid = "release-group-gmtf";
  const standardReleaseMbid = "release-gmtf-standard";
  const deluxeReleaseMbid = "release-gmtf-deluxe";
  const expandedReleaseMbid = "release-gmtf-expanded";

  dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
    .run(artistMbid, "Bastille");
  dbModule.db.prepare("INSERT INTO Artists (id, name, mbid) VALUES (?, ?, ?)")
    .run(artistMbid, "Bastille", artistMbid);
  dbModule.db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type, first_release_date, data)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    releaseGroupMbid,
    artistMbid,
    "Give Me the Future",
    "Album",
    "2022-02-04",
    JSON.stringify({ releases: [] }),
  );
  const insertRelease = dbModule.db.prepare(`
    INSERT INTO AlbumReleases (
      mbid, release_group_mbid, artist_mbid, title, status, country, date, media_count, track_count, disambiguation
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertRelease.run(
    standardReleaseMbid,
    releaseGroupMbid,
    artistMbid,
    "Give Me the Future",
    "Official",
    JSON.stringify(["XW"]),
    "2022-02-04",
    1,
    13,
    "explicit",
  );
  insertRelease.run(
    deluxeReleaseMbid,
    releaseGroupMbid,
    artistMbid,
    "Give Me the Future",
    "Official",
    JSON.stringify(["XW"]),
    "2022-02-07",
    2,
    17,
    "deluxe edition - explicit",
  );
  insertRelease.run(
    expandedReleaseMbid,
    releaseGroupMbid,
    artistMbid,
    "Give Me the Future + Dreams of the Past",
    "Official",
    JSON.stringify(["XW"]),
    "2022-08-26",
    3,
    27,
    "explicit",
  );
  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title, quality, release_date,
      artist_mbid, release_group_mbid, release_mbid, library_slot,
      match_status, match_confidence, match_method, match_evidence, data
    ) VALUES
      ('tidal', 'album', ?, ?, 'HIRES_LOSSLESS', '2022-02-04', ?, ?, NULL, 'stereo', 'verified', 1, 'musicbrainz-release-group-title-year-type-track-count', ?, '{}'),
      ('tidal', 'album', ?, ?, 'HIRES_LOSSLESS', '2022-02-07', ?, ?, NULL, 'stereo', 'probable', 1, 'musicbrainz-release-group-title-year-type-track-count', ?, '{}'),
      ('tidal', 'album', ?, ?, 'HIRES_LOSSLESS', '2022-08-26', ?, ?, NULL, 'stereo', 'verified', 1, 'musicbrainz-release-group-title-year-type-track-count', ?, '{}')
  `).run(
    "tidal-standard",
    "Give Me The Future",
    artistMbid,
    releaseGroupMbid,
    JSON.stringify({ availableReleaseMbids: [standardReleaseMbid] }),
    "tidal-deluxe",
    "Give Me The Future (Deluxe Edition)",
    artistMbid,
    releaseGroupMbid,
    JSON.stringify({ availableReleaseMbids: [deluxeReleaseMbid] }),
    "tidal-expanded",
    "Give Me The Future + Dreams Of The Past",
    artistMbid,
    releaseGroupMbid,
    JSON.stringify({ availableReleaseMbids: [expandedReleaseMbid] }),
  );

  const versions = await readServiceModule.MusicBrainzReleaseGroupReadService.getVersions(releaseGroupMbid);
  const providersByRelease = new Map(versions.map((version) => [version.id, version.stereo_provider_id]));

  assert.equal(providersByRelease.get(standardReleaseMbid), "tidal-standard");
  assert.equal(providersByRelease.get(deluxeReleaseMbid), "tidal-deluxe");
  assert.equal(providersByRelease.get(expandedReleaseMbid), "tidal-expanded");
});
