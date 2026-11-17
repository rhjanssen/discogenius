import "./setup-test-env.js";
import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";

import {
  runAppleWrapperHoldProbe,
  reconcileWrapperLoginStatus,
  probeAppleWrapperHealth,
  resetAppleWrapperRestartState,
  getAppleWrapperRestartState,
  calculateWrapperRestartBackoffMs,
  APPLE_WRAPPER_STUCK_MESSAGE,
} from "./apple-music-auth.js";
import { providerAuthCopy } from "../provider-auth-state.js";

beforeEach(() => {
  resetAppleWrapperRestartState();
});

test("hold probe: no wrapper check while Apple is not held", async () => {
  let checks = 0;
  const result = await runAppleWrapperHoldProbe({ needsReauth: () => false, loginStatus: async () => (checks++, { status: "success", message: "" }) });
  assert.equal(result, "idle");
  assert.equal(checks, 0);
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
    loginStatus: async () => ({ status: "failed", message: "Sign In: Invalid CKC" }),
    hasSession: () => true,
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
    loginStatus: async () => ({ status: "failed", message: "ports 10020 not answering" }),
    hasSession: () => false,
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

  // Attempt 1: at t = 1,000,000
  let res = await probe(currentTime);
  assert.equal(res, "still_held");
  assert.equal(restarts, 1);
  assert.equal(getAppleWrapperRestartState().count, 1);
  assert.equal(recordedFailures.at(-1), APPLE_WRAPPER_STUCK_MESSAGE);

  // Before 5m elapses (e.g. 4m later): probe does NOT request restart
  currentTime += 4 * 60 * 1000;
  res = await probe(currentTime);
  assert.equal(res, "still_held");
  assert.equal(restarts, 1, "must not restart before backoff");

  // At 5m since last restart: probe re-requests restart (attempt 2)
  currentTime += 1 * 60 * 1000;
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
