import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-provider-track-resolver-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let resolverModule: typeof import("./provider-track-resolver.js");
let providersModule: typeof import("../providers/index.js");

before(async () => {
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  resolverModule = await import("./provider-track-resolver.js");
  providersModule = await import("../providers/index.js");
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("canonical provider track resolution splits combined provider album selections", async () => {
  const { db } = dbModule;
  const providerCalls: string[] = [];
  const artist = { providerId: "artist-1", name: "Test Artist" };
  const album = {
    providerId: "album-b",
    title: "Split Release",
    artist,
    trackCount: 1,
    volumeCount: 1,
  };

  providersModule.streamingProviderManager.registerStreamingProvider({
    id: "test-provider",
    name: "Test provider",
    capabilities: {},
    search: async () => ({ artists: [], albums: [], tracks: [], videos: [] }),
    getArtist: async () => artist,
    getArtistAlbums: async () => [],
    getAlbum: async () => album,
    getTrack: async (id: string | number) => ({
      providerId: String(id),
      title: "Target Track",
      artist,
      album,
      duration: 180,
      trackNumber: 2,
      volumeNumber: 1,
    }),
    getAlbumTracks: async (id: string | number) => {
      providerCalls.push(String(id));
      if (String(id) === "album-b") {
        return [{
          providerId: "track-b",
          title: "Target Track",
          artist,
          album: { ...album, providerId: "album-b" },
          duration: 180,
          trackNumber: 2,
          volumeNumber: 1,
          quality: "LOSSLESS",
        }];
      }

      return [{
        providerId: "track-a",
        title: "Other Track",
        artist,
        album: { ...album, providerId: "album-a" },
        duration: 120,
        trackNumber: 1,
        volumeNumber: 1,
        quality: "LOSSLESS",
      }];
    },
  } as any);

  db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)").run("artist-mbid-1", "Test Artist");
  db.prepare("INSERT INTO Albums (mbid, artist_mbid, title, primary_type) VALUES (?, ?, ?, ?)")
    .run("rg-mbid-1", "artist-mbid-1", "Split Release", "album");
  db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, status, date, track_count, media_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("release-mbid-1", "rg-mbid-1", "artist-mbid-1", "Split Release", "Official", "2024-01-01", 2, 1);
  db.prepare("INSERT INTO Recordings (mbid, title, isrcs) VALUES (?, ?, ?)")
    .run("recording-mbid-2", "Target Track", JSON.stringify(["ISRC123"]));
  db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, position, medium_position, length_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run("track-mbid-2", "release-mbid-1", "recording-mbid-2", "Target Track", 2, 1, 180000);
  db.prepare(`
    INSERT INTO ReleaseGroupSlots (
      artist_mbid, release_group_mbid, slot, monitored, selected_provider, selected_provider_id, quality, match_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("artist-mbid-1", "rg-mbid-1", "stereo", 1, "test-provider", "album-a;album-b", "LOSSLESS", "verified");

  const resolved = await resolverModule.resolveProviderTrackForCanonicalTrack({
    releaseGroupMbid: "rg-mbid-1",
    canonicalTrackMbid: "track-mbid-2",
  });

  assert.deepEqual(providerCalls, ["album-a", "album-b"]);
  assert.equal(resolved?.providerAlbumId, "album-b");
  assert.equal(resolved?.providerTrackId, "track-b");
});

test("canonical provider track resolution includes provider version text while matching", async () => {
  const { db } = dbModule;
  const artist = { providerId: "artist-2", name: "Test Artist" };
  const album = { providerId: "album-version", title: "Versioned Release", artist };

  providersModule.streamingProviderManager.registerStreamingProvider({
    id: "version-provider",
    name: "Version provider",
    capabilities: {},
    search: async () => ({ artists: [], albums: [], tracks: [], videos: [] }),
    getArtist: async () => artist,
    getArtistAlbums: async () => [],
    getAlbum: async () => album,
    getTrack: async () => { throw new Error("unused"); },
    getAlbumTracks: async () => [{
      providerId: "track-version",
      title: "Brave New World",
      version: "Interlude",
      artist,
      album,
      duration: 27,
      trackNumber: 4,
      volumeNumber: 1,
      quality: "LOSSLESS",
    }],
  } as any);

  db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)").run("artist-mbid-2", "Test Artist");
  db.prepare("INSERT INTO Albums (mbid, artist_mbid, title, primary_type) VALUES (?, ?, ?, ?)")
    .run("rg-mbid-2", "artist-mbid-2", "Versioned Release", "album");
  db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, status, date, track_count, media_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("release-mbid-2", "rg-mbid-2", "artist-mbid-2", "Versioned Release", "Official", "2024-01-01", 1, 1);
  db.prepare(`
    INSERT INTO Recordings (mbid, title, isrcs)
    VALUES (?, ?, ?)
  `).run("recording-mbid-version", "Brave New World (interlude)", JSON.stringify([]));
  db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, position, medium_position, length_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run("track-mbid-version", "release-mbid-2", "recording-mbid-version", "Brave New World (interlude)", 4, 1, 27000);
  db.prepare(`
    INSERT INTO ReleaseGroupSlots (
      artist_mbid, release_group_mbid, slot, monitored, selected_provider, selected_provider_id, quality, match_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("artist-mbid-2", "rg-mbid-2", "stereo", 1, "version-provider", "album-version", "LOSSLESS", "verified");

  const resolved = await resolverModule.resolveProviderTrackForCanonicalTrack({
    releaseGroupMbid: "rg-mbid-2",
    canonicalTrackMbid: "track-mbid-version",
  });

  assert.equal(resolved?.providerTrackId, "track-version");
});
