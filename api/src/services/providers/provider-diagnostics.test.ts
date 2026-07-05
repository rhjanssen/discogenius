import assert from "node:assert/strict";
import { test } from "node:test";

import { downloadBackendRegistry } from "../download/download-backend.js";
import { getProviderDiagnostics } from "./provider-diagnostics.js";
import type { ProviderCapabilities, StreamingProvider } from "./streaming-provider.js";

const capabilities: ProviderCapabilities = {
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
  artwork: true,
  editorialMetadata: false,
  providerIds: true,
};

test("provider diagnostics execute manifest checks against auth and registered backends", async () => {
  downloadBackendRegistry.register({
    id: "diagnostic-backend",
    supportedProviders: ["diagnostic-provider"],
    capabilities: ["stereo"],
    async download() {},
  });

  const provider: StreamingProvider = {
    id: "diagnostic-provider",
    name: "Diagnostic Provider",
    manifest: {
      id: "diagnostic-provider",
      displayName: "Diagnostic Provider",
      configRoot: "providers/diagnostic-provider",
      auth: { kind: "external", managedByApp: false },
      integration: { catalogSource: "official-api", downloadSource: "native-cli", stableResourceIds: ["artist", "album", "track"] },
      downloadBackends: [
        { id: "diagnostic-backend", capabilities: ["stereo"], enabled: true },
      ],
      catalog: { search: true, artistCatalog: true, releaseOffers: true, videos: false },
      imports: { supported: [] },
      qualityMapping: { neutral: false, stereo: false, spatial: false, video: false },
      diagnostics: ["auth", "catalog", "download-backend", "rate-limit"],
    },
    capabilities,
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
    getRateLimitMetrics() {
      return { rateLimitUntil: null, recent429Rate: "0%" };
    },
    async search() {
      return { artists: [], albums: [], tracks: [], videos: [] };
    },
    async getArtist() {
      throw new Error("not used");
    },
    async getArtistAlbums() {
      return [];
    },
    async getAlbum() {
      throw new Error("not used");
    },
    async getAlbumTracks() {
      return [];
    },
    async getTrack() {
      throw new Error("not used");
    },
  };

  const diagnostics = await getProviderDiagnostics(provider);
  assert.deepEqual(diagnostics.map((diagnostic) => diagnostic.kind), [
    "auth",
    "catalog",
    "download-backend",
    "rate-limit",
  ]);
  assert.equal(diagnostics.find((diagnostic) => diagnostic.kind === "auth")?.status, "ok");
  assert.equal(diagnostics.find((diagnostic) => diagnostic.kind === "catalog")?.status, "ok");
  assert.equal(diagnostics.find((diagnostic) => diagnostic.kind === "download-backend")?.status, "ok");
  assert.equal(diagnostics.find((diagnostic) => diagnostic.kind === "rate-limit")?.status, "ok");
});

test("provider diagnostics flag enabled download backends that are not registered correctly", async () => {
  const provider: StreamingProvider = {
    id: "missing-backend-provider",
    name: "Missing Backend Provider",
    manifest: {
      id: "missing-backend-provider",
      displayName: "Missing Backend Provider",
      configRoot: "providers/missing-backend-provider",
      auth: { kind: "none", managedByApp: false },
      integration: { catalogSource: "none", downloadSource: "native-cli", stableResourceIds: [] },
      downloadBackends: [
        { id: "missing-backend", capabilities: ["stereo"], enabled: true },
      ],
      catalog: { search: false, artistCatalog: false, releaseOffers: false, videos: false },
      imports: { supported: [] },
      qualityMapping: { neutral: false, stereo: false, spatial: false, video: false },
      diagnostics: ["download-backend"],
    },
    capabilities: { ...capabilities, catalogSearch: false, artistCatalog: false, audioDownloads: false },
    async getAuthStatus() {
      throw new Error("not used");
    },
    async search() {
      return { artists: [], albums: [], tracks: [], videos: [] };
    },
    async getArtist() {
      throw new Error("not used");
    },
    async getArtistAlbums() {
      return [];
    },
    async getAlbum() {
      throw new Error("not used");
    },
    async getAlbumTracks() {
      return [];
    },
    async getTrack() {
      throw new Error("not used");
    },
  };

  const diagnostics = await getProviderDiagnostics(provider);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].kind, "download-backend");
  assert.equal(diagnostics[0].status, "error");
});
