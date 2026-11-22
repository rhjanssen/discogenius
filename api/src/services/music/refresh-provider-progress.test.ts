import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { StreamingProvider } from "../providers/streaming-provider.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-refresh-progress-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

const dbModule = await import("../../database.js");
dbModule.initDatabase();
const { RefreshArtistService } = await import("./refresh-artist-service.js");
const { streamingProviderManager } = await import("../providers/index.js");

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const ARTIST_MBID = "22222222-2222-4222-8222-222222222222";

function fakeProvider(id: string, name: string, listReleases: () => Promise<[]>): StreamingProvider {
  return {
    id,
    name,
    capabilities: {
      catalogSearch: true, artistCatalog: true, followedArtists: false, audioPreviews: false,
      audioDownloads: true, lossyStereo: false, losslessStereo: true, hiResStereo: false,
      spatialAudio: false, lyrics: false, musicVideos: false, videoPreviews: false,
      videoDownloads: false, artwork: false, editorialMetadata: false, providerIds: true,
    },
    isAuthenticated: () => true,
    search: async () => ({ artists: [], albums: [], tracks: [], videos: [] }),
    getArtist: async () => ({ providerId: `${id}-artist`, name: "Bastille" }),
    getArtistAlbums: listReleases,
    getAlbum: async () => { throw new Error("not used"); },
    getAlbumTracks: async () => [],
    getTrack: async () => { throw new Error("not used"); },
    getAuthStatus: async () => ({
      connected: true, tokenExpired: false, refreshTokenExpired: false, hoursUntilExpiry: 24,
      canAccessShell: true, canAccessLocalLibrary: false, remoteCatalogAvailable: true, canAuthenticate: true,
    }),
  } as StreamingProvider;
}

test("a refresh waiting on one slow provider names that provider and its phase", async () => {
  let releaseSlow!: () => void;
  const slowListing = new Promise<void>((resolve) => { releaseSlow = resolve; });
  streamingProviderManager.registerStreamingProvider(fakeProvider("fast-provider", "Fast Provider", async () => []));
  streamingProviderManager.registerStreamingProvider(fakeProvider("slow-provider", "Slow Provider", async () => {
    await slowListing;
    return [];
  }));

  const artist = dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, 'Bastille') RETURNING id")
    .get(ARTIST_MBID) as { id: number };
  for (const provider of ["fast-provider", "slow-provider"]) {
    const item = dbModule.db.prepare(`
      INSERT INTO ProviderItems (provider, entity_type, provider_id, title)
      VALUES (?, 'artist', ?, 'Bastille') RETURNING id
    `).get(provider, `${provider}-artist`) as { id: number };
    dbModule.db.prepare(`
      INSERT INTO ProviderArtistMatches (
        provider_artist_item_id, artist_id, match_state, decision_source, confidence, method, matcher_version
      ) VALUES (?, ?, 'accepted', 'manual', 1, 'test', 1)
    `).run(item.id, artist.id);
  }

  const phases: string[] = [];
  const refreshing = RefreshArtistService.matchArtistProviders(ARTIST_MBID, ARTIST_MBID, {
    progress: (event) => {
      if (event.kind === "provider_phase") phases.push(event.message);
    },
  }, true);

  const deadline = Date.now() + 5_000;
  while (!phases.some((message) => message.startsWith("waiting for")) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  try {
    assert.equal(phases.at(-1), "waiting for Slow Provider (listing releases)");
  } finally {
    releaseSlow();
    await refreshing;
  }
});
