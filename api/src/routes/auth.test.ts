import assert from "node:assert/strict";
import test from "node:test";

import { aggregateProviderAuthStatus } from "./auth.js";
import type { ProviderAuthStatus, StreamingProvider } from "../services/providers/streaming-provider.js";

function status(overrides: Partial<ProviderAuthStatus>): ProviderAuthStatus {
  return {
    connected: false,
    tokenExpired: false,
    refreshTokenExpired: false,
    hoursUntilExpiry: 0,
    canAccessShell: true,
    canAccessLocalLibrary: true,
    remoteCatalogAvailable: false,
    canAuthenticate: false,
    ...overrides,
  };
}

function provider(id: string, auth: () => Promise<ProviderAuthStatus>): StreamingProvider {
  return {
    id,
    name: id,
    capabilities: {} as StreamingProvider["capabilities"],
    search: async () => ({ artists: [], albums: [], tracks: [], videos: [] }),
    getArtist: async () => { throw new Error("unused"); },
    getArtistAlbums: async () => [],
    getAlbum: async () => { throw new Error("unused"); },
    getAlbumTracks: async () => [],
    getTrack: async () => { throw new Error("unused"); },
    getAuthStatus: auth,
  };
}

test("aggregate auth exposes public catalogs without pretending the provider is connected", async () => {
  const result = await aggregateProviderAuthStatus([
    provider("broken", async () => { throw new Error("offline"); }),
    provider("deezer", async () => status({
      remoteCatalogAvailable: true,
      canAuthenticate: true,
      message: "Deezer public catalog is available.",
    })),
  ]);

  assert.equal(result.connected, false);
  assert.equal(result.remoteCatalogAvailable, true);
  assert.equal(result.canAuthenticate, true);
  assert.equal(result.message, "Deezer public catalog is available.");
});

test("aggregate auth keeps the first connected provider identity while OR-ing catalog access", async () => {
  const result = await aggregateProviderAuthStatus([
    provider("tidal", async () => status({
      connected: true,
      remoteCatalogAvailable: true,
      hoursUntilExpiry: 6,
      user: { username: "listener" },
    })),
    provider("youtube-music", async () => status({ remoteCatalogAvailable: true })),
  ]);

  assert.equal(result.connected, true);
  assert.equal(result.remoteCatalogAvailable, true);
  assert.equal(result.user?.username, "listener");
  assert.equal(result.hoursUntilExpiry, 6);
});
