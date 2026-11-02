import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-tidal-session-test-"));
process.env.DISCOGENIUS_CONFIG_DIR = configDir;

const {
  TIDAL_AUTH_TOKEN_FILE,
  resetTidalRefreshBackoffForTests,
  prepareTidalTokenForDownloader,
  adoptTiddlRefreshedToken,
} = await import("./tidal-auth.js");
const tidal = await import("./tidal.js");
const { TIDDL_AUTH_FILE } = await import("./tiddl.js");
const { TidalProvider } = await import("./tidal-provider.js");

const future = (seconds = 3 * 3600) => Math.floor(Date.now() / 1000) + seconds;

function writeToken(token: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(TIDAL_AUTH_TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TIDAL_AUTH_TOKEN_FILE, JSON.stringify(token));
}

function readToken(): Record<string, any> {
  return JSON.parse(fs.readFileSync(TIDAL_AUTH_TOKEN_FILE, "utf8"));
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function sessionResponse(url: string): Response | null {
  if (url.endsWith("/sessions")) return json(200, { userId: 1, countryCode: "NL" });
  if (url.includes("/users/")) return json(200, {});
  return null;
}

async function withFetch(handler: (url: string, init?: RequestInit) => Promise<Response> | Response, body: () => Promise<void>) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => handler(String(input), init)) as typeof fetch;
  try {
    await body();
  } finally {
    globalThis.fetch = originalFetch;
    resetTidalRefreshBackoffForTests();
    tidal.resetTidalSessionStateForTests();
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

test("an endpoint-level 401 (lyrics) never refreshes the token and reads as 'no lyrics'", async () => {
  resetTidalRefreshBackoffForTests();
  writeToken({ access_token: "valid", refresh_token: "r", expires_at: future(), refreshed_at: Date.now() - 2 * 3600_000 });
  let refreshCalls = 0;
  await withFetch((url) => {
    if (url.includes("/oauth2/token")) {
      refreshCalls += 1;
      throw new Error("refresh must not run");
    }
    return json(401, { status: 401, subStatus: 4005, userMessage: "Not allowed" });
  }, async () => {
    assert.equal(await new TidalProvider().getLyrics("42"), null);
    assert.equal(refreshCalls, 0);
    assert.equal(readToken().access_token, "valid");
  });
});

test("a 404 for lyrics is 'no lyrics', a token problem is an error", async () => {
  resetTidalRefreshBackoffForTests();
  writeToken({ access_token: "valid", refresh_token: "r", expires_at: future(), refreshed_at: Date.now() - 2 * 3600_000 });
  await withFetch(() => json(404, { status: 404, subStatus: 2001, userMessage: "Lyrics not found" }), async () => {
    assert.equal(await new TidalProvider().getLyrics("42"), null);
  });

  resetTidalRefreshBackoffForTests();
  // Expired and refresh paused: the request must fail locally, not be a "no lyrics" answer.
  writeToken({ access_token: "expired", refresh_token: "r", expires_at: 1 });
  fs.writeFileSync(path.join(path.dirname(TIDAL_AUTH_TOKEN_FILE), "refresh-pause.json"), JSON.stringify({
    until: new Date(Date.now() + 30 * 60_000).toISOString(),
  }));
  const urls: string[] = [];
  await withFetch((url) => {
    urls.push(url);
    return json(200, {});
  }, async () => {
    await assert.rejects(new TidalProvider().getLyrics("42"), tidal.TidalSessionUnavailableError);
    assert.deepEqual(urls, [], "an expired token must not be sent to TIDAL");
  });
});

test("a token-rejecting 401 refreshes once and retries the request with the new token", async () => {
  resetTidalRefreshBackoffForTests();
  writeToken({ access_token: "old", refresh_token: "r", expires_at: future(), refreshed_at: Date.now() - 2 * 3600_000 });
  let refreshCalls = 0;
  await withFetch((url, init) => {
    if (url.includes("/oauth2/token")) {
      refreshCalls += 1;
      return json(200, { access_token: "new", expires_in: 14_400 });
    }
    const session = sessionResponse(url);
    if (session) return session;
    const bearer = new Headers(init?.headers).get("Authorization");
    if (bearer === "Bearer old") return json(401, { status: 401, subStatus: 11003, userMessage: "The token has expired. (Expired on time)" });
    return json(200, { id: 7 });
  }, async () => {
    const results = await Promise.all([
      tidal.tidalApiRequest("/tracks/7?countryCode=NL"),
      tidal.tidalApiRequest("/tracks/8?countryCode=NL"),
    ]);
    assert.deepEqual(results, [{ id: 7 }, { id: 7 }]);
    assert.equal(refreshCalls, 1);
    assert.equal(readToken().access_token, "new");
  });
});

test("a rejected token that cannot be refreshed yet fails locally instead of hammering TIDAL", async () => {
  resetTidalRefreshBackoffForTests();
  // Refreshed five minutes ago: a forced refresh is not allowed yet.
  writeToken({ access_token: "old", refresh_token: "r", expires_at: future(), refreshed_at: Date.now() - 5 * 60_000 });
  let apiCalls = 0;
  let refreshCalls = 0;
  await withFetch((url) => {
    if (url.includes("/oauth2/token")) {
      refreshCalls += 1;
      return json(200, { access_token: "new", expires_in: 14_400 });
    }
    apiCalls += 1;
    return json(401, { status: 401, subStatus: 11002, userMessage: "Invalid token" });
  }, async () => {
    await assert.rejects(tidal.tidalApiRequest("/tracks/1"), /Invalid token/);
    await assert.rejects(tidal.tidalApiRequest("/tracks/2"), tidal.TidalSessionUnavailableError);
    await assert.rejects(tidal.tidalApiRequest("/tracks/3"), tidal.TidalSessionUnavailableError);
    assert.equal(apiCalls, 1);
    assert.equal(refreshCalls, 0);
  });
});

test("tiddl gets a token that will not make it refresh by itself", async () => {
  resetTidalRefreshBackoffForTests();
  writeToken({ access_token: "expiring", refresh_token: "r", expires_at: future(5 * 60) });
  let refreshCalls = 0;
  await withFetch((url) => {
    if (url.includes("/oauth2/token")) {
      refreshCalls += 1;
      return json(200, { access_token: "fresh", expires_in: 14_400 });
    }
    return sessionResponse(url) ?? json(404, {});
  }, async () => {
    await prepareTidalTokenForDownloader();
    assert.equal(refreshCalls, 1);
    const tiddl = JSON.parse(fs.readFileSync(TIDDL_AUTH_FILE, "utf8"));
    assert.equal(tiddl.token, "fresh");
    assert.ok(tiddl.expires_at - Math.floor(Date.now() / 1000) > 3600);
  });
});

test("a nearly expired token is not handed to tiddl while refreshes are paused", async () => {
  resetTidalRefreshBackoffForTests();
  writeToken({ access_token: "expiring", refresh_token: "r", expires_at: future(5 * 60) });
  fs.writeFileSync(path.join(path.dirname(TIDAL_AUTH_TOKEN_FILE), "refresh-pause.json"), JSON.stringify({
    until: new Date(Date.now() + 30 * 60_000).toISOString(),
  }));
  await withFetch(() => {
    throw new Error("no network call expected");
  }, async () => {
    await assert.rejects(prepareTidalTokenForDownloader(), /not available yet/);
    assert.equal(fs.existsSync(TIDDL_AUTH_FILE), false);
  });
});

test("a token tiddl refreshed by itself is adopted, a foreign or older one is not", async () => {
  resetTidalRefreshBackoffForTests();
  const storedExpiry = future(3600);
  writeToken({ access_token: "ours", refresh_token: "r", expires_at: storedExpiry });
  fs.mkdirSync(path.dirname(TIDDL_AUTH_FILE), { recursive: true });
  await withFetch(() => json(404, {}), async () => {
    fs.writeFileSync(TIDDL_AUTH_FILE, JSON.stringify({ token: "tiddl-new", refresh_token: "other", expires_at: storedExpiry + 3600 }));
    assert.equal(await adoptTiddlRefreshedToken(), false);
    fs.writeFileSync(TIDDL_AUTH_FILE, JSON.stringify({ token: "tiddl-old", refresh_token: "r", expires_at: storedExpiry - 60 }));
    assert.equal(await adoptTiddlRefreshedToken(), false);
    fs.writeFileSync(TIDDL_AUTH_FILE, JSON.stringify({ token: "tiddl-new", refresh_token: "r", expires_at: storedExpiry + 3600 }));
    assert.equal(await adoptTiddlRefreshedToken(), true);
    assert.equal(readToken().access_token, "tiddl-new");
    assert.equal(readToken().refresh_token, "r");
  });
});
