import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after } from "node:test";
import test from "node:test";
import { prepareActiveSchemaEnv, closeActiveSchemaDb } from "../../../test-support/active-schema-fixture.js";
import type { DeezerGwFetchLike } from "./deezer-gw-api.js";

const { tempDir } = prepareActiveSchemaEnv("deezer-arl");
process.env.DISCOGENIUS_DEEZER_JITTER_MAX_MS = "0";
const dbModule = await import("../../../database.js");
dbModule.initDatabase();
const { DeezerProvider } = await import("./deezer-provider.js");
const { loadDeezerCredentials, saveDeezerCredentials } = await import("./deezer-auth.js");
const {
  probeDeezerBeforeDownloadBatch,
  resetDeezerAuthProbeForTests,
  runDeezerAuthProbe,
} = await import("./deezer-arl-health.js");
const {
  providerNeedsReauth,
  readProviderAuthPublic,
  recordProviderAuthOk,
  resetProviderAuthCacheForTests,
} = await import("../provider-auth-state.js");
const { ProviderAuthError } = await import("../provider-auth-error.js");
const { StreamripDeezerBackend, deezerDownloadJitterMs, renderStreamripConfig } = await import("./streamrip-backend.js");

after(() => closeActiveSchemaDb(dbModule, tempDir));

const VALID_ARL = "a".repeat(192);
const OTHER_ARL = "b".repeat(192);

function gwFetch(options: {
  userId: number;
  name?: string;
  plan?: string;
  country?: string;
  setCookie?: string;
  fail?: "network" | "bootstrap";
  onCall?: () => void;
}): DeezerGwFetchLike {
  return async (url) => {
    options.onCall?.();
    if (options.fail === "network") throw new TypeError("fetch failed");
    const method = new URL(url).searchParams.get("method") || "";
    if (method === "deezer.ping") {
      if (options.fail === "bootstrap") {
        return { ok: true, status: 200, async json() { return { results: {} }; } };
      }
      return { ok: true, status: 200, async json() { return { results: { SESSION: "sid" } }; } };
    }
    return {
      ok: true,
      status: 200,
      headers: options.setCookie ? { get: (name: string) => name.toLowerCase() === "set-cookie" ? options.setCookie! : null } : undefined,
      async json() {
        return {
          error: [],
          results: {
            checkForm: "token",
            USER: {
              USER_ID: options.userId,
              BLOG_NAME: options.name ?? "Robert",
              OFFER_NAME: options.plan ?? "HiFi",
              COUNTRY: options.country ?? "NL",
            },
          },
        };
      },
    };
  };
}

test("an ARL that is not 192 hex characters is rejected before any network call", async () => {
  let calls = 0;
  const provider = new DeezerProvider(undefined, gwFetch({ userId: 1, onCall: () => { calls += 1; } }));
  await assert.rejects(
    provider.saveCredentials({ arl: "not-an-arl" }),
    (error: unknown) => {
      assert.equal(error instanceof ProviderAuthError, true);
      assert.match((error as Error).message, /192 hex/);
      return true;
    },
  );
  assert.equal(calls, 0);
  assert.equal(loadDeezerCredentials(), null);
});

test("Deezer getUserData USER_ID 0 rejects the paste and a probe marks needs_reauth", async () => {
  resetProviderAuthCacheForTests();
  const provider = new DeezerProvider(undefined, gwFetch({ userId: 0 }));
  await assert.rejects(provider.saveCredentials({ arl: VALID_ARL }), /ongeldig of verlopen/);
  assert.equal(loadDeezerCredentials(), null);
  assert.equal(providerNeedsReauth("deezer"), true);

  saveDeezerCredentials({ arl: VALID_ARL });
  resetDeezerAuthProbeForTests();
  const outcome = await runDeezerAuthProbe(gwFetch({ userId: 0 }));
  assert.equal(outcome, "needs_reauth");
  assert.equal(providerNeedsReauth("deezer"), true);
  assert.equal(loadDeezerCredentials()?.arl, VALID_ARL);
});

test("a valid ARL save returns the account and marks the provider ok", async () => {
  resetProviderAuthCacheForTests();
  const provider = new DeezerProvider(undefined, gwFetch({ userId: 42, name: "Robert", plan: "HiFi", country: "NL" }));
  await provider.saveCredentials({ arl: OTHER_ARL });
  const state = readProviderAuthPublic("deezer");
  assert.equal(state?.status, "ok");
  assert.equal(state?.accountLabel, "Robert · HiFi · NL");
  assert.equal(state?.credentialAgeDays, 0);
  const status = await provider.getAuthStatus();
  assert.equal(status.connected, true);
  assert.equal(status.user?.username, "Robert · HiFi · NL");
  assert.match(status.message || "", /Deezer gekoppeld: Robert · HiFi · NL/);
  assert.equal(loadDeezerCredentials()?.arl, OTHER_ARL);
  const rendered = renderStreamripConfig(OTHER_ARL);
  assert.match(rendered, /concurrency = false/);
  assert.match(rendered, /max_connections = 1/);
  assert.match(rendered, /requests_per_minute = 20/);
});

test("a Deezer network error does not flip auth state or replace the saved ARL", async () => {
  resetProviderAuthCacheForTests();
  resetDeezerAuthProbeForTests();
  const before = loadDeezerCredentials()?.arl;
  let calls = 0;
  const provider = new DeezerProvider(undefined, gwFetch({ userId: 1, fail: "network", onCall: () => { calls += 1; } }));
  await assert.rejects(provider.saveCredentials({ arl: VALID_ARL }), /niet bereikbaar/);
  assert.equal(calls, 1);
  assert.equal(loadDeezerCredentials()?.arl, before);
  assert.equal(providerNeedsReauth("deezer"), false);

  dbModule.db.prepare("UPDATE ProviderAuthState SET last_probe_at = NULL WHERE provider = 'deezer'").run();
  resetProviderAuthCacheForTests();
  resetDeezerAuthProbeForTests();
  let probeCalls = 0;
  const failing = gwFetch({ userId: 1, fail: "network", onCall: () => { probeCalls += 1; } });
  await probeDeezerBeforeDownloadBatch(failing);
  assert.equal(probeCalls, 1);
  assert.equal(providerNeedsReauth("deezer"), false);
  await probeDeezerBeforeDownloadBatch(failing);
  assert.equal(probeCalls, 1, "a failed probe backs off instead of running on the next tick");
});

test("a gw Set-Cookie arl is stored and never written to the log", async () => {
  resetProviderAuthCacheForTests();
  resetDeezerAuthProbeForTests();
  saveDeezerCredentials({ arl: VALID_ARL });
  const rotated = "c".repeat(192);
  const lines: string[] = [];
  const original = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  console.warn = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try {
    await runDeezerAuthProbe(gwFetch({
      userId: 7,
      name: "Robert",
      setCookie: `arl=${rotated}; Path=/; Domain=.deezer.com`,
    }));
  } finally {
    console.log = original;
    console.error = originalError;
    console.warn = originalWarn;
  }
  assert.equal(loadDeezerCredentials()?.arl, rotated);
  assert.equal(lines.some((line) => line.includes(rotated)), false);
  assert.equal(providerNeedsReauth("deezer"), false);
});

test("Streamrip authentication with no files is a provider auth error, and jitter can be disabled", async () => {
  assert.equal(deezerDownloadJitterMs(), 0);
  process.env.DISCOGENIUS_DEEZER_JITTER_MAX_MS = "2000";
  const sample = deezerDownloadJitterMs(() => 0);
  assert.equal(sample, 400);
  process.env.DISCOGENIUS_DEEZER_JITTER_MAX_MS = "0";
  saveDeezerCredentials({ arl: VALID_ARL });
  const backend = new StreamripDeezerBackend(async () => ({
    exitCode: 1,
    outputTail: "ERROR Invalid ARL",
    classifiedErrors: [{ kind: "authentication" as const, permanent: true, message: "ERROR Invalid ARL" }],
    producedFiles: [],
  }));
  await assert.rejects(
    backend.download({
      provider: "deezer",
      entityType: "album",
      providerId: "1",
      downloadPath: path.join(tempDir, "auth-fail"),
    }, { onProgress: () => undefined }),
    (error: unknown) => error instanceof ProviderAuthError && !String((error as Error).message).includes("Invalid ARL"),
  );
});

test("a recent Deezer probe is not repeated before the next batch", async () => {
  resetProviderAuthCacheForTests();
  resetDeezerAuthProbeForTests();
  await recordProviderAuthOk("deezer", { probedAt: new Date().toISOString() });
  let calls = 0;
  await probeDeezerBeforeDownloadBatch(gwFetch({ userId: 1, onCall: () => { calls += 1; } }));
  assert.equal(calls, 0);
});

void fs;
