import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-tidal-auth-test-"));
process.env.DISCOGENIUS_CONFIG_DIR = configDir;

const { refreshStoredTidalToken, TIDAL_AUTH_TOKEN_FILE } = await import("./tidal-auth.js");

test("a rejected TIDAL refresh reports its HTTP error and preserves the stored token", async () => {
  fs.mkdirSync(path.dirname(TIDAL_AUTH_TOKEN_FILE), { recursive: true });
  const token = { access_token: "old-access", refresh_token: "old-refresh", expires_at: 1_900_000_000 };
  fs.writeFileSync(TIDAL_AUTH_TOKEN_FILE, JSON.stringify(token));

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "invalid_grant" }), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  });

  try {
    await assert.rejects(refreshStoredTidalToken, /TIDAL token refresh failed \(HTTP 400: invalid_grant\)/);
    assert.deepEqual(JSON.parse(fs.readFileSync(TIDAL_AUTH_TOKEN_FILE, "utf8")), token);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});
