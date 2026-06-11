import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveAcoustIdClientId,
  resolveOrpheusTidalModuleConfig,
  resolveTidalAuthClientConfig,
} from "./provider-client-config.js";

test("resolveTidalAuthClientConfig returns defaults when no overrides are present", () => {
  const config = resolveTidalAuthClientConfig({});
  assert.equal(config.clientId, "cgiF7TQuB97BUIu3");
  assert.equal(config.clientSecret, "1nqpgx8uvBdZigrx4hUPDV2hOwgYAAAG5DYXOr6uNf8=");
  assert.equal(config.authUserAgent, "TIDAL_ANDROID/1039 okhttp/3.14.9");
});

test("resolveTidalAuthClientConfig respects env overrides", () => {
  const config = resolveTidalAuthClientConfig({
    TIDAL_AUTH_CLIENT_ID: "custom-client",
    TIDAL_AUTH_CLIENT_SECRET: "custom-secret",
    TIDAL_AUTH_USER_AGENT: "DiscogeniusTest/1.0",
  });
  assert.equal(config.clientId, "custom-client");
  assert.equal(config.clientSecret, "custom-secret");
  assert.equal(config.authUserAgent, "DiscogeniusTest/1.0");
});

test("resolveOrpheusTidalModuleConfig inherits auth-client defaults and supports explicit overrides", () => {
  const inherited = resolveOrpheusTidalModuleConfig({
    TIDAL_AUTH_CLIENT_ID: "shared-client",
    TIDAL_AUTH_CLIENT_SECRET: "shared-secret",
  });
  assert.equal(inherited.clientId, "shared-client");
  assert.equal(inherited.clientSecret, "shared-secret");

  const overridden = resolveOrpheusTidalModuleConfig({
    TIDAL_AUTH_CLIENT_ID: "shared-client",
    TIDAL_AUTH_CLIENT_SECRET: "shared-secret",
    ORPHEUS_TIDAL_CLIENT_ID: "orpheus-client",
    ORPHEUS_TIDAL_CLIENT_SECRET: "orpheus-secret",
    ORPHEUS_MOBILE_HIRES_TOKEN: "hires",
    ORPHEUS_MOBILE_ATMOS_TOKEN: "atmos",
  });
  assert.equal(overridden.clientId, "orpheus-client");
  assert.equal(overridden.clientSecret, "orpheus-secret");
  assert.equal(overridden.mobileHiresToken, "hires");
  assert.equal(overridden.mobileAtmosToken, "atmos");
});

test("resolveAcoustIdClientId prefers env, then config, then default", () => {
  assert.equal(resolveAcoustIdClientId({ env: { ACOUSTID_CLIENT_ID: "env-client" } }), "env-client");
  assert.equal(resolveAcoustIdClientId({ env: {}, appConfig: { acoustid_api_key: "config-client" } }), "config-client");
  assert.equal(resolveAcoustIdClientId({ env: {}, appConfig: {} }), "QANd68ji1L");
});
