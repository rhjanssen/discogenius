import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-tidal-auth-test-"));
process.env.DISCOGENIUS_CONFIG_DIR = configDir;

const { refreshStoredTidalToken, resetTidalRefreshBackoffForTests, TIDAL_AUTH_TOKEN_FILE } = await import("./tidal-auth.js");

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

test("TIDAL abuse_detected pauses further refresh attempts and keeps the token", async () => {
  resetTidalRefreshBackoffForTests();
  fs.mkdirSync(path.dirname(TIDAL_AUTH_TOKEN_FILE), { recursive: true });
  const token = { access_token: "old-access", refresh_token: "old-refresh", expires_at: 1 };
  fs.writeFileSync(TIDAL_AUTH_TOKEN_FILE, JSON.stringify(token));

  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: "abuse_detected" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    await assert.rejects(refreshStoredTidalToken, /TIDAL token refresh failed \(HTTP 403: abuse_detected\)/);
    const pause = JSON.parse(fs.readFileSync(path.join(path.dirname(TIDAL_AUTH_TOKEN_FILE), "refresh-pause.json"), "utf8"));
    assert.equal(typeof pause.until, "string");
    assert.equal(JSON.stringify(pause).includes("old-refresh"), false);
    assert.equal(await refreshStoredTidalToken(), null);
    assert.equal(calls, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(TIDAL_AUTH_TOKEN_FILE, "utf8")), token);
  } finally {
    globalThis.fetch = originalFetch;
    resetTidalRefreshBackoffForTests();
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test("a pause file blocks TIDAL refresh after the in-memory pause is gone", async () => {
  resetTidalRefreshBackoffForTests();
  const directory = path.dirname(TIDAL_AUTH_TOKEN_FILE);
  fs.mkdirSync(directory, { recursive: true });
  const token = { access_token: "old-access", refresh_token: "old-refresh", expires_at: 1 };
  fs.writeFileSync(TIDAL_AUTH_TOKEN_FILE, JSON.stringify(token));
  fs.writeFileSync(path.join(directory, "refresh-pause.json"), JSON.stringify({
    until: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  }));

  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error("fetch should not run");
  };

  try {
    assert.equal(await refreshStoredTidalToken(), null);
    assert.equal(calls, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(TIDAL_AUTH_TOKEN_FILE, "utf8")), token);
  } finally {
    globalThis.fetch = originalFetch;
    resetTidalRefreshBackoffForTests();
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});
