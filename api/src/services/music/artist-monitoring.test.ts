import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-artist-monitoring-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let monitoringModule: typeof import("./artist-monitoring.js");
let refreshArtistModule: typeof import("./refresh-artist-service.js");

before(async () => {
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  monitoringModule = await import("./artist-monitoring.js");
  refreshArtistModule = await import("./refresh-artist-service.js");
});

beforeEach(() => {
  const { db } = dbModule;
  db.prepare("DELETE FROM job_queue").run();
  db.prepare("DELETE FROM ProviderMedia").run();
  db.prepare("DELETE FROM ProviderAlbums").run();
  db.prepare("DELETE FROM Recordings").run();
  db.prepare("DELETE FROM ReleaseGroupSlots").run();
  db.prepare("DELETE FROM ArtistReleaseGroups").run();
  db.prepare("DELETE FROM Albums").run();
  db.prepare("DELETE FROM Artists").run();
  db.prepare("DELETE FROM ArtistMetadata").run();
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("monitoring a named MusicBrainz search result hydrates display metadata before queuing intake", async () => {
  const artistMbid = "b53cab0a-f355-41eb-9bce-bf619b6d760e";
  const originalUpsert = refreshArtistModule.RefreshArtistService.upsertMusicBrainzArtist;
  refreshArtistModule.RefreshArtistService.upsertMusicBrainzArtist = (async (mbid: string, options = {}) => {
    assert.equal(mbid, artistMbid);
    assert.equal(options.monitorArtist, false);

    dbModule.db.prepare(`
      INSERT INTO ArtistMetadata (mbid, name, images)
      VALUES (?, ?, ?)
    `).run(
      artistMbid,
      "Bastille",
      JSON.stringify([{ coverType: "Poster", url: "https://example.invalid/bastille.jpg" }]),
    );
    dbModule.db.prepare(`
      INSERT INTO Artists (
        id, name, mbid, picture, cover_image_url, musicbrainz_status,
        musicbrainz_match_method, monitored
      )
      VALUES (?, ?, ?, ?, ?, 'verified', 'musicbrainz-metadata', 0)
    `).run(
      artistMbid,
      "Bastille",
      artistMbid,
      "https://example.invalid/bastille.jpg",
      "https://example.invalid/bastille-fanart.jpg",
    );
    return artistMbid;
  }) as typeof refreshArtistModule.RefreshArtistService.upsertMusicBrainzArtist;

  let result: Awaited<ReturnType<typeof monitoringModule.monitorArtistAndQueueIntake>>;
  try {
    result = await monitoringModule.monitorArtistAndQueueIntake({
      artistId: artistMbid,
      artistName: "Bastille",
      priority: 1,
      trigger: 1,
    });
  } finally {
    refreshArtistModule.RefreshArtistService.upsertMusicBrainzArtist = originalUpsert;
  }

  const artist = dbModule.db.prepare(`
    SELECT id, name, mbid, picture, cover_image_url, monitored AS monitor, musicbrainz_status
    FROM Artists
    WHERE id = ?
  `).get(artistMbid) as {
    id: string;
    name: string;
    mbid: string;
    picture: string;
    cover_image_url: string;
    monitor: number;
    musicbrainz_status: string;
  };
  const job = dbModule.db.prepare(`
    SELECT type, ref_id, status
    FROM job_queue
    WHERE id = ?
  `).get(result.jobId) as { type: string; ref_id: string; status: string };

  assert.equal(artist.id, artistMbid);
  assert.equal(artist.name, "Bastille");
  assert.equal(artist.mbid, artistMbid);
  assert.equal(artist.picture, "https://example.invalid/bastille.jpg");
  assert.equal(artist.cover_image_url, "https://example.invalid/bastille-fanart.jpg");
  assert.equal(artist.monitor, 1);
  assert.equal(artist.musicbrainz_status, "verified");
  assert.equal(job.type, "RefreshArtist");
  assert.equal(job.ref_id, artistMbid);
  assert.equal(job.status, "pending");
});

test("unmonitoring an artist clears canonical slots and videos without mutating provider catalog rows", () => {
  const { db } = dbModule;
  const artistMbid = "7808accb-6395-4b25-858c-678bbb73896b";
  const releaseGroupMbid = "bc411157-431c-4f04-81e1-18e1c21d50ec";

  db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name)
    VALUES (?, ?)
  `).run(artistMbid, "Bastille");

  db.prepare(`
    INSERT INTO Artists (id, mbid, name, monitored, monitored_at)
    VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP)
  `).run(artistMbid, artistMbid, "Bastille");

  db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type)
    VALUES (?, ?, ?, ?)
  `).run(releaseGroupMbid, artistMbid, "Give Me the Future", "Album");

  db.prepare(`
    INSERT INTO ReleaseGroupSlots (
      artist_mbid, release_group_mbid, slot, monitored, selected_provider, selected_provider_id, match_status
    )
    VALUES (?, ?, 'stereo', 1, 'tidal', '243864035', 'verified')
  `).run(artistMbid, releaseGroupMbid);

  db.prepare(`
    INSERT INTO Recordings (mbid, artist_mbid, title, is_video, metadata_status, monitored)
    VALUES (?, ?, ?, 1, 'provider_only', 1)
  `).run("video-recording-1", artistMbid, "Bastille Video");

  db.prepare(`
    INSERT INTO ProviderAlbums (
      id, artist_id, title, type, explicit, quality, num_tracks, num_volumes, num_videos, duration, monitored
    )
    VALUES (?, ?, ?, ?, 0, 'LOSSLESS', 1, 1, 0, 180, 1)
  `).run("legacy-provider-album", artistMbid, "Give Me the Future", "ALBUM");

  db.prepare(`
    INSERT INTO ProviderMedia (
      id, artist_id, album_id, title, type, explicit, quality, monitored
    )
    VALUES (?, ?, ?, ?, ?, 0, 'LOSSLESS', 1)
  `).run("legacy-provider-video", artistMbid, "legacy-provider-album", "Bastille Video", "Music Video");

  const changes = monitoringModule.applyArtistMonitoringState(artistMbid, false);

  const artist = db.prepare("SELECT monitored FROM Artists WHERE id = ?").get(artistMbid) as { monitored: number };
  const slot = db.prepare("SELECT monitored, selected_provider_id FROM ReleaseGroupSlots WHERE release_group_mbid = ?").get(releaseGroupMbid) as {
    monitored: number;
    selected_provider_id: string;
  };
  const recording = db.prepare("SELECT monitored FROM Recordings WHERE mbid = ?").get("video-recording-1") as { monitored: number };
  const providerAlbum = db.prepare("SELECT monitored FROM ProviderAlbums WHERE id = ?").get("legacy-provider-album") as { monitored: number };
  const providerVideo = db.prepare("SELECT monitored FROM ProviderMedia WHERE id = ?").get("legacy-provider-video") as { monitored: number };

  assert.equal(changes, 1);
  assert.equal(artist.monitored, 0);
  assert.equal(slot.monitored, 0);
  assert.equal(slot.selected_provider_id, "243864035");
  assert.equal(recording.monitored, 0);
  assert.equal(providerAlbum.monitored, 1);
  assert.equal(providerVideo.monitored, 1);
});
