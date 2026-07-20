import assert from "node:assert/strict";
import test from "node:test";
import {
  providerSupportsAppAuthentication,
  providerSupportsDeviceAuthentication,
} from "./provider-auth-support.js";
import type { ProviderManifest, StreamingProvider } from "./streaming-provider.js";

function manifest(auth: ProviderManifest["auth"]): ProviderManifest {
  return {
    id: "test-provider",
    displayName: "Test Provider",
    configRoot: "providers/test-provider",
    auth,
    integration: { catalogSource: "official-api", downloadSource: "none", stableResourceIds: [] },
    downloadBackends: [],
    catalog: { search: true, artistCatalog: true, releaseOffers: true, videos: false },
    imports: { supported: [] },
    qualityMapping: { neutral: true, stereo: true, spatial: false, video: false },
  };
}

function providerWith(overrides: Partial<StreamingProvider>): StreamingProvider {
  return {
    id: "test-provider",
    name: "Test Provider",
    ...overrides,
  } as StreamingProvider;
}

test("comingSoon providers are not connectable in the app", () => {
  const provider = providerWith({
    manifest: manifest({
      kind: "external",
      managedByApp: false,
      comingSoon: true,
      credentialFields: [{ key: "token", label: "Token", secret: true, required: true }],
    }),
    saveCredentials: async () => undefined,
  });

  assert.equal(providerSupportsAppAuthentication(provider), false);
});

test("credential persistence makes an external provider connectable in the app", () => {
  const provider = providerWith({
    manifest: manifest({
      kind: "external",
      managedByApp: false,
      credentialFields: [{ key: "token", label: "Token", secret: true, required: true }],
    }),
    saveCredentials: async () => undefined,
  });

  assert.equal(providerSupportsAppAuthentication(provider), true);
  assert.equal(providerSupportsDeviceAuthentication(provider), false);
});

test("device authentication remains limited to app-managed device flows", () => {
  const startDeviceLogin = async () => ({ userCode: "CODE" });
  const unmanaged = providerWith({ startDeviceLogin });
  const managed = providerWith({
    startDeviceLogin,
    manifest: manifest({ kind: "oauth-device", managedByApp: true }),
  });

  assert.equal(providerSupportsAppAuthentication(unmanaged), false);
  assert.equal(providerSupportsDeviceAuthentication(unmanaged), false);
  assert.equal(providerSupportsDeviceAuthentication(managed), true);
});
