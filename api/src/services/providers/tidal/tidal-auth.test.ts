import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-tidal-auth-test-"));
process.env.DISCOGENIUS_CONFIG_DIR = configDir;

const {
  refreshStoredTidalToken,
  resetTidalRefreshBackoffForTests,
  TIDAL_AUTH_TOKEN_FILE,
  tidalAbuseBackoffMs,
  tidalRefreshFailureBackoffMs,
  tidalUnauthorizedRejectsToken,
  isTidalRefreshPaused,
} = await import("./tidal-auth.js");
const { ProviderAuthError } = await import("../provider-auth-error.js");

test("a 401 TIDAL refresh is an auth failure, keeps the tokens and marks the refresh token rejected", async () => {
  resetTidalRefreshBackoffForTests();
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
      assert.match((error as Error).message, /Tidal login expired/);
      return true;
    });
    const stored = JSON.parse(fs.readFileSync(TIDAL_AUTH_TOKEN_FILE, "utf8"));
    assert.equal(stored.access_token, token.access_token);
    assert.equal(stored.refresh_token, token.refresh_token);
    assert.equal(typeof stored.refresh_rejected_at, "number");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("invalid_grant that says the token has expired is an auth failure", async () => {
  resetTidalRefreshBackoffForTests();
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
  resetTidalRefreshBackoffForTests();
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
  const token = { access_token: "old-access", refresh_token: "old-refresh", expires_at: 1 };
  fs.writeFileSync(TIDAL_AUTH_TOKEN_FILE, JSON.stringify(token));
  resetTidalRefreshBackoffForTests();

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

function writeToken(token: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(TIDAL_AUTH_TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TIDAL_AUTH_TOKEN_FILE, JSON.stringify(token));
}

test("a valid token is refreshed only when TIDAL rejected that exact access token", async () => {
  resetTidalRefreshBackoffForTests();
  writeToken({
    access_token: "current",
    refresh_token: "r",
    expires_at: Math.floor(Date.now() / 1000) + 3 * 3600,
    refreshed_at: Date.now() - 2 * 60 * 60 * 1000,
  });
  let tokenCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = String(input);
    const session = sessionResponses(url);
    if (session) return session;
    tokenCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return okRefreshResponse("renewed");
  };
  try {
    assert.equal((await refreshStoredTidalToken())?.access_token, "current");
    assert.equal((await refreshStoredTidalToken({ rejectedAccessToken: "some-older-token" }))?.access_token, "current");
    assert.equal(tokenCalls, 0);
    const results = await Promise.all([
      refreshStoredTidalToken({ rejectedAccessToken: "current" }),
      refreshStoredTidalToken({ rejectedAccessToken: "current" }),
    ]);
    assert.equal(tokenCalls, 1);
    assert.ok(results.every((result) => result?.access_token === "renewed"));
    // The rejected token is gone; a late caller with the same claim must not refresh again.
    assert.equal((await refreshStoredTidalToken({ rejectedAccessToken: "current" }))?.access_token, "renewed");
    assert.equal(tokenCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    resetTidalRefreshBackoffForTests();
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test("a refresh token TIDAL rejected is not tried again until a new login", async () => {
  resetTidalRefreshBackoffForTests();
  writeToken({ access_token: "a", refresh_token: "r", expires_at: 1, refresh_rejected_at: Date.now() - 1000 });
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error("fetch should not run");
  };
  try {
    assert.equal(await refreshStoredTidalToken(), null);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    resetTidalRefreshBackoffForTests();
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test("an expired access token with a usable refresh token is refreshed even when TIDAL is marked needs_reauth", async () => {
  // Regression for 23 Oct 2026: a download that saw "The token has expired"
  // marked TIDAL needs_reauth, and the refresh then refused to run at all.
  resetTidalRefreshBackoffForTests();
  const { recordProviderAuthFailure } = await import("../provider-auth-state.js");
  await recordProviderAuthFailure("tidal", "Tidal login expired (token has expired).").catch(() => undefined);
  writeToken({ access_token: "expired", refresh_token: "r", expires_at: 1 });
  let tokenCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request) => {
    const session = sessionResponses(String(input));
    if (session) return session;
    tokenCalls += 1;
    return okRefreshResponse("renewed");
  };
  try {
    assert.equal((await refreshStoredTidalToken())?.access_token, "renewed");
    assert.equal(tokenCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    resetTidalRefreshBackoffForTests();
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test("a failing refresh endpoint is not called again before the backoff ends", async () => {
  resetTidalRefreshBackoffForTests();
  writeToken({ access_token: "expired", refresh_token: "r", expires_at: 1 });
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("upstream", { status: 503 });
  };
  try {
    await assert.rejects(refreshStoredTidalToken(), /HTTP 503/);
    for (let i = 0; i < 5; i += 1) {
      assert.equal(await refreshStoredTidalToken(), null);
    }
    assert.equal(calls, 1);
    assert.equal(tidalRefreshFailureBackoffMs(1), 60 * 1000);
    assert.equal(tidalRefreshFailureBackoffMs(3), 4 * 60 * 1000);
    assert.equal(tidalRefreshFailureBackoffMs(50), 30 * 60 * 1000);
  } finally {
    globalThis.fetch = originalFetch;
    resetTidalRefreshBackoffForTests();
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test("only a token-specific 401 body counts as a token rejection", () => {
  assert.equal(tidalUnauthorizedRejectsToken({ status: 401, subStatus: 11003, userMessage: "The token has expired. (Expired on time)" }), true);
  assert.equal(tidalUnauthorizedRejectsToken({ status: 401, subStatus: 11002, userMessage: "Invalid token" }), true);
  assert.equal(tidalUnauthorizedRejectsToken({ status: 401, subStatus: 4005, userMessage: "Asset is not ready for playback" }), false);
  assert.equal(tidalUnauthorizedRejectsToken({ status: 401, subStatus: 4006, userMessage: "Not allowed" }), false);
  assert.equal(tidalUnauthorizedRejectsToken({}), false);
  assert.equal(tidalUnauthorizedRejectsToken(null), false);
});
