import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-tidal-probe-test-"));
process.env.DISCOGENIUS_CONFIG_DIR = configDir;

const { TIDAL_AUTH_TOKEN_FILE, resetTidalRefreshBackoffForTests } = await import("./tidal-auth.js");
const { probeTidalVideoQuality } = await import("./tidal-video-probe.js");

test("a 403/404 video probe never refreshes the TIDAL token", async () => {
  resetTidalRefreshBackoffForTests();
  fs.mkdirSync(path.dirname(TIDAL_AUTH_TOKEN_FILE), { recursive: true });
  // Expired by the clock: a refresh would be allowed if the probe asked for one.
  fs.writeFileSync(TIDAL_AUTH_TOKEN_FILE, JSON.stringify({ access_token: "a", refresh_token: "r", expires_at: 1 }));

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

test("a 401 video probe refreshes once and retries with the new token", async () => {
  resetTidalRefreshBackoffForTests();
  fs.mkdirSync(path.dirname(TIDAL_AUTH_TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TIDAL_AUTH_TOKEN_FILE, JSON.stringify({ access_token: "old", refresh_token: "r", expires_at: 1 }));

  let refreshCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/oauth2/token")) {
      refreshCalls += 1;
      return new Response(JSON.stringify({ access_token: "new", expires_in: 14_400 }), { status: 200 });
    }
    if (url.endsWith("/sessions")) return new Response(JSON.stringify({ userId: 1, countryCode: "NL" }), { status: 200 });
    if (url.includes("/users/")) return new Response("{}", { status: 200 });
    const auth = new Headers(init?.headers).get("Authorization");
    if (auth === "Bearer old") return new Response("{}", { status: 401 });
    return new Response(JSON.stringify({ status: 404 }), { status: 404 });
  };
  try {
    assert.equal(await probeTidalVideoQuality("123"), null);
    assert.equal(refreshCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    resetTidalRefreshBackoffForTests();
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});
