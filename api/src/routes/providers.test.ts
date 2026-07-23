import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProviderPreferenceAfterDisconnect,
  providerConnectedForPreference,
  serializeProvider,
} from "./providers.js";
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

test("disconnect preference repair connection state rejects an expired remote token", async () => {
  const provider = providerWith({
    isAuthenticated: () => true,
    getAuthStatus: async () => authStatus({ connected: false, tokenExpired: true }),
  });

  assert.equal(await providerConnectedForPreference(provider), false);
});

test("disconnect preference repair connection state falls back locally only when probing fails", async () => {
  const provider = providerWith({
    isAuthenticated: () => true,
    getAuthStatus: async () => { throw new Error("status backend unavailable"); },
  });

  assert.equal(await providerConnectedForPreference(provider), true);
});

test("disconnect preference repair moves active providers ahead of inactive providers", () => {
  const connected = new Set(["apple-music", "youtube-music"]);
  const repaired = buildProviderPreferenceAfterDisconnect(
    ["tidal", "deezer", "apple-music", "youtube-music"],
    "tidal",
    (providerId) => connected.has(providerId),
  );

  assert.deepEqual(repaired, {
    providerPriority: ["apple-music", "youtube-music", "tidal", "deezer"],
    defaultProviderId: "apple-music",
  });
});

test("disconnect preference repair leaves the configured default alone with no active replacement", () => {
  const repaired = buildProviderPreferenceAfterDisconnect(
    ["tidal", "apple-music"],
    "tidal",
    () => false,
  );

  assert.equal(repaired, null);
});
