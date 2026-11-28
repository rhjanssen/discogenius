import "./setup-test-env.js";
import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";

import {
  appleWrapperStartupProbeAction,
  runAppleWrapperHoldProbe,
  reconcileWrapperLoginStatus,
  probeAppleWrapperHealth,
  hasAttemptedWrapperRestart,
  resetAppleWrapperRestartState,
  getAppleWrapperRestartState,
  calculateWrapperRestartBackoffMs,
  APPLE_WRAPPER_STUCK_MESSAGE,
} from "./apple-music-auth.js";
import { providerAuthCopy } from "../provider-auth-state.js";

beforeEach(() => {
  resetAppleWrapperRestartState();
});

test("startup probe does not health-check a working Apple install while the sidecar is still binding", () => {
  assert.equal(appleWrapperStartupProbeAction(true, true, Date.now()), "hold");
  assert.equal(appleWrapperStartupProbeAction(false, true, Date.now()), "skip");
  assert.equal(appleWrapperStartupProbeAction(false, true, Date.now() + 120_000), "health");
  assert.equal(appleWrapperStartupProbeAction(false, false, Date.now() + 120_000), "skip");
});

test("hold probe: no wrapper check while Apple is not held", async () => {
  let checks = 0;
  const result = await runAppleWrapperHoldProbe({ needsReauth: () => false, loginStatus: async () => (checks++, { status: "success", message: "" }) });
  assert.equal(result, "idle");
  assert.equal(checks, 0);
});

test("hold probe: a stale stuck hold is cleared when the wrapper answers, without another restart", async () => {
  let restarts = 0;
  let cleared = false;
  const result = await runAppleWrapperHoldProbe({
    needsReauth: () => !cleared,
    portsOpen: async () => true,
    hasSession: () => true,
    requestRestart: () => (restarts++, true),
    recordOk: async () => { cleared = true; },
    readAuth: () => ({
      provider: "apple-music",
      status: "needs_reauth",
      since: "2026-11-28T00:10:48.000Z",
      lastOkAt: null,
      lastError: APPLE_WRAPPER_STUCK_MESSAGE,
      accountLabel: null,
      credentialSavedAt: null,
      credentialAgeDays: null,
      ageWarning: null,
      held: 544,
      banner: null,
      queueMessage: "Waiting for Apple Music wrapper restart",
      href: null,
      settingsLabel: null,
    }),
  });
  assert.equal(result, "cleared");
  assert.equal(cleared, true);
  assert.equal(restarts, 0);
});

test("hold probe: startup grace does not restart a wrapper that is still binding", async () => {
  let restarts = 0;
  const result = await runAppleWrapperHoldProbe({
    needsReauth: () => true,
    portsOpen: async () => false,
    loginStatus: async () => ({ status: "failed", message: "ports 10020, 20020 not answering" }),
    hasSession: () => true,
    now: () => Date.now(),
    requestRestart: () => (restarts++, true),
    readAuth: () => ({
      provider: "apple-music",
      status: "needs_reauth",
      since: "2026-11-28T00:10:48.000Z",
      lastOkAt: null,
      lastError: APPLE_WRAPPER_STUCK_MESSAGE,
      accountLabel: null,
      credentialSavedAt: null,
      credentialAgeDays: null,
      ageWarning: null,
      held: 544,
      banner: null,
      queueMessage: null,
      href: null,
      settingsLabel: null,
    }),
  });
  assert.equal(result, "still_held");
  assert.equal(restarts, 0);
});

test("hold probe: clears the hold once the wrapper answers", async () => {
  let held = true;
  const result = await runAppleWrapperHoldProbe({
    needsReauth: () => held,
    loginStatus: async () => { held = false; return { status: "success", message: "" }; },
  });
  assert.equal(result, "cleared");
  assert.equal(getAppleWrapperRestartState().count, 0);
});

test("hold probe: stays held while the wrapper is down", async () => {
  const result = await runAppleWrapperHoldProbe({
    needsReauth: () => true,
    loginStatus: async () => ({ status: "failed", message: "" }),
    hasSession: () => false,
  });
  assert.equal(result, "still_held");
});

test("calculateWrapperRestartBackoffMs backs off from 5m to 15m capped", () => {
  assert.equal(calculateWrapperRestartBackoffMs(0), 5 * 60 * 1000);
  assert.equal(calculateWrapperRestartBackoffMs(1), 5 * 60 * 1000);
  assert.equal(calculateWrapperRestartBackoffMs(2), 10 * 60 * 1000);
  assert.equal(calculateWrapperRestartBackoffMs(3), 15 * 60 * 1000);
  assert.equal(calculateWrapperRestartBackoffMs(10), 15 * 60 * 1000);
});

test("hold probe: does not request restart when held for expired session", async () => {
  let restarts = 0;
  const result = await runAppleWrapperHoldProbe({
    needsReauth: () => true,
    portsOpen: async () => false,
    loginStatus: async () => ({ status: "failed", message: "Sign In: Invalid CKC" }),
    hasSession: () => true,
    now: () => Date.now() + 120_000,
    readAuth: () => ({
      provider: "apple-music",
      status: "needs_reauth",
      since: null,
      lastOkAt: null,
      lastError: "Apple rejected a decryption request (Sign In / Invalid CKC)",
      accountLabel: null,
      credentialSavedAt: null,
      credentialAgeDays: null,
      ageWarning: null,
      held: 1,
      banner: null,
      queueMessage: null,
      href: null,
      settingsLabel: null,
    }),
    requestRestart: () => (restarts++, true),
  });
  assert.equal(result, "still_held");
  assert.equal(restarts, 0, "must not restart for expired session");
});

test("hold probe: does not request restart when session marker does not exist", async () => {
  let restarts = 0;
  const result = await runAppleWrapperHoldProbe({
    needsReauth: () => true,
    portsOpen: async () => false,
    loginStatus: async () => ({ status: "failed", message: "ports 10020 not answering" }),
    hasSession: () => false,
    now: () => Date.now() + 120_000,
    requestRestart: () => (restarts++, true),
  });
  assert.equal(result, "still_held");
  assert.equal(restarts, 0, "must not restart when session marker is missing");
});

test("hold probe: re-requests restart with backoff when wrapper is unreachable and session exists", async () => {
  let restarts = 0;
  const recordedFailures: string[] = [];
  let currentTime = 1_000_000;
  let held = true;

  const probe = (now: number) => runAppleWrapperHoldProbe({
    needsReauth: () => held,
    loginStatus: async () => ({ status: "failed", message: "ports 10020 not answering" }),
    hasSession: () => true,
    now: () => now,
    requestRestart: () => (restarts++, true),
    recordFailure: async (_provider, msg) => { recordedFailures.push(msg); },
    readAuth: () => ({
      provider: "apple-music",
      status: "needs_reauth",
      since: null,
      lastOkAt: null,
      lastError: recordedFailures.at(-1) ?? "ports 10020 not answering",
      accountLabel: null,
      credentialSavedAt: null,
      credentialAgeDays: null,
      ageWarning: null,
      held: 2,
      banner: null,
      queueMessage: null,
      href: null,
      settingsLabel: null,
    }),
  });

  // Attempt 1: at t = 1,000,000 requests restart, but does not record stuck message yet (not premature)
  let res = await probe(currentTime);
  assert.equal(res, "still_held");
  assert.equal(restarts, 1);
  assert.equal(getAppleWrapperRestartState().count, 1);
  assert.equal(recordedFailures.length, 0, "stuck message must not appear immediately on first restart request");

  // Next probe 2m later (before 5m backoff): wrapper still down, previous restart didn't help -> records stuck message
  currentTime += 2 * 60 * 1000;
  res = await probe(currentTime);
  assert.equal(res, "still_held");
  assert.equal(restarts, 1, "must not restart before backoff");
  assert.equal(recordedFailures.at(-1), APPLE_WRAPPER_STUCK_MESSAGE, "stuck message recorded at next probe when previous restart didn't help");

  // At 5m since last restart (3m after previous probe): probe re-requests restart (attempt 2)
  currentTime += 3 * 60 * 1000;
  res = await probe(currentTime);
  assert.equal(res, "still_held");
  assert.equal(restarts, 2);
  assert.equal(getAppleWrapperRestartState().count, 2);

  // Before 10m elapses (e.g. 5m later): probe does NOT request restart
  currentTime += 5 * 60 * 1000;
  res = await probe(currentTime);
  assert.equal(res, "still_held");
  assert.equal(restarts, 2, "must not restart before 10m backoff");

  // At 10m since last restart: probe re-requests restart (attempt 3)
  currentTime += 5 * 60 * 1000;
  res = await probe(currentTime);
  assert.equal(res, "still_held");
  assert.equal(restarts, 3);
  assert.equal(getAppleWrapperRestartState().count, 3);

  // Next backoff is 15m (capped). 15m later: probe re-requests restart (attempt 4)
  currentTime += 15 * 60 * 1000;
  res = await probe(currentTime);
  assert.equal(res, "still_held");
  assert.equal(restarts, 4);
  assert.equal(getAppleWrapperRestartState().count, 4);

  // Wrapper comes back up: clear hold and reset restart backoff
  res = await runAppleWrapperHoldProbe({
    needsReauth: () => held,
    loginStatus: async () => { held = false; return { status: "success", message: "" }; },
  });
  assert.equal(res, "cleared");
  assert.equal(getAppleWrapperRestartState().count, 0, "restart count must reset to 0 after recovery");
});

test("reconcileWrapperLoginStatus: returns stuck message when session marker exists and restart was attempted", () => {
  const result = reconcileWrapperLoginStatus(
    { status: "success", message: "Saved session active" },
    {
      decryptPortOpen: false,
      m3u8PortOpen: false,
      successAgeMs: 20_000,
      hasSession: true,
      restartAttempted: true,
    },
  );
  assert.equal(result.status, "failed");
  assert.equal(result.message, APPLE_WRAPPER_STUCK_MESSAGE);
  assert.doesNotMatch(result.message, /re-authenticate/i);
});

test("probeAppleWrapperHealth: returns stuck message when session marker exists and restart was attempted", async () => {
  const probe = await probeAppleWrapperHealth({
    hasToken: () => true,
    checkPort: async () => false,
    hasSession: () => true,
    restartAttempted: () => true,
  });
  assert.equal(probe.ok, false);
  assert.equal(probe.status, "needs_reauth");
  assert.equal(probe.message, APPLE_WRAPPER_STUCK_MESSAGE);
  assert.doesNotMatch(probe.message, /re-authenticate/i);
});

test("providerAuthCopy: shows stuck message in banner without re-auth suggestion", () => {
  const copy = providerAuthCopy("apple-music", APPLE_WRAPPER_STUCK_MESSAGE);
  assert.equal(copy.banner, APPLE_WRAPPER_STUCK_MESSAGE);
  assert.doesNotMatch(copy.banner, /re-authenticate/i);
  assert.doesNotMatch(copy.settingsLabel, /re-authenticate/i);
});

test("restart state derivation: hasAttemptedWrapperRestart, reconcileWrapperLoginStatus, and probeAppleWrapperHealth derive from authRow without in-memory state", async () => {
  resetAppleWrapperRestartState();
  assert.equal(getAppleWrapperRestartState().count, 0, "in-memory state is 0");

  const unattemptedRow = {
    provider: "apple-music",
    status: "needs_reauth" as const,
    since: null,
    lastOkAt: null,
    lastError: "ports 10020 not answering",
    accountLabel: null,
    credentialSavedAt: null,
    credentialAgeDays: null,
    ageWarning: null,
    held: 1,
    banner: null,
    queueMessage: null,
    href: null,
    settingsLabel: null,
  };

  const stuckRow = {
    ...unattemptedRow,
    lastError: APPLE_WRAPPER_STUCK_MESSAGE,
  };

  // 1. hasAttemptedWrapperRestart derives from authRow
  assert.equal(hasAttemptedWrapperRestart(unattemptedRow), false);
  assert.equal(hasAttemptedWrapperRestart(stuckRow), true);

  // 2. reconcileWrapperLoginStatus derives from authRow
  const reconciledUnattempted = reconcileWrapperLoginStatus(
    { status: "success", message: "Saved session active" },
    {
      decryptPortOpen: false,
      m3u8PortOpen: false,
      successAgeMs: 20_000,
      hasSession: true,
      authRow: unattemptedRow,
    },
  );
  assert.match(reconciledUnattempted.message, /docker compose up -d apple-music-wrapper/);
  assert.doesNotMatch(reconciledUnattempted.message, /stuck/i);

  const reconciledStuck = reconcileWrapperLoginStatus(
    { status: "success", message: "Saved session active" },
    {
      decryptPortOpen: false,
      m3u8PortOpen: false,
      successAgeMs: 20_000,
      hasSession: true,
      authRow: stuckRow,
    },
  );
  assert.equal(reconciledStuck.message, APPLE_WRAPPER_STUCK_MESSAGE);

  // 3. probeAppleWrapperHealth derives from readAuth without in-memory state
  const probeUnattempted = await probeAppleWrapperHealth({
    hasToken: () => true,
    checkPort: async () => false,
    hasSession: () => true,
    readAuth: () => unattemptedRow,
  });
  assert.match(probeUnattempted.message, /docker compose up -d apple-music-wrapper/);

  const probeStuck = await probeAppleWrapperHealth({
    hasToken: () => true,
    checkPort: async () => false,
    hasSession: () => true,
    readAuth: () => stuckRow,
  });
  assert.equal(probeStuck.message, APPLE_WRAPPER_STUCK_MESSAGE);
});

test("hold probe: does not request restart or overwrite error when login_status.json reports session failure even if authRow has unreachable error", async () => {
  let restarts = 0;
  const recordedFailures: string[] = [];

  const result = await runAppleWrapperHoldProbe({
    needsReauth: () => true,
    loginStatus: async () => ({
      status: "failed",
      message: "Apple rejected a decryption request (Sign-In/CKC). If downloads keep failing, re-authenticate from the Auth page.",
    }),
    hasSession: () => true,
    readAuth: () => ({
      provider: "apple-music",
      status: "needs_reauth",
      since: null,
      lastOkAt: null,
      lastError: "Apple Music decryption wrapper is unreachable (ports 10020 not answering)",
      accountLabel: null,
      credentialSavedAt: null,
      credentialAgeDays: null,
      ageWarning: null,
      held: 1,
      banner: null,
      queueMessage: null,
      href: null,
      settingsLabel: null,
    }),
    requestRestart: () => (restarts++, true),
    recordFailure: async (_provider, msg) => { recordedFailures.push(msg); },
  });

  assert.equal(result, "still_held");
  assert.equal(restarts, 0, "must not restart when wrapper reports session/login failure");
  assert.equal(recordedFailures.length, 0, "must not overwrite error with stuck message");
});

test("hold probe: crash-loop or unreachable in login_status.json is not treated as a session failure and allows restart", async () => {
  let restarts = 0;
  const result = await runAppleWrapperHoldProbe({
    needsReauth: () => true,
    portsOpen: async () => false,
    now: () => Date.now() + 120_000,
    loginStatus: async () => ({
      status: "failed",
      message: "Decryption server is crash-looping. Restart the wrapper container (docker compose restart apple-music-wrapper).",
    }),
    hasSession: () => true,
    readAuth: () => ({
      provider: "apple-music",
      status: "needs_reauth",
      since: null,
      lastOkAt: null,
      lastError: "Decryption server is crash-looping",
      accountLabel: null,
      credentialSavedAt: null,
      credentialAgeDays: null,
      ageWarning: null,
      held: 1,
      banner: null,
      queueMessage: null,
      href: null,
      settingsLabel: null,
    }),
    requestRestart: () => (restarts++, true),
  });

  assert.equal(result, "still_held");
  assert.equal(restarts, 1, "should restart for crash-looping status when session exists");
});
