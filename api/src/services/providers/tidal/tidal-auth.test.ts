import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-tidal-auth-test-"));
process.env.DISCOGENIUS_CONFIG_DIR = configDir;

const { refreshStoredTidalToken, resetTidalRefreshBackoffForTests, TIDAL_AUTH_TOKEN_FILE, tidalAbuseBackoffMs, isTidalRefreshPaused } = await import("./tidal-auth.js");
const { ProviderAuthError } = await import("../provider-auth-error.js");

test("a 401 TIDAL refresh is an auth failure and preserves the stored token", async () => {
  fs.mkdirSync(path.dirname(TIDAL_AUTH_TOKEN_FILE), { recursive: true });
  const token = { access_token: "old-access", refresh_token: "old-refresh", expires_at: 1 };
  fs.writeFileSync(TIDAL_AUTH_TOKEN_FILE, JSON.stringify(token));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: "invalid_token",
    error_description: "token has expired",
  }), { status: 401, headers: { "Content-Type": "application/json" } });
  try {
    await assert.rejects(refreshStoredTidalToken, (error: unknown) => {
      assert.equal(error instanceof ProviderAuthError, true);
      assert.match((error as Error).message, /token has expired/);
      return true;
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(TIDAL_AUTH_TOKEN_FILE, "utf8")), token);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("invalid_grant that says the token has expired is an auth failure", async () => {
  fs.mkdirSync(path.dirname(TIDAL_AUTH_TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TIDAL_AUTH_TOKEN_FILE, JSON.stringify({
    access_token: "old-access", refresh_token: "old-refresh", expires_at: 1,
  }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: "invalid_grant",
    error_description: "The token has expired",
  }), { status: 400, headers: { "Content-Type": "application/json" } });
  try {
    await assert.rejects(refreshStoredTidalToken, (error: unknown) => error instanceof ProviderAuthError);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a network error during TIDAL refresh is not an auth failure", async () => {
  fs.mkdirSync(path.dirname(TIDAL_AUTH_TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TIDAL_AUTH_TOKEN_FILE, JSON.stringify({
    access_token: "old-access", refresh_token: "old-refresh", expires_at: 1,
  }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError("fetch failed"); };
  try {
    await assert.rejects(refreshStoredTidalToken, (error: unknown) => {
      assert.equal(error instanceof ProviderAuthError, false);
      assert.match((error as Error).message, /fetch failed/);
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

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

function okRefreshResponse(accessToken: string): Response {
  return new Response(JSON.stringify({ access_token: accessToken, expires_in: 14_400, token_type: "Bearer" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function sessionResponses(url: string): Response | null {
  if (url.endsWith("/sessions")) {
    return new Response(JSON.stringify({ userId: 1, countryCode: "NL" }), { status: 200 });
  }
  if (url.includes("/users/")) {
    return new Response(JSON.stringify({ username: "u" }), { status: 200 });
  }
  return null;
}

test("a still-valid, recently refreshed TIDAL token is not refreshed again however often callers force it", async () => {
  resetTidalRefreshBackoffForTests();
  fs.mkdirSync(path.dirname(TIDAL_AUTH_TOKEN_FILE), { recursive: true });
  const token = {
    access_token: "fresh-access",
    refresh_token: "r",
    expires_at: Math.floor(Date.now() / 1000) + 3 * 3600,
    refreshed_at: Date.now() - 12 * 60 * 1000,
  };
  fs.writeFileSync(TIDAL_AUTH_TOKEN_FILE, JSON.stringify(token));

  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error("fetch should not run");
  };
  try {
    for (let i = 0; i < 3; i += 1) {
      const result = await refreshStoredTidalToken();
      assert.equal(result?.access_token, "fresh-access");
    }
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    resetTidalRefreshBackoffForTests();
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test("concurrent TIDAL refreshes share one request and record refreshed_at", async () => {
  resetTidalRefreshBackoffForTests();
  fs.mkdirSync(path.dirname(TIDAL_AUTH_TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TIDAL_AUTH_TOKEN_FILE, JSON.stringify({ access_token: "old", refresh_token: "r", expires_at: 1 }));

  let tokenCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = String(input);
    const session = sessionResponses(url);
    if (session) return session;
    tokenCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return okRefreshResponse("new-access");
  };
  try {
    const results = await Promise.all([refreshStoredTidalToken(), refreshStoredTidalToken(), refreshStoredTidalToken()]);
    assert.equal(tokenCalls, 1);
    assert.ok(results.every((r) => r?.access_token === "new-access"));
    const stored = JSON.parse(fs.readFileSync(TIDAL_AUTH_TOKEN_FILE, "utf8"));
    assert.equal(stored.refresh_token, "r");
    assert.equal(typeof stored.refreshed_at, "number");
  } finally {
    globalThis.fetch = originalFetch;
    resetTidalRefreshBackoffForTests();
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test("abuse_detected backoff escalates from 30 minutes and never exceeds the token lifetime cap", async () => {
  assert.equal(tidalAbuseBackoffMs(1), 30 * 60 * 1000);
  assert.equal(tidalAbuseBackoffMs(2), 60 * 60 * 1000);
  assert.equal(tidalAbuseBackoffMs(3), 2 * 60 * 60 * 1000);
  assert.equal(tidalAbuseBackoffMs(4), 4 * 60 * 60 * 1000);
  assert.equal(tidalAbuseBackoffMs(10), 4 * 60 * 60 * 1000);
});

test("a legacy 12-hour pause file is clamped to the 4-hour cap", async () => {
  resetTidalRefreshBackoffForTests();
  const directory = path.dirname(TIDAL_AUTH_TOKEN_FILE);
  fs.mkdirSync(directory, { recursive: true });
  const now = Date.now();
  fs.writeFileSync(path.join(directory, "refresh-pause.json"), JSON.stringify({
    until: new Date(now + 12 * 60 * 60 * 1000).toISOString(),
  }));
  try {
    assert.equal(isTidalRefreshPaused(now), true);
    assert.equal(isTidalRefreshPaused(now + 4 * 60 * 60 * 1000 + 1), false);
  } finally {
    resetTidalRefreshBackoffForTests();
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});
