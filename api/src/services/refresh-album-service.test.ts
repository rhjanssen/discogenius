import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-refresh-album-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../database.js");
let refreshServiceModule: typeof import("./refresh-album-service.js");

before(async () => {
  dbModule = await import("../database.js");
  dbModule.initDatabase();
  refreshServiceModule = await import("./refresh-album-service.js");
});

beforeEach(() => {
  dbModule.db.prepare("DELETE FROM ProviderMediaArtists").run();
  dbModule.db.prepare("DELETE FROM ProviderItems").run();
  dbModule.db.prepare("DELETE FROM ReleaseGroupSlots").run();
  dbModule.db.prepare("DELETE FROM Tracks").run();
  dbModule.db.prepare("DELETE FROM Recordings").run();
  dbModule.db.prepare("DELETE FROM AlbumReleaseMedia").run();
  dbModule.db.prepare("DELETE FROM AlbumReleases").run();
  dbModule.db.prepare("DELETE FROM Albums").run();
  dbModule.db.prepare("DELETE FROM ProviderMedia").run();
  dbModule.db.prepare("DELETE FROM ProviderAlbums").run();
  dbModule.db.prepare("DELETE FROM Artists").run();
  dbModule.db.prepare("DELETE FROM ArtistMetadata").run();
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("track artist storage preserves the main credit when provider identities collapse to one canonical artist", () => {
  const artistMbid = "7808accb-6395-4b25-858c-678bbb73896b";
  const track = {
    provider_id: "473839984",
    artist_id: "4526830",
    artists: [
      { id: "4526830", name: "Bastille" },
      { id: "provider-alias", name: "Bastille" },
      { id: "provider-alias-2", name: "Bastille" },
    ],
  };

  dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)").run(artistMbid, "Bastille");
  dbModule.db.prepare("INSERT INTO Artists (id, name, mbid) VALUES (?, ?, ?)").run(artistMbid, "Bastille", artistMbid);
  dbModule.db.prepare(`
    INSERT INTO ProviderMedia (id, artist_id, title, type, explicit, quality)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(track.provider_id, artistMbid, "SAVE MY SOUL", "SINGLE", 0, "HIRES_LOSSLESS");

  (refreshServiceModule.RefreshAlbumService as any).storeTrackArtists(
    track,
    artistMbid,
    new Map([
      ["provider-alias", artistMbid],
      ["provider-alias-2", artistMbid],
    ]),
  );

  assert.deepEqual(
    dbModule.db.prepare(`
      SELECT media_id, artist_id, type
      FROM ProviderMediaArtists
      WHERE media_id = ?
    `).all(track.provider_id),
    [{
      media_id: track.provider_id,
      artist_id: artistMbid,
      type: "MAIN",
    }],
  );
});

test("album track scan stores provider track offers linked to the selected canonical release tracks", async () => {
  const { streamingProviderManager } = await import("./providers/index.js");
  const artistMbid = "7808accb-6395-4b25-858c-678bbb73896b";
  const releaseGroupMbid = "11111111-1111-4111-8111-111111111111";
  const releaseMbid = "22222222-2222-4222-8222-222222222222";
  const recordingMbid = "33333333-3333-4333-8333-333333333333";
  const trackMbid = "44444444-4444-4444-8444-444444444444";

  streamingProviderManager.registerStreamingProvider({
    id: "fake",
    name: "Fake Provider",
    capabilities: {
      catalogSearch: true,
      artistCatalog: true,
      followedArtists: false,
      audioPreviews: false,
      audioDownloads: true,
      lossyStereo: true,
      losslessStereo: true,
      hiResStereo: false,
      spatialAudio: false,
      lyrics: false,
      musicVideos: false,
      videoPreviews: false,
      videoDownloads: false,
      artwork: false,
      editorialMetadata: false,
      providerIds: true,
    },
    async search() { return { artists: [], albums: [], tracks: [], videos: [] }; },
    async getArtist() { throw new Error("not used"); },
    async getArtistAlbums() { return []; },
    async getAlbum() { throw new Error("not used"); },
    async getTrack() { throw new Error("not used"); },
    async getAlbumTracks() {
      return [{
        providerId: "provider-track-1",
        title: "Track One",
        duration: 180,
        trackNumber: 1,
        volumeNumber: 1,
        isrc: "USABC240001",
        quality: "LOSSLESS",
        artist: { providerId: "fake-artist", name: "Bastille" },
      } as any];
    },
    async getAuthStatus() {
      return {
        connected: true,
        tokenExpired: false,
        refreshTokenExpired: false,
        hoursUntilExpiry: 24,
        canAccessShell: true,
        canAccessLocalLibrary: true,
        remoteCatalogAvailable: true,
        canAuthenticate: false,
      };
    },
  });

  dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)").run(artistMbid, "Bastille");
  dbModule.db.prepare("INSERT INTO Artists (id, name, mbid, monitored) VALUES (?, ?, ?, 1)").run(artistMbid, "Bastille", artistMbid);
  dbModule.db.prepare("INSERT INTO Albums (mbid, artist_mbid, title, primary_type) VALUES (?, ?, ?, ?)").run(releaseGroupMbid, artistMbid, "Canonical Album", "album");
  dbModule.db.prepare("INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, status) VALUES (?, ?, ?, ?, ?)").run(releaseMbid, releaseGroupMbid, artistMbid, "Canonical Album", "Official");
  dbModule.db.prepare("INSERT INTO AlbumReleaseMedia (release_mbid, position, format, track_count) VALUES (?, 1, 'Digital Media', 1)").run(releaseMbid);
  dbModule.db.prepare("INSERT INTO Recordings (mbid, artist_mbid, title, isrcs) VALUES (?, ?, ?, ?)").run(recordingMbid, artistMbid, "Track One", JSON.stringify(["USABC240001"]));
  dbModule.db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, medium_position, position, number, title)
    VALUES (?, ?, ?, 1, 1, '1', ?)
  `).run(trackMbid, releaseMbid, recordingMbid, "Track One");
  dbModule.db.prepare(`
    INSERT INTO ProviderAlbums (
      id, artist_id, title, type, explicit, quality,
      num_tracks, num_volumes, num_videos, duration,
      mbid, mb_release_group_id
    ) VALUES (?, ?, ?, 'ALBUM', 0, 'LOSSLESS', 1, 1, 0, 180, ?, ?)
  `).run("provider-album-1", artistMbid, "Provider Album", releaseMbid, releaseGroupMbid);
  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title, quality, artist_mbid, release_group_mbid, release_mbid, library_slot
    ) VALUES ('fake', 'album', ?, ?, 'LOSSLESS', ?, ?, ?, 'stereo')
  `).run("provider-album-1", "Provider Album", artistMbid, releaseGroupMbid, releaseMbid);
  dbModule.db.prepare(`
    INSERT INTO ReleaseGroupSlots (
      artist_mbid, release_group_mbid, slot, monitored, selected_provider, selected_provider_id, selected_release_mbid, quality
    ) VALUES (?, ?, 'stereo', 1, 'fake', ?, ?, 'LOSSLESS')
  `).run(artistMbid, releaseGroupMbid, "provider-album-1", releaseMbid);

  await refreshServiceModule.RefreshAlbumService.scanTracks("provider-album-1", { resolveMusicBrainz: false });

  const offer = dbModule.db.prepare(`
    SELECT provider, entity_type, provider_id, release_group_mbid, release_mbid, track_mbid, recording_mbid, library_slot, match_method
    FROM ProviderItems
    WHERE provider = 'fake' AND entity_type = 'track' AND provider_id = 'provider-track-1'
  `).get() as any;

  assert.equal(offer.release_group_mbid, releaseGroupMbid);
  assert.equal(offer.release_mbid, releaseMbid);
  assert.equal(offer.track_mbid, trackMbid);
  assert.equal(offer.recording_mbid, recordingMbid);
  assert.equal(offer.library_slot, "stereo");
  assert.equal(offer.match_method, "selected-release-position");
});
