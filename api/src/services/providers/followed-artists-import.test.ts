import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-followed-import-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let importModule: typeof import("./followed-artists-import.js");
let providersModule: typeof import("./index.js");

before(async () => {
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  importModule = await import("./followed-artists-import.js");
  providersModule = await import("./index.js");
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("followed artist import uses the requested streaming provider", async () => {
  let followedArtistsRequested = false;

  providersModule.streamingProviderManager.registerStreamingProvider({
    id: "followed-test-provider",
    name: "Followed Test provider",
    capabilities: {
      catalogSearch: false,
      artistCatalog: false,
      followedArtists: true,
      audioPreviews: false,
      audioDownloads: false,
      lossyStereo: false,
      losslessStereo: false,
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
    coreCapabilities: {
      audio: false,
      spatialAudio: false,
      video: false,
      lyrics: false,
      download: false,
      search: false,
      followedArtists: true,
    },
    isAuthenticated: () => true,
    getFollowedArtists: async () => {
      followedArtistsRequested = true;
      return [];
    },
    search: async () => ({ artists: [], albums: [], tracks: [], videos: [] }),
    getArtist: async () => ({ providerId: "artist-1", name: "Test Artist" }),
    getArtistAlbums: async () => [],
    getAlbum: async () => ({
      providerId: "album-1",
      title: "Test Album",
      artist: { providerId: "artist-1", name: "Test Artist" },
    }),
    getAlbumTracks: async () => [],
    getTrack: async () => ({
      providerId: "track-1",
      title: "Test Track",
      artist: { providerId: "artist-1", name: "Test Artist" },
      album: {
        providerId: "album-1",
        title: "Test Album",
        artist: { providerId: "artist-1", name: "Test Artist" },
      },
      duration: 180,
      trackNumber: 1,
    }),
    logout: () => {},
    getAuthStatus: async () => ({
      connected: true,
      tokenExpired: false,
      refreshTokenExpired: false,
      hoursUntilExpiry: 24,
      canAccessShell: true,
      canAccessLocalLibrary: true,
      remoteCatalogAvailable: false,
      canAuthenticate: true,
    }),
  });

  const summary = await importModule.FollowedArtistsImportService.importFollowedArtists({
    providerId: "followed-test-provider",
  });

  assert.equal(followedArtistsRequested, true);
  assert.equal(summary.providerId, "followed-test-provider");
  assert.equal(summary.providerName, "Followed Test provider");
  assert.equal(summary.added, 0);
  assert.equal(summary.updated, 0);
  assert.equal(summary.skipped, 0);
  assert.match(summary.message, /No followed artists found/);
});
