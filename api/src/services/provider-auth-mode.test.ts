import assert from "node:assert/strict";
import test from "node:test";

import {
  buildBypassedAuthStatus,
  getProviderAuthMode,
  isProviderAuthBypassed,
} from "./provider-auth-mode.js";

test("provider auth mode defaults to live and respects supported overrides", () => {
  const previous = process.env.DISCOGENIUS_PROVIDER_AUTH_MODE;

  try {
    delete process.env.DISCOGENIUS_PROVIDER_AUTH_MODE;
    assert.equal(getProviderAuthMode(), "live");
    assert.equal(isProviderAuthBypassed(), false);

    process.env.DISCOGENIUS_PROVIDER_AUTH_MODE = "mock";
    assert.equal(getProviderAuthMode(), "mock");
    assert.equal(isProviderAuthBypassed(), true);

    process.env.DISCOGENIUS_PROVIDER_AUTH_MODE = "disconnected";
    assert.equal(getProviderAuthMode(), "disconnected");
    assert.equal(isProviderAuthBypassed(), true);
  } finally {
    if (previous === undefined) {
      delete process.env.DISCOGENIUS_PROVIDER_AUTH_MODE;
    } else {
      process.env.DISCOGENIUS_PROVIDER_AUTH_MODE = previous;
    }
  }
});

test("provider auth mode builds deterministic bypass payloads", () => {
  const mockStatus = buildBypassedAuthStatus("mock");
  assert.equal(mockStatus?.connected, true);
  assert.equal(mockStatus?.canAccessShell, true);
  assert.equal(mockStatus?.remoteCatalogAvailable, false);
  assert.equal(mockStatus?.authBypassed, true);
  assert.equal(mockStatus?.canAuthenticate, false);

  const disconnectedStatus = buildBypassedAuthStatus("disconnected");
  assert.equal(disconnectedStatus?.connected, false);
  assert.equal(disconnectedStatus?.canAccessLocalLibrary, true);
  assert.equal(disconnectedStatus?.mode, "disconnected");
});
