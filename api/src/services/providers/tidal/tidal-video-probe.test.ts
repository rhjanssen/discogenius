import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-tidal-probe-test-"));
process.env.DISCOGENIUS_CONFIG_DIR = configDir;

const { TIDAL_AUTH_TOKEN_FILE, resetTidalRefreshBackoffForTests } = await import("./tidal-auth.js");
const { probeTidalVideoQuality } = await import("./tidal-video-probe.js");

const FUTURE = () => Math.floor(Date.now() / 1000) + 3 * 3600;

function sessionResponse(url: string): Response | null {
  if (url.endsWith("/sessions")) return new Response(JSON.stringify({ userId: 1, countryCode: "NL" }), { status: 200 });
  if (url.includes("/users/")) return new Response("{}", { status: 200 });
  return null;
}

test("a 403/404 video probe never refreshes the TIDAL token", async () => {
  resetTidalRefreshBackoffForTests();
  fs.mkdirSync(path.dirname(TIDAL_AUTH_TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TIDAL_AUTH_TOKEN_FILE, JSON.stringify({ access_token: "a", refresh_token: "r", expires_at: FUTURE() }));

  const urls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("/oauth2/token")) throw new Error("refresh must not run");
    const status = url.includes("videoquality=HIGH") ? 403 : 404;
    return new Response(JSON.stringify({ status }), { status });
  };
  try {
    assert.equal(await probeTidalVideoQuality("123"), null);
    assert.equal(urls.some((url) => url.includes("/oauth2/token")), false);
  } finally {
    globalThis.fetch = originalFetch;
    resetTidalRefreshBackoffForTests();
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test("an asset-level 401 on a video probe does not refresh the TIDAL token", async () => {
  resetTidalRefreshBackoffForTests();
  fs.mkdirSync(path.dirname(TIDAL_AUTH_TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TIDAL_AUTH_TOKEN_FILE, JSON.stringify({
    access_token: "a", refresh_token: "r", expires_at: FUTURE(), refreshed_at: Date.now() - 2 * 3600_000,
  }));
  let refreshCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/oauth2/token")) {
      refreshCalls += 1;
      throw new Error("refresh must not run");
    }
    return new Response(JSON.stringify({ status: 401, subStatus: 4005, userMessage: "Asset is not ready for playback" }), { status: 401 });
  };
  try {
    assert.equal(await probeTidalVideoQuality("123"), null);
    assert.equal(refreshCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    resetTidalRefreshBackoffForTests();
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test("a token-rejecting 401 refreshes once and retries the probe with the new token", async () => {
  resetTidalRefreshBackoffForTests();
  fs.mkdirSync(path.dirname(TIDAL_AUTH_TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TIDAL_AUTH_TOKEN_FILE, JSON.stringify({
    access_token: "old", refresh_token: "r", expires_at: FUTURE(), refreshed_at: Date.now() - 2 * 3600_000,
  }));

  let refreshCalls = 0;
  const bearers: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/oauth2/token")) {
      refreshCalls += 1;
      return new Response(JSON.stringify({ access_token: "new", expires_in: 14_400 }), { status: 200 });
    }
    const session = sessionResponse(url);
    if (session) return session;
    const auth = new Headers(init?.headers).get("Authorization");
    bearers.push(String(auth));
    if (auth === "Bearer old") {
      return new Response(JSON.stringify({ status: 401, subStatus: 11002, userMessage: "Invalid token" }), { status: 401 });
    }
    return new Response(JSON.stringify({ status: 404 }), { status: 404 });
  };
  try {
    assert.equal(await probeTidalVideoQuality("123"), null);
    assert.equal(refreshCalls, 1);
    assert.ok(bearers.includes("Bearer new"));
  } finally {
    globalThis.fetch = originalFetch;
    resetTidalRefreshBackoffForTests();
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test("an expired token is refreshed before probing instead of sending it to TIDAL", async () => {
  resetTidalRefreshBackoffForTests();
  fs.mkdirSync(path.dirname(TIDAL_AUTH_TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TIDAL_AUTH_TOKEN_FILE, JSON.stringify({ access_token: "old", refresh_token: "r", expires_at: 1 }));

  let refreshCalls = 0;
  const bearers: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/oauth2/token")) {
      refreshCalls += 1;
      return new Response(JSON.stringify({ access_token: "new", expires_in: 14_400 }), { status: 200 });
    }
    const session = sessionResponse(url);
    if (session) return session;
    bearers.push(String(new Headers(init?.headers).get("Authorization")));
    return new Response(JSON.stringify({ status: 404 }), { status: 404 });
  };
  try {
    assert.equal(await probeTidalVideoQuality("123"), null);
    assert.equal(refreshCalls, 1);
    assert.equal(bearers.includes("Bearer old"), false);
  } finally {
    globalThis.fetch = originalFetch;
    resetTidalRefreshBackoffForTests();
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});
