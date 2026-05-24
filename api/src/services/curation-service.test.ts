import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import type { FilteringConfig } from "./config.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-curation-service-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../database.js");
let configModule: typeof import("./config.js");
let curationServiceModule: typeof import("./curation-service.js");
let albumQueryServiceModule: typeof import("./album-query-service.js");

function writeTestConfig(overrides?: {
  includeCompilation?: boolean;
  includeSingle?: boolean;
  includeEp?: boolean;
  includeAlbum?: boolean;
  filtering?: Partial<FilteringConfig>;
}) {
  const config = configModule.readConfig();
  config.filtering = {
    ...config.filtering,
    include_compilation: overrides?.includeCompilation !== false,
    include_single: overrides?.includeSingle !== false,
    include_ep: overrides?.includeEp !== false,
    include_album: overrides?.includeAlbum !== false,
    include_spatial: false,
    require_provider_availability: false,
    include_videos: false,
    ...(overrides?.filtering || {}),
  };
  configModule.writeConfig(config);
}

before(async () => {
  dbModule = await import("../database.js");
  dbModule.initDatabase();

  configModule = await import("./config.js");
  curationServiceModule = await import("./curation-service.js");
  albumQueryServiceModule = await import("./album-query-service.js");

  writeTestConfig();
});

beforeEach(() => {
  const { db } = dbModule;
  db.prepare("DELETE FROM ReleaseGroupSlots").run();
  db.prepare("DELETE FROM ProviderAlbums").run();
  db.prepare("DELETE FROM AlbumReleases").run();
  db.prepare("DELETE FROM Tracks").run();
  db.prepare("DELETE FROM Recordings").run();
  db.prepare("DELETE FROM Albums").run();
  db.prepare("DELETE FROM ArtistMetadata").run();
  db.prepare("DELETE FROM ProviderMediaArtists").run();
  db.prepare("DELETE FROM ProviderAlbumArtists").run();
  db.prepare("DELETE FROM TrackFiles").run();
  db.prepare("DELETE FROM ProviderMedia").run();
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

test("CurationService applies MusicBrainz primary and secondary release-group filters", async () => {
  const { db } = dbModule;

  writeTestConfig({
    filtering: {
      include_album: true,
      include_ep: true,
      include_single: false,
      include_broadcast: false,
      include_live: false,
      include_spokenword: false,
      include_other: false,
      include_demo: false,
    },
  });

  db.prepare(`
    INSERT INTO Artists (id, name, mbid, monitor)
    VALUES (?, ?, ?, ?)
  `).run("artist-1", "Queen", "artist-mbid-1", 1);

  db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name)
    VALUES (?, ?)
  `).run("artist-mbid-1", "Queen");

  const insertReleaseGroup = db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type, secondary_types)
    VALUES (?, ?, ?, ?, ?)
  `);
  insertReleaseGroup.run("rg-album", "artist-mbid-1", "A Night at the Opera", "Album", "[]");
  insertReleaseGroup.run("rg-ep", "artist-mbid-1", "Queen's First EP", "EP", "[]");
  insertReleaseGroup.run("rg-live", "artist-mbid-1", "Live Killers", "Album", JSON.stringify(["Live"]));
  insertReleaseGroup.run("rg-broadcast", "artist-mbid-1", "BBC Session", "Broadcast", "[]");
  insertReleaseGroup.run("rg-spokenword", "artist-mbid-1", "Interview", "Album", JSON.stringify(["Spokenword"]));

  await curationServiceModule.CurationService.processAll("artist-1");

  const wantedByReleaseGroup = new Map(
    (db.prepare(`
      SELECT release_group_mbid, wanted
      FROM ReleaseGroupSlots
      ORDER BY release_group_mbid
    `).all() as Array<{ release_group_mbid: string; wanted: number }>)
      .map((row) => [row.release_group_mbid, row.wanted])
  );

  assert.equal(wantedByReleaseGroup.get("rg-album"), 1);
  assert.equal(wantedByReleaseGroup.get("rg-ep"), 1);
  assert.equal(wantedByReleaseGroup.get("rg-live"), 0);
  assert.equal(wantedByReleaseGroup.get("rg-broadcast"), 0);
  assert.equal(wantedByReleaseGroup.get("rg-spokenword"), 0);

  writeTestConfig({
    filtering: {
      include_album: true,
      include_ep: true,
      include_live: true,
      include_broadcast: true,
      include_spokenword: false,
    },
  });

  await curationServiceModule.CurationService.processAll("artist-1");

  const updatedWantedByReleaseGroup = new Map(
    (db.prepare(`
      SELECT release_group_mbid, wanted
      FROM ReleaseGroupSlots
      ORDER BY release_group_mbid
    `).all() as Array<{ release_group_mbid: string; wanted: number }>)
      .map((row) => [row.release_group_mbid, row.wanted])
  );

  assert.equal(updatedWantedByReleaseGroup.get("rg-live"), 1);
  assert.equal(updatedWantedByReleaseGroup.get("rg-broadcast"), 1);
  assert.equal(updatedWantedByReleaseGroup.get("rg-spokenword"), 0);
});

test("Album read model does not inherit release-group wanted state from artist monitoring", () => {
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
  `).run("rg-mbid-1", "artist-mbid-1", "A Night at the Opera", "Album");

  const result = albumQueryServiceModule.AlbumQueryService.listAlbums({
    limit: 10,
    offset: 0,
  });

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].is_monitored, false);
  assert.equal(result.items[0].monitor, 0);
});

test("Album track read model follows release-group wanted state", async () => {
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
  `).run("rg-mbid-1", "artist-mbid-1", "A Night at the Opera", "Album");

  db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, status, date, media_count, track_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("release-mbid-1", "rg-mbid-1", "artist-mbid-1", "A Night at the Opera", "Official", "1975-11-21", 1, 1);

  db.prepare(`
    INSERT INTO Recordings (mbid, title)
    VALUES (?, ?)
  `).run("recording-mbid-1", "Bohemian Rhapsody");

  db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, medium_position, position, number, title, length_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("track-mbid-1", "release-mbid-1", "recording-mbid-1", 1, 1, "1", "Bohemian Rhapsody", 354000);

  const unmonitoredTracks = await albumQueryServiceModule.AlbumQueryService.getAlbumTracks("rg-mbid-1");
  assert.equal(unmonitoredTracks[0].is_monitored, false);
  assert.equal(unmonitoredTracks[0].monitor, 0);

  db.prepare(`
    INSERT INTO ReleaseGroupSlots (artist_mbid, release_group_mbid, slot, wanted, match_status)
    VALUES (?, ?, ?, ?, ?)
  `).run("artist-mbid-1", "rg-mbid-1", "stereo", 1, "unmatched");

  const monitoredTracks = await albumQueryServiceModule.AlbumQueryService.getAlbumTracks("rg-mbid-1");
  assert.equal(monitoredTracks[0].is_monitored, true);
  assert.equal(monitoredTracks[0].monitor, 1);
});

test("Album versions are MusicBrainz releases from the release group", async () => {
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
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type, first_release_date)
    VALUES (?, ?, ?, ?, ?)
  `).run("rg-mbid-1", "artist-mbid-1", "A Night at the Opera", "Album", "1975-11-21");

  db.prepare(`
    INSERT INTO AlbumReleases (
      mbid, release_group_mbid, artist_mbid, title, status, country, date, media_count, track_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("release-mbid-1", "rg-mbid-1", "artist-mbid-1", "A Night at the Opera", "Official", "GB", "1975-11-21", 1, 12);

  db.prepare(`
    INSERT INTO AlbumReleases (
      mbid, release_group_mbid, artist_mbid, title, status, country, date, media_count, track_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("release-mbid-2", "rg-mbid-1", "artist-mbid-1", "A Night at the Opera", "Official", JSON.stringify(["[Worldwide]"]), "1975-12-02", 1, 12);

  const versions = await albumQueryServiceModule.AlbumQueryService.getAlbumVersions("rg-mbid-1");

  assert.deepEqual(versions.map((version) => version.id), ["release-mbid-2", "release-mbid-1"]);
  assert.equal(versions[0].title, "A Night at the Opera");
  assert.match(versions[0].version || "", /Official/);
  assert.match(versions[0].version || "", /Worldwide/);
});

test("CurationService marks Single redundant if contained in an EP", async () => {
  const { db } = dbModule;

  // Insert artist
  db.prepare(`
    INSERT INTO Artists (id, name, mbid, monitor)
    VALUES (?, ?, ?, ?)
  `).run("artist-1", "Bastille", "artist-mbid-bastille", 1);

  // Insert mb_artist
  db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name)
    VALUES (?, ?)
  `).run("artist-mbid-bastille", "Bastille");

  // Insert release groups: EP and Single
  const insertReleaseGroup = db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type)
    VALUES (?, ?, ?, ?)
  `);
  insertReleaseGroup.run("rg-ep", "artist-mbid-bastille", "& EP", "EP");
  insertReleaseGroup.run("rg-single", "artist-mbid-bastille", "And?", "Single");

  // Insert AlbumReleases for EP
  db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, status, date, media_count, track_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("release-ep", "rg-ep", "artist-mbid-bastille", "& EP", "Official", "2024-01-01", 1, 2);

  // Insert AlbumReleases for Single
  db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, status, date, media_count, track_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("release-single", "rg-single", "artist-mbid-bastille", "And?", "Official", "2024-01-01", 1, 1);

  // Insert Recordings
  const insertRecording = db.prepare(`
    INSERT INTO Recordings (mbid, title)
    VALUES (?, ?)
  `);
  insertRecording.run("rec-1", "And?");
  insertRecording.run("rec-2", "Other Track");

  // Insert Tracks for EP (contains rec-1 and rec-2)
  const insertTrack = db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, medium_position, position, number, title, length_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertTrack.run("track-ep-1", "release-ep", "rec-1", 1, 1, "1", "And?", 200000);
  insertTrack.run("track-ep-2", "release-ep", "rec-2", 1, 2, "2", "Other Track", 200000);

  // Insert Track for Single (contains rec-1)
  insertTrack.run("track-single-1", "release-single", "rec-1", 1, 1, "1", "And?", 200000);

  // Configure filtering to include both EPs and Singles
  writeTestConfig({
    filtering: {
      include_album: true,
      include_ep: true,
      include_single: true,
    },
  });

  // Run curation
  await curationServiceModule.CurationService.processAll("artist-1");

  // Verify wanted status
  const epSlot = db.prepare("SELECT wanted FROM ReleaseGroupSlots WHERE release_group_mbid = ?").get("rg-ep") as any;
  const singleSlot = db.prepare("SELECT wanted FROM ReleaseGroupSlots WHERE release_group_mbid = ?").get("rg-single") as any;

  assert.equal(epSlot.wanted, 1);
  assert.equal(singleSlot.wanted, 0); // Single should be redundant because rec-1 is in the EP!
});

test("CurationService marks Album redundant if contained in a Compilation", async () => {
  const { db } = dbModule;

  // Insert artist
  db.prepare(`
    INSERT INTO Artists (id, name, mbid, monitor)
    VALUES (?, ?, ?, ?)
  `).run("artist-1", "Bastille", "artist-mbid-bastille", 1);

  // Insert mb_artist
  db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name)
    VALUES (?, ?)
  `).run("artist-mbid-bastille", "Bastille");

  // Insert release groups: Compilation and Album
  const insertReleaseGroup = db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type)
    VALUES (?, ?, ?, ?)
  `);
  insertReleaseGroup.run("rg-compilation", "artist-mbid-bastille", "All the Hits", "Compilation");
  insertReleaseGroup.run("rg-album", "artist-mbid-bastille", "Bad Blood", "Album");

  // Insert AlbumReleases for Compilation
  db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, status, date, media_count, track_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("release-compilation", "rg-compilation", "artist-mbid-bastille", "All the Hits", "Official", "2024-01-01", 1, 3);

  // Insert AlbumReleases for Album
  db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, status, date, media_count, track_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("release-album", "rg-album", "artist-mbid-bastille", "Bad Blood", "Official", "2024-01-01", 1, 2);

  // Insert Recordings
  const insertRecording = db.prepare(`
    INSERT INTO Recordings (mbid, title)
    VALUES (?, ?)
  `);
  insertRecording.run("rec-1", "Pompeii");
  insertRecording.run("rec-2", "Things We Lost in the Fire");
  insertRecording.run("rec-3", "Flaws");

  // Insert Tracks for Compilation (contains Pompeii, Things We Lost, and Flaws)
  const insertTrack = db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, medium_position, position, number, title, length_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertTrack.run("track-comp-1", "release-compilation", "rec-1", 1, 1, "1", "Pompeii", 200000);
  insertTrack.run("track-comp-2", "release-compilation", "rec-2", 1, 2, "2", "Things We Lost in the Fire", 200000);
  insertTrack.run("track-comp-3", "release-compilation", "rec-3", 1, 3, "3", "Flaws", 200000);

  // Insert Tracks for Album (contains Pompeii and Things We Lost)
  insertTrack.run("track-alb-1", "release-album", "rec-1", 1, 1, "1", "Pompeii", 200000);
  insertTrack.run("track-alb-2", "release-album", "rec-2", 1, 2, "2", "Things We Lost in the Fire", 200000);

  // Configure filtering to include both Album and Compilation
  writeTestConfig({
    filtering: {
      include_album: true,
      include_compilation: true,
      include_single: false,
      include_ep: false,
    },
  });

  // Run curation
  await curationServiceModule.CurationService.processAll("artist-1");

  // Verify wanted status
  const compSlot = db.prepare("SELECT wanted FROM ReleaseGroupSlots WHERE release_group_mbid = ?").get("rg-compilation") as any;
  const albumSlot = db.prepare("SELECT wanted FROM ReleaseGroupSlots WHERE release_group_mbid = ?").get("rg-album") as any;

  assert.equal(compSlot.wanted, 1);
  assert.equal(albumSlot.wanted, 0); // Album should be redundant because its tracks are in the Compilation!
});

test("CurationService uses fallback release when preferred release has no tracks cached", async () => {
  const { db } = dbModule;

  // Insert artist
  db.prepare(`
    INSERT INTO Artists (id, name, mbid, monitor)
    VALUES (?, ?, ?, ?)
  `).run("artist-1", "Bastille", "artist-mbid-bastille", 1);

  // Insert mb_artist
  db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name)
    VALUES (?, ?)
  `).run("artist-mbid-bastille", "Bastille");

  // Insert release groups: EP and Single
  const insertReleaseGroup = db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type)
    VALUES (?, ?, ?, ?)
  `);
  insertReleaseGroup.run("rg-ep", "artist-mbid-bastille", "& EP", "EP");
  insertReleaseGroup.run("rg-single", "artist-mbid-bastille", "And?", "Single");

  // Insert AlbumReleases for EP (preferred is release-ep-preferred, but fallback is release-ep-fallback)
  // preferred release (status = Official, date is NULL)
  db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, status, date, media_count, track_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("release-ep-preferred", "rg-ep", "artist-mbid-bastille", "& EP (Preferred)", "Official", null, 1, 2);

  // fallback release (status = Official, date is NOT NULL, has tracks)
  db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, status, date, media_count, track_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("release-ep-fallback", "rg-ep", "artist-mbid-bastille", "& EP (Fallback)", "Official", "2024-01-01", 1, 2);

  // Insert AlbumReleases for Single
  db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, status, date, media_count, track_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("release-single", "rg-single", "artist-mbid-bastille", "And?", "Official", "2024-01-01", 1, 1);

  // Insert Recordings
  const insertRecording = db.prepare(`
    INSERT INTO Recordings (mbid, title)
    VALUES (?, ?)
  `);
  insertRecording.run("rec-1", "And?");
  insertRecording.run("rec-2", "Other Track");

  // Insert Tracks only for the fallback release of EP, none for the preferred release!
  const insertTrack = db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, medium_position, position, number, title, length_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertTrack.run("track-ep-1", "release-ep-fallback", "rec-1", 1, 1, "1", "And?", 200000);
  insertTrack.run("track-ep-2", "release-ep-fallback", "rec-2", 1, 2, "2", "Other Track", 200000);

  // Insert Track for Single
  insertTrack.run("track-single-1", "release-single", "rec-1", 1, 1, "1", "And?", 200000);

  // Configure filtering to include both EPs and Singles
  writeTestConfig({
    filtering: {
      include_album: true,
      include_ep: true,
      include_single: true,
    },
  });

  // Run curation
  await curationServiceModule.CurationService.processAll("artist-1");

  // Verify wanted status: the Single should still be marked redundant because the EP
  // containment check fell back to the fallback release's tracks!
  const epSlot = db.prepare("SELECT wanted FROM ReleaseGroupSlots WHERE release_group_mbid = ?").get("rg-ep") as any;
  const singleSlot = db.prepare("SELECT wanted FROM ReleaseGroupSlots WHERE release_group_mbid = ?").get("rg-single") as any;

  assert.equal(epSlot.wanted, 1);
  assert.equal(singleSlot.wanted, 0); // Single should be redundant because rec-1 is in the EP fallback release!
});

test("CurationService respects require_provider_availability filter", async () => {
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

  // Insert two release groups: rg-1 (available) and rg-2 (unavailable)
  db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type)
    VALUES (?, ?, ?, ?)
  `).run("rg-1", "artist-mbid-1", "A Night at the Opera", "album");

  db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type)
    VALUES (?, ?, ?, ?)
  `).run("rg-2", "artist-mbid-1", "News of the World", "album");

  // Insert ReleaseGroupSlots manually
  // rg-1 has a provider matched
  db.prepare(`
    INSERT INTO ReleaseGroupSlots (
      artist_mbid, release_group_mbid, slot, wanted, match_status, selected_provider, selected_provider_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run("artist-mbid-1", "rg-1", "stereo", 0, "matched", "tidal", "album-prov-1");

  // rg-2 is unmatched (no provider)
  db.prepare(`
    INSERT INTO ReleaseGroupSlots (
      artist_mbid, release_group_mbid, slot, wanted, match_status
    ) VALUES (?, ?, ?, ?, ?)
  `).run("artist-mbid-1", "rg-2", "stereo", 0, "unmatched");

  // Configure filtering with require_provider_availability = true
  writeTestConfig({
    filtering: {
      include_album: true,
      require_provider_availability: true,
    },
  });

  // Run curation
  await curationServiceModule.CurationService.processAll("artist-1");

  // Verify wanted status
  const slot1 = db.prepare("SELECT wanted FROM ReleaseGroupSlots WHERE release_group_mbid = ?").get("rg-1") as any;
  const slot2 = db.prepare("SELECT wanted FROM ReleaseGroupSlots WHERE release_group_mbid = ?").get("rg-2") as any;

  assert.equal(slot1.wanted, 1); // Matched slot should be wanted
  assert.equal(slot2.wanted, 0); // Unmatched slot should NOT be wanted
});

test("CurationService marks Single redundant if contained in an EP by track title matching even if recording MBIDs differ", async () => {
  const { db } = dbModule;

  // Insert artist
  db.prepare(`
    INSERT INTO Artists (id, name, mbid, monitor)
    VALUES (?, ?, ?, ?)
  `).run("artist-1", "Bastille", "artist-mbid-bastille", 1);

  // Insert mb_artist
  db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name)
    VALUES (?, ?)
  `).run("artist-mbid-bastille", "Bastille");

  // Insert release groups: EP and Single
  const insertReleaseGroup = db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type)
    VALUES (?, ?, ?, ?)
  `);
  insertReleaseGroup.run("rg-ep", "artist-mbid-bastille", "& EP", "EP");
  insertReleaseGroup.run("rg-single", "artist-mbid-bastille", "And?", "Single");

  // Insert AlbumReleases for EP
  db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, status, date, media_count, track_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("release-ep", "rg-ep", "artist-mbid-bastille", "& EP", "Official", "2024-01-01", 1, 2);

  // Insert AlbumReleases for Single
  db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, status, date, media_count, track_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("release-single", "rg-single", "artist-mbid-bastille", "And?", "Official", "2024-01-01", 1, 1);

  // Insert Recordings
  const insertRecording = db.prepare(`
    INSERT INTO Recordings (mbid, title)
    VALUES (?, ?)
  `);
  insertRecording.run("rec-ep-1", "And?");
  insertRecording.run("rec-ep-2", "Other Track");
  insertRecording.run("rec-single-1", "And?");

  // Insert Tracks for EP
  const insertTrack = db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, medium_position, position, number, title, length_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertTrack.run("track-ep-1", "release-ep", "rec-ep-1", 1, 1, "1", "And?", 200000);
  insertTrack.run("track-ep-2", "release-ep", "rec-ep-2", 1, 2, "2", "Other Track", 200000);

  // Insert Track for Single with different recording MBID
  insertTrack.run("track-single-1", "release-single", "rec-single-1", 1, 1, "1", "And?", 200000);

  // Configure filtering to include both EPs and Singles
  writeTestConfig({
    filtering: {
      include_album: true,
      include_ep: true,
      include_single: true,
    },
  });

  // Run curation
  await curationServiceModule.CurationService.processAll("artist-1");

  // Verify wanted status
  const epSlot = db.prepare("SELECT wanted FROM ReleaseGroupSlots WHERE release_group_mbid = ?").get("rg-ep") as any;
  const singleSlot = db.prepare("SELECT wanted FROM ReleaseGroupSlots WHERE release_group_mbid = ?").get("rg-single") as any;

  assert.equal(epSlot.wanted, 1);
  assert.equal(singleSlot.wanted, 0); // Single should be redundant because the track title matches!
});

test("CurationService does not mark Single redundant if contained in an Album by track title matching with edit suffix when recording IDs differ", async () => {
  const { db } = dbModule;

  // Insert artist
  db.prepare(`
    INSERT INTO Artists (id, name, mbid, monitor)
    VALUES (?, ?, ?, ?)
  `).run("artist-1", "Bastille", "artist-mbid-bastille-edit", 1);

  // Insert mb_artist
  db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name)
    VALUES (?, ?)
  `).run("artist-mbid-bastille-edit", "Bastille");

  // Insert Album and Single Release Groups
  const insertReleaseGroup = db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type)
    VALUES (?, ?, ?, ?)
  `);
  insertReleaseGroup.run("rg-album-edit", "artist-mbid-bastille-edit", "MTV Unplugged", "album");
  insertReleaseGroup.run("rg-single-edit", "artist-mbid-bastille-edit", "Killing Me Softly", "single");

  // Insert Album and Single Releases
  const insertRelease = db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, status, date, track_count, media_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertRelease.run("release-album-edit", "rg-album-edit", "artist-mbid-bastille-edit", "MTV Unplugged", "Official", "2024-01-01", 2, 1);
  insertRelease.run("release-single-edit", "rg-single-edit", "artist-mbid-bastille-edit", "Killing Me Softly", "Official", "2024-01-01", 1, 1);

  // Insert Recordings
  const insertRecording = db.prepare(`
    INSERT INTO Recordings (mbid, title)
    VALUES (?, ?)
  `);
  insertRecording.run("rec-album-edit-1", "Killing Me Softly With His Song");
  insertRecording.run("rec-album-edit-2", "Other Track");
  insertRecording.run("rec-single-edit-1", "Killing Me Softly With His Song (edit)");

  // Insert Tracks for Album
  const insertTrack = db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, medium_position, position, number, title, length_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertTrack.run("track-album-edit-1", "release-album-edit", "rec-album-edit-1", 1, 1, "1", "Killing Me Softly With His Song", 200000);
  insertTrack.run("track-album-edit-2", "release-album-edit", "rec-album-edit-2", 1, 2, "2", "Other Track", 200000);

  // Insert Track for Single with different recording MBID and (edit) suffix
  insertTrack.run("track-single-edit-1", "release-single-edit", "rec-single-edit-1", 1, 1, "1", "Killing Me Softly With His Song (edit)", 200000);

  // Configure filtering to include both Albums and Singles
  writeTestConfig({
    filtering: {
      include_album: true,
      include_ep: true,
      include_single: true,
    },
  });

  // Run curation
  await curationServiceModule.CurationService.processAll("artist-1");

  // Verify wanted status
  const albumSlot = db.prepare("SELECT wanted FROM ReleaseGroupSlots WHERE release_group_mbid = ?").get("rg-album-edit") as any;
  const singleSlot = db.prepare("SELECT wanted FROM ReleaseGroupSlots WHERE release_group_mbid = ?").get("rg-single-edit") as any;

  assert.equal(albumSlot.wanted, 1);
  assert.equal(singleSlot.wanted, 1); // Single should not be redundant because different edit versions are treated as distinct recordings when recording IDs/ISRCs differ!
});
