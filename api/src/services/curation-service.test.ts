import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-curation-service-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../database.js");
let configModule: typeof import("./config.js");
let curationServiceModule: typeof import("./curation-service.js");

function writeTestConfig(overrides?: {
  includeCompilation?: boolean;
  includeSingle?: boolean;
  includeEp?: boolean;
  includeAlbum?: boolean;
}) {
  const config = configModule.readConfig();
  config.filtering = {
    ...config.filtering,
    include_compilation: overrides?.includeCompilation !== false,
    include_single: overrides?.includeSingle !== false,
    include_ep: overrides?.includeEp !== false,
    include_album: overrides?.includeAlbum !== false,
    include_spatial: false,
    require_provider_availability: true,
    include_videos: false,
  };
  configModule.writeConfig(config);
}

before(async () => {
  dbModule = await import("../database.js");
  dbModule.initDatabase();

  configModule = await import("./config.js");
  curationServiceModule = await import("./curation-service.js");

  writeTestConfig();
});

beforeEach(() => {
  const { db } = dbModule;
  db.prepare("DELETE FROM ReleaseGroupSlots").run();
  db.prepare("DELETE FROM ProviderAlbums").run();
  db.prepare("DELETE FROM AlbumReleases").run();
  db.prepare("DELETE FROM Tracks").run();
  db.prepare("DELETE FROM ArtistMetadata").run();
  db.prepare("DELETE FROM ProviderMediaArtists").run();
  db.prepare("DELETE FROM ProviderAlbumArtists").run();
  db.prepare("DELETE FROM TrackFiles").run();
  db.prepare("DELETE FROM ProviderMedia").run();
  db.prepare("DELETE FROM ProviderAlbums").run();
  db.prepare("DELETE FROM Artists").run();

  writeTestConfig();
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("CurationService synchronizes albums and tracks monitor status", async () => {
  const { db } = dbModule;

  // Insert artist
  db.prepare(`
    INSERT INTO Artists (id, name, mbid, monitor)
    VALUES (?, ?, ?, ?)
  `).run("artist-1", "Queen", "artist-mbid-1", 1);

  // Insert mb_artist
  db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name)
    VALUES (?, ?)
  `).run("artist-mbid-1", "Queen");

  // Insert release group
  db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type)
    VALUES (?, ?, ?, ?)
  `).run("rg-mbid-1", "artist-mbid-1", "A Night at the Opera", "album");

  // Insert album (provider side)
  db.prepare(`
    INSERT INTO ProviderAlbums (
      id, artist_id, title, type, explicit, quality,
      num_tracks, num_volumes, num_videos, duration, monitor, monitor_lock
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("album-prov-1", "artist-1", "A Night at the Opera", "ALBUM", 0, "LOSSLESS", 1, 1, 0, 3551, 0, 0);

  // Insert track (provider side)
  db.prepare(`
    INSERT INTO ProviderMedia (
      id, artist_id, album_id, title, track_number, volume_number,
      explicit, type, quality, duration, monitor, monitor_lock
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("track-prov-1", "artist-1", "album-prov-1", "Bohemian Rhapsody", 1, 1, 0, "Track", "LOSSLESS", 354, 0, 0);

  db.prepare(`
    INSERT INTO ProviderMedia (
      id, artist_id, album_id, title, explicit, type, quality, duration, monitor, monitor_lock
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("video-prov-1", "artist-1", null, "Bohemian Rhapsody", 0, "Music Video", "LOSSLESS", 354, 1, 0);

  // Insert slot manually as wanted = 0, pointing to the album
  db.prepare(`
    INSERT INTO ReleaseGroupSlots (
      artist_mbid, release_group_mbid, slot, wanted, selected_provider, selected_provider_id, match_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run("artist-mbid-1", "rg-mbid-1", "stereo", 0, "tidal", "album-prov-1", "matched");

  // Run curation with the local artist ID used by queued curation jobs.
  await curationServiceModule.CurationService.processAll("artist-1");

  // Verify that wanted became 1 and album/media monitor status became 1
  const slot = db.prepare("SELECT wanted FROM ReleaseGroupSlots WHERE release_group_mbid = ?").get("rg-mbid-1") as any;
  assert.equal(slot.wanted, 1);

  const album = db.prepare("SELECT monitor FROM ProviderAlbums WHERE id = ?").get("album-prov-1") as any;
  assert.equal(album.monitor, 1);

  const media = db.prepare("SELECT monitor FROM ProviderMedia WHERE id = ?").get("track-prov-1") as any;
  assert.equal(media.monitor, 1);

  const video = db.prepare("SELECT monitor FROM ProviderMedia WHERE id = ?").get("video-prov-1") as any;
  assert.equal(video.monitor, 0);
});

test("CurationService unmonitors album and track when slot becomes unwanted", async () => {
  const { db } = dbModule;

  // Insert artist
  db.prepare(`
    INSERT INTO Artists (id, name, mbid, monitor)
    VALUES (?, ?, ?, ?)
  `).run("artist-1", "Queen", "artist-mbid-1", 1);

  // Insert mb_artist
  db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name)
    VALUES (?, ?)
  `).run("artist-mbid-1", "Queen");

  // Insert release group
  db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type)
    VALUES (?, ?, ?, ?)
  `).run("rg-mbid-1", "artist-mbid-1", "A Night at the Opera", "album");

  // Insert album (provider side)
  db.prepare(`
    INSERT INTO ProviderAlbums (
      id, artist_id, title, type, explicit, quality,
      num_tracks, num_volumes, num_videos, duration, monitor, monitor_lock
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("album-prov-1", "artist-1", "A Night at the Opera", "ALBUM", 0, "LOSSLESS", 1, 1, 0, 3551, 1, 0);

  // Insert track (provider side)
  db.prepare(`
    INSERT INTO ProviderMedia (
      id, artist_id, album_id, title, track_number, volume_number,
      explicit, type, quality, duration, monitor, monitor_lock
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("track-prov-1", "artist-1", "album-prov-1", "Bohemian Rhapsody", 1, 1, 0, "Track", "LOSSLESS", 354, 1, 0);

  // Insert slot manually as wanted = 1, pointing to the album
  db.prepare(`
    INSERT INTO ReleaseGroupSlots (
      artist_mbid, release_group_mbid, slot, wanted, selected_provider, selected_provider_id, match_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run("artist-mbid-1", "rg-mbid-1", "stereo", 1, "tidal", "album-prov-1", "matched");

  // Change configuration to filter out albums
  writeTestConfig({ includeAlbum: false });

  // Run curation with the local artist ID used by queued curation jobs.
  await curationServiceModule.CurationService.processAll("artist-1");

  // Verify that wanted became 0 and album/media monitor status became 0
  const slot = db.prepare("SELECT wanted FROM ReleaseGroupSlots WHERE release_group_mbid = ?").get("rg-mbid-1") as any;
  assert.equal(slot.wanted, 0);

  const album = db.prepare("SELECT monitor FROM ProviderAlbums WHERE id = ?").get("album-prov-1") as any;
  assert.equal(album.monitor, 0);

  const media = db.prepare("SELECT monitor FROM ProviderMedia WHERE id = ?").get("track-prov-1") as any;
  assert.equal(media.monitor, 0);
});

test("CurationService respects monitor_lock when synchronizing monitor status", async () => {
  const { db } = dbModule;

  // Insert artist
  db.prepare(`
    INSERT INTO Artists (id, name, mbid, monitor)
    VALUES (?, ?, ?, ?)
  `).run("artist-1", "Queen", "artist-mbid-1", 1);

  // Insert mb_artist
  db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name)
    VALUES (?, ?)
  `).run("artist-mbid-1", "Queen");

  // Insert release group
  db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type)
    VALUES (?, ?, ?, ?)
  `).run("rg-mbid-1", "artist-mbid-1", "A Night at the Opera", "album");

  // Insert album (provider side, monitor_lock = 1)
  db.prepare(`
    INSERT INTO ProviderAlbums (
      id, artist_id, title, type, explicit, quality,
      num_tracks, num_volumes, num_videos, duration, monitor, monitor_lock
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("album-prov-1", "artist-1", "A Night at the Opera", "ALBUM", 0, "LOSSLESS", 1, 1, 0, 3551, 1, 1);

  // Insert track (provider side, monitor_lock = 1)
  db.prepare(`
    INSERT INTO ProviderMedia (
      id, artist_id, album_id, title, track_number, volume_number,
      explicit, type, quality, duration, monitor, monitor_lock
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("track-prov-1", "artist-1", "album-prov-1", "Bohemian Rhapsody", 1, 1, 0, "Track", "LOSSLESS", 354, 1, 1);

  // Insert slot manually as wanted = 1, pointing to the album
  db.prepare(`
    INSERT INTO ReleaseGroupSlots (
      artist_mbid, release_group_mbid, slot, wanted, selected_provider, selected_provider_id, match_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run("artist-mbid-1", "rg-mbid-1", "stereo", 1, "tidal", "album-prov-1", "matched");

  // Change configuration to filter out albums (slot wanted -> 0)
  writeTestConfig({ includeAlbum: false });

  // Run curation with the local artist ID used by queued curation jobs.
  await curationServiceModule.CurationService.processAll("artist-1");

  // Verify that wanted became 0, but album/media monitor status remained 1 (locked)
  const slot = db.prepare("SELECT wanted FROM ReleaseGroupSlots WHERE release_group_mbid = ?").get("rg-mbid-1") as any;
  assert.equal(slot.wanted, 0);

  const album = db.prepare("SELECT monitor FROM ProviderAlbums WHERE id = ?").get("album-prov-1") as any;
  assert.equal(album.monitor, 1);

  const media = db.prepare("SELECT monitor FROM ProviderMedia WHERE id = ?").get("track-prov-1") as any;
  assert.equal(media.monitor, 1);
});

test("CurationService marks MusicBrainz release-group slots wanted without provider availability", async () => {
  const { db } = dbModule;

  db.prepare(`
    INSERT INTO Artists (id, name, mbid, monitor)
    VALUES (?, ?, ?, ?)
  `).run("artist-1", "Queen", "artist-mbid-1", 1);

  db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name)
    VALUES (?, ?)
  `).run("artist-mbid-1", "Queen");

  db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type)
    VALUES (?, ?, ?, ?)
  `).run("rg-mbid-1", "artist-mbid-1", "A Night at the Opera", "album");

  db.prepare(`
    INSERT INTO ReleaseGroupSlots (
      artist_mbid, release_group_mbid, slot, wanted, match_status
    ) VALUES (?, ?, ?, ?, ?)
  `).run("artist-mbid-1", "rg-mbid-1", "stereo", 0, "unmatched");

  await curationServiceModule.CurationService.processAll("artist-1");

  const slot = db.prepare(`
    SELECT wanted, selected_provider, selected_provider_id
    FROM ReleaseGroupSlots
    WHERE release_group_mbid = ?
  `).get("rg-mbid-1") as any;

  assert.equal(slot.wanted, 1);
  assert.equal(slot.selected_provider, null);
  assert.equal(slot.selected_provider_id, null);
});
