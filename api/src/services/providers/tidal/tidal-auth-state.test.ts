import assert from "node:assert/strict";
import fs from "node:fs";
import { after } from "node:test";
import test from "node:test";
import { prepareActiveSchemaEnv, closeActiveSchemaDb } from "../../../test-support/active-schema-fixture.js";

const { tempDir } = prepareActiveSchemaEnv("tidal-auth-state");
const dbModule = await import("../../../database.js");
dbModule.initDatabase();
const { refreshStoredTidalToken, saveStoredTidalToken, TIDAL_AUTH_TOKEN_FILE, resetTidalRefreshBackoffForTests } = await import("./tidal-auth.js");
const { providerNeedsReauth, resetProviderAuthCacheForTests } = await import("../provider-auth-state.js");
const { ProviderAuthError } = await import("../provider-auth-error.js");

after(() => closeActiveSchemaDb(dbModule, tempDir));

test("a Tidal refresh auth failure marks needs_reauth once and stops calling Tidal", async () => {
  resetTidalRefreshBackoffForTests();
  resetProviderAuthCacheForTests();
  fs.mkdirSync(TIDAL_AUTH_TOKEN_FILE.replace(/token\.json$/, ""), { recursive: true });
  fs.writeFileSync(TIDAL_AUTH_TOKEN_FILE, JSON.stringify({
    access_token: "old-access",
    refresh_token: "old-refresh",
    expires_at: 1,
  }));
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: "invalid_grant", error_description: "token has expired" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    await assert.rejects(refreshStoredTidalToken, (error: unknown) => error instanceof ProviderAuthError);
    assert.equal(providerNeedsReauth("tidal"), true);
    assert.equal(await refreshStoredTidalToken(), null);
    assert.equal(calls, 1);
    await saveStoredTidalToken({ access_token: "new-access", refresh_token: "new-refresh" });
    assert.equal(providerNeedsReauth("tidal"), false);
  } finally {
    globalThis.fetch = originalFetch;
    resetTidalRefreshBackoffForTests();
  }
});
