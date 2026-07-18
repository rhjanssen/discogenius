import assert from "node:assert/strict";
import test from "node:test";
import { serializeProvider } from "./providers.js";
import type { ProviderAuthStatus, StreamingProvider } from "../services/providers/streaming-provider.js";

function authStatus(overrides: Partial<ProviderAuthStatus> = {}): ProviderAuthStatus {
  return {
    connected: false,
    tokenExpired: false,
    refreshTokenExpired: false,
    hoursUntilExpiry: 0,
    canAccessShell: true,
    canAccessLocalLibrary: true,
    remoteCatalogAvailable: false,
    canAuthenticate: true,
    ...overrides,
  };
}

function providerWith(overrides: Partial<StreamingProvider>): StreamingProvider {
  return {
    id: "manifest-provider",
    name: "Manifest Provider",
    capabilities: {
      catalogSearch: true,
      artistCatalog: true,
      followedArtists: false,
      audioPreviews: false,
      audioDownloads: false,
      lossyStereo: true,
      losslessStereo: false,
      hiResStereo: false,
      spatialAudio: false,
      lyrics: false,
      musicVideos: false,
      videoPreviews: false,
      videoDownloads: false,
      artwork: true,
      editorialMetadata: false,
      providerIds: true,
    },
    ...overrides,
  } as StreamingProvider;
}

test("provider serialization keeps public catalog availability separate from authentication", async () => {
  const provider = providerWith({
    isAuthenticated: () => false,
    saveCredentials: async () => undefined,
    getAuthStatus: async () => authStatus({ connected: false, remoteCatalogAvailable: true }),
  });

  const serialized = await serializeProvider(provider, false);

  assert.equal(serialized.authenticated, false);
  assert.equal(serialized.remoteCatalogAvailable, true);
  assert.equal(serialized.management.canAuthenticate, true);
});

test("provider serialization uses the awaited provider status for connected state", async () => {
  const provider = providerWith({
    isAuthenticated: () => false,
    getAuthStatus: async () => authStatus({ connected: true, remoteCatalogAvailable: true }),
  });

  const serialized = await serializeProvider(provider, true);

  assert.equal(serialized.authenticated, true);
  assert.equal(serialized.remoteCatalogAvailable, true);
  assert.equal(serialized.isDefault, true);
});

test("provider serialization falls back to local authentication when a status probe fails", async () => {
  const provider = providerWith({
    isAuthenticated: () => true,
    getAuthStatus: async () => { throw new Error("status backend unavailable"); },
  });

  const serialized = await serializeProvider(provider, false);

  assert.equal(serialized.authenticated, true);
  assert.equal(serialized.remoteCatalogAvailable, true);
});
