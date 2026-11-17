import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { after, test } from "node:test";
import { prepareActiveSchemaEnv, closeActiveSchemaDb } from "../../../test-support/active-schema-fixture.js";

const { tempDir } = prepareActiveSchemaEnv("apple-hold");
const dbModule = await import("../../../database.js");
dbModule.initDatabase();

const { DownloadWaitQueue } = await import("../../download/download-wait-queue.js");
const auth = await import("../provider-auth-state.js");
const healthModule = await import("../../commands/health.js");
const {
  probeAppleWrapperHealth,
  runAppleWrapperHoldProbe,
  handleAppleDecryptFailure,
  handleAppleDecryptSuccess,
  resetAppleDecryptFailuresForTests,
  saveStoredAppleMusicToken,
  clearStoredAppleMusicToken,
} = await import("./apple-music-auth.js");
const {
  AppleMusicBackend,
  describeAppleDownloaderFailure,
  isAppleDecryptFailure,
  isAppleSessionFailure,
  isAppleTruncatedSegmentError,
  isAppleUnavailableTrackError,
} = await import("./apple-music-backend.js");
const { ProviderAuthError, errorIndicatesProviderAuth } = await import("../provider-auth-error.js");
const { executeWithSameOfferRetries, classifyDownloadFailure } = await import("../../download/download-failure-policy.js");

after(() => {
  clearStoredAppleMusicToken();
  closeActiveSchemaDb(dbModule, tempDir);
});

function enqueueAppleJob(providerId: string, title: string, type: "album" | "track" = "album"): number {
  const queued = DownloadWaitQueue.enqueue({
    refKey: providerId,
    mediaKind: type,
    commandName: type === "album" ? "DownloadAlbum" : "DownloadTrack",
    provider: "apple-music",
    providerId,
    title,
    artist: "Artist",
    payload: { provider: "apple-music", providerId, title, type },
    position: "back",
    notify: false,
  });
  return queued.id;
}

test("apple-music decryption failure pattern recognizes wrapper errors", () => {
  assert.equal(isAppleDecryptFailure("Decrypting... Failed to run v2: decrypt: connection refused"), true);
  assert.equal(isAppleDecryptFailure("apple-music-downloader exited with code null: Decrypting... Failed to run v2: decrypt…"), true);
  assert.equal(isAppleDecryptFailure("Error reading response from device: EOF"), true);
  assert.equal(isAppleDecryptFailure("Failed to run v2: decrypt"), true);
  assert.equal(isAppleDecryptFailure("decryption wrapper port 10020"), true);
  assert.equal(isAppleDecryptFailure("track not available in catalog"), false);

  const desc = describeAppleDownloaderFailure(null, "Decrypting... Failed to run v2: decrypt…");
  assert.match(desc, /Apple Music decryption failed because the wrapper session expired/);
  assert.match(desc, /Failed to run v2: decrypt/);
});

test("wrapper unreachable sets Apple to non-ok, holds jobs, and reports in /api/health issues", async () => {
  // Ensure token is stored so Apple Music is considered configured
  saveStoredAppleMusicToken({ media_user_token: "test-user-token" });
  await auth.recordProviderAuthOk("apple-music", { force: true });
  assert.equal(auth.providerNeedsReauth("apple-music"), false);

  const albumWaitId = enqueueAppleJob("1440904699", "Blondie Greatest Hits");
  const trackWaitId = enqueueAppleJob("1440904918", "One Way Or Another", "track");

  // Probe wrapper with simulated unreachable ports
  const probe = await probeAppleWrapperHealth({
    checkPort: async () => false,
    hasToken: () => true,
  });

  assert.equal(probe.ok, false);
  assert.equal(probe.status, "needs_reauth");
  assert.match(probe.message, /Apple Music decryption wrapper is unreachable/);
  assert.equal(auth.providerNeedsReauth("apple-music"), true);

  // /api/health lists it under issues
  const snapshot = healthModule.collectHealthDiagnosticsSnapshot();
  const issue = snapshot.issues.find((item) => item.scope === "providers.auth");
  assert.ok(issue, "Expected providers.auth in issues");
  assert.equal(issue.status, "warning");
  assert.match(issue.message, /Apple Music decryption wrapper is unreachable/);

  const appleRow = snapshot.providerAuth.find((p) => p.provider === "apple-music");
  assert.ok(appleRow);
  assert.equal(appleRow.status, "needs_reauth");
  assert.match(appleRow.lastError || "", /wrapper is unreachable/);
  assert.equal(appleRow.held, 2);

  // Jobs are held and cannot be claimed
  const claimed = DownloadWaitQueue.claimNextPage();
  assert.equal(claimed.claimed, null);

  const heldRow = dbModule.db.prepare("SELECT payload FROM DownloadQueue WHERE id = ?").get(albumWaitId) as { payload: string };
  assert.match(heldRow.payload, /Waiting for the Apple Music decryption wrapper/);
});

test("recovery when wrapper answers again clears hold, updates lastOkAt, and resumes Apple downloads", async () => {
  assert.equal(auth.providerNeedsReauth("apple-music"), true);
  const rowBefore = auth.readProviderAuthPublic("apple-music");
  const lastOkBefore = rowBefore?.lastOkAt;

  // Simulate a moment passing so timestamp advances
  await new Promise((r) => setTimeout(r, 10));

  // Probe wrapper with reachable ports
  const probe = await probeAppleWrapperHealth({
    checkPort: async () => true,
    hasToken: () => true,
  });

  assert.equal(probe.ok, true);
  assert.equal(probe.status, "ok");
  assert.equal(auth.providerNeedsReauth("apple-music"), false);

  const rowAfter = auth.readProviderAuthPublic("apple-music");
  assert.equal(rowAfter?.status, "ok");
  assert.equal(rowAfter?.lastError, null);
  assert.ok(rowAfter?.lastOkAt);
  if (lastOkBefore) {
    assert.notEqual(rowAfter?.lastOkAt, lastOkBefore);
  }

  // Held payload is cleared and job can now be claimed
  const claimed = DownloadWaitQueue.claimNextPage();
  assert.ok(claimed.claimed);
  assert.equal(claimed.claimed.wait.provider, "apple-music");
  assert.equal(claimed.claimed.wait.ref_key, "1440904699");

  // Clean up claimed job
  dbModule.db.prepare("DELETE FROM commands WHERE id = ?").run(claimed.claimed.commandId);
  dbModule.db.prepare("DELETE FROM DownloadQueue WHERE provider = 'apple-music'").run();
});

test("repeated decrypt failures in a short window set Apple to non-ok and hold jobs", async () => {
  resetAppleDecryptFailuresForTests();
  await auth.recordProviderAuthOk("apple-music", { force: true });
  assert.equal(auth.providerNeedsReauth("apple-music"), false);

  const waitId = enqueueAppleJob("2000000001", "Repeated Decrypt Fail Album");

  // 1st decrypt failure with ports answering (not yet reached threshold)
  await handleAppleDecryptFailure("Decrypting... Failed to run v2: decrypt: error 1", { portsOpen: true });
  assert.equal(auth.providerNeedsReauth("apple-music"), false);

  // 2nd decrypt failure within window -> triggers hold!
  await handleAppleDecryptFailure("Decrypting... Failed to run v2: decrypt: error 2", { portsOpen: true });
  assert.equal(auth.providerNeedsReauth("apple-music"), true);

  const row = auth.readProviderAuthPublic("apple-music");
  assert.equal(row?.status, "needs_reauth");
  assert.match(row?.lastError || "", /decryption failed repeatedly \(2 failures in 10m\)/);

  // Jobs are held
  const claimed = DownloadWaitQueue.claimNextPage();
  assert.equal(claimed.claimed, null);

  // Successful decrypt clears failures and marks auth ok
  await handleAppleDecryptSuccess();
  assert.equal(auth.providerNeedsReauth("apple-music"), false);

  dbModule.db.prepare("DELETE FROM DownloadQueue WHERE id = ?").run(waitId);
});

test("a decrypt failure does not use up same-offer retries and throws ProviderAuthError", async () => {
  let attempts = 0;
  const decryptError = new ProviderAuthError(
    "apple-music",
    "Apple Music decryption failed: Decrypting... Failed to run v2: decrypt: connection refused",
    "session_expired",
  );

  await assert.rejects(
    executeWithSameOfferRetries({ sleep: async () => {} }, async () => {
      attempts++;
      throw decryptError;
    }),
    (err: unknown) => {
      assert.ok(err instanceof ProviderAuthError);
      return true;
    },
  );

  // Must fail immediately on attempt 1 without burning retries
  assert.equal(attempts, 1);
});

test("a real per-track Unavailable is still handled as unavailable without holding the provider", async () => {
  await auth.recordProviderAuthOk("apple-music", { force: true });
  assert.equal(auth.providerNeedsReauth("apple-music"), false);

  const unavailableLine = "Failed to dl aac-lc: Unavailable";
  assert.equal(isAppleUnavailableTrackError(unavailableLine), true);
  assert.equal(isAppleDecryptFailure(unavailableLine), false);

  // Provider stays ok
  assert.equal(auth.providerNeedsReauth("apple-music"), false);
});

function createMockChildProcess(stdoutLines: string[], exitCode: number | null) {
  const cp = new EventEmitter() as any;
  cp.stdout = new PassThrough();
  cp.stderr = new PassThrough();
  cp.kill = () => {};
  queueMicrotask(() => {
    for (const line of stdoutLines) {
      cp.stdout.write(line + "\n");
    }
    cp.stdout.end();
    cp.stderr.end();
    cp.emit("close", exitCode);
  });
  return cp;
}

test("Apple downloader backend rejects with ProviderAuthError on 'Failed to run v2: decrypt'", async () => {
  const decryptErrorLines = [
    "Track 1 of 1: songs",
    "1440904918",
    "Decrypting... Failed to run v2: decrypt: dial tcp 127.0.0.1:10020: connect: connection refused",
    "Error detected, exiting...",
  ];
  const testDownloadDir = fs.mkdtempSync(path.join(os.tmpdir(), "apple-dl-v2-test-"));

  const backend = new AppleMusicBackend({
    preflight: async () => {},
    spawn: () => createMockChildProcess(decryptErrorLines, null),
    recordUnavailableTrack: () => {},
    countMediaFiles: () => 0,
    loadToken: () => ({ media_user_token: "test-token" }),
    syncToken: () => {},
  });

  await assert.rejects(
    () => backend.download(
      {
        provider: "apple-music",
        entityType: "album",
        providerId: "1440904699",
        downloadPath: testDownloadDir,
      },
      { onProgress: () => {} },
    ),
    (err: any) => {
      assert.ok(err instanceof ProviderAuthError);
      assert.equal(err.provider, "apple-music");
      assert.equal(err.code, "wrapper_unreachable");
      assert.match(err.message, /Apple Music decryption wrapper is not answering/);
      assert.doesNotMatch(err.message, /re-authenticate/i);
      assert.match(err.message, /Failed to run v2: decrypt/);
      return true;
    },
  );
});

test("Apple downloader single track rejects with ProviderAuthError on 'Failed to run v2: decrypt'", async () => {
  const decryptErrorLines = [
    "1440904918",
    "Decrypting... Failed to run v2: decrypt: dial tcp 127.0.0.1:10020: connect: connection refused",
    "Error detected, exiting...",
  ];
  const testDownloadDir = fs.mkdtempSync(path.join(os.tmpdir(), "apple-dl-v2-track-"));

  const backend = new AppleMusicBackend({
    preflight: async () => {},
    spawn: () => createMockChildProcess(decryptErrorLines, null),
    recordUnavailableTrack: () => {},
    countMediaFiles: () => 0,
    loadToken: () => ({ media_user_token: "test-token" }),
    syncToken: () => {},
  });

  await assert.rejects(
    () => backend.download(
      {
        provider: "apple-music",
        entityType: "track",
        providerId: "1440904918",
        downloadPath: testDownloadDir,
      },
      { onProgress: () => {} },
    ),
    (err: any) => {
      assert.ok(err instanceof ProviderAuthError);
      assert.equal(err.provider, "apple-music");
      assert.match(err.message, /Failed to run v2: decrypt/);
      return true;
    },
  );
});

test("truncated segment errors ('decode mdat', 'does not match expected length', 'unexpected EOF') are classified as transient and not auth failures (#144)", () => {
  const realMessage1 = "Decrypting...  13%  (4.7/36 MB) Failed to run v2: decode mdat pos 4718142: read box body length 3145728 does not match expected length 1421683";
  const realMessage2 = "decode mdat pos 17063423: read box body length 2097152 does not match expected length 1048576";
  const realMessage2Short = "decode mdat pos 17063423 ...";
  const unexpectedEofMessage = "Failed to run v2: decode mdat: unexpected EOF";

  for (const msg of [realMessage1, realMessage2, realMessage2Short, unexpectedEofMessage]) {
    assert.equal(isAppleTruncatedSegmentError(msg), true, `should recognize as truncated segment: ${msg}`);
    assert.equal(isAppleDecryptFailure(msg), false, `should not be decrypt failure: ${msg}`);
    assert.equal(isAppleSessionFailure(msg), false, `should not be session failure: ${msg}`);
    assert.equal(errorIndicatesProviderAuth(msg), false, `should not indicate provider auth: ${msg}`);
    assert.equal(classifyDownloadFailure(new Error(msg)), "transient", `should be classified transient: ${msg}`);

    const desc = describeAppleDownloaderFailure(1, msg);
    assert.match(desc, /exited with code 1/);
    assert.doesNotMatch(desc, /re-authenticate/i);
    assert.doesNotMatch(desc, /session expired/i);
  }
});

test("downloader with real truncated-segment error does not trigger an auth hold and retries on same offer (#144)", async () => {
  await auth.recordProviderAuthOk("apple-music", { force: true });
  assert.equal(auth.providerNeedsReauth("apple-music"), false);

  const realErrorLines = [
    "Track 1 of 1: songs",
    "1440904918",
    "Decrypting...  13%  (4.7/36 MB) Failed to run v2: decode mdat pos 4718142: read box body length 3145728 does not match expected length 1421683",
    "Error detected, exiting...",
  ];
  const testDownloadDir = fs.mkdtempSync(path.join(os.tmpdir(), "apple-dl-mdat-test-"));

  let callCount = 0;
  const backend = new AppleMusicBackend({
    preflight: async () => {},
    spawn: () => {
      callCount++;
      return createMockChildProcess(realErrorLines, 1);
    },
    recordUnavailableTrack: () => {},
    countMediaFiles: () => 0,
    loadToken: () => ({ media_user_token: "test-token" }),
    syncToken: () => {},
  });

  // Direct backend call rejects with a regular Error, NOT ProviderAuthError
  await assert.rejects(
    () => backend.download(
      {
        provider: "apple-music",
        entityType: "album",
        providerId: "1440904699",
        downloadPath: testDownloadDir,
      },
      { onProgress: () => {} },
    ),
    (err: any) => {
      assert.equal(err instanceof ProviderAuthError, false, "Must not throw ProviderAuthError");
      assert.match(err.message, /decode mdat/);
      assert.match(err.message, /does not match expected length/);
      assert.doesNotMatch(err.message, /re-authenticate/i);
      return true;
    },
  );

  // Apple Music must NOT be held
  assert.equal(auth.providerNeedsReauth("apple-music"), false, "Must not put Apple Music on hold");

  // Inside executeWithSameOfferRetries: first attempt fails with truncated error, second succeeds
  let attempt = 0;
  const retryResult = await executeWithSameOfferRetries(
    { sleep: async () => {} },
    async () => {
      attempt++;
      if (attempt === 1) {
        throw new Error(realErrorLines[2]);
      }
      return "download-success";
    },
  );

  assert.equal(attempt, 2, "Should have retried the same offer");
  assert.equal(retryResult, "download-success");
  assert.equal(auth.providerNeedsReauth("apple-music"), false);
});

test("second real message 'decode mdat pos 17063423' retries on same offer without auth hold (#144)", async () => {
  await auth.recordProviderAuthOk("apple-music", { force: true });
  assert.equal(auth.providerNeedsReauth("apple-music"), false);

  const realErrorLines = [
    "Track 1 of 1: songs",
    "1440904918",
    "decode mdat pos 17063423: read box body length 2097152 does not match expected length 1048576",
    "Error detected, exiting...",
  ];
  const testDownloadDir = fs.mkdtempSync(path.join(os.tmpdir(), "apple-dl-mdat2-test-"));

  const backend = new AppleMusicBackend({
    preflight: async () => {},
    spawn: () => createMockChildProcess(realErrorLines, 1),
    recordUnavailableTrack: () => {},
    countMediaFiles: () => 0,
    loadToken: () => ({ media_user_token: "test-token" }),
    syncToken: () => {},
  });

  await assert.rejects(
    () => backend.download(
      {
        provider: "apple-music",
        entityType: "album",
        providerId: "1440904699",
        downloadPath: testDownloadDir,
      },
      { onProgress: () => {} },
    ),
    (err: any) => {
      assert.equal(err instanceof ProviderAuthError, false);
      assert.match(err.message, /decode mdat pos 17063423/);
      assert.doesNotMatch(err.message, /re-authenticate/i);
      return true;
    },
  );

  assert.equal(auth.providerNeedsReauth("apple-music"), false);
});

test("single real decrypt failure with ports answering and no session error does not trigger an auth hold (#144)", async () => {
  resetAppleDecryptFailuresForTests();
  await auth.recordProviderAuthOk("apple-music", { force: true });
  assert.equal(auth.providerNeedsReauth("apple-music"), false);

  // 1st decrypt failure with ports open and no wrapper log session error
  const result = await handleAppleDecryptFailure("Decrypting... Failed to run v2: decrypt: internal cipher error", {
    portsOpen: true,
    hasSessionError: false,
  });

  assert.equal(result.held, false);
  assert.equal(auth.providerNeedsReauth("apple-music"), false, "Single decrypt error with ports open must not trigger hold");
});

test("real decrypt failure with wrapper log Sign-In/CKC error triggers auth hold with re-authenticate message (#144)", async () => {
  resetAppleDecryptFailuresForTests();
  await auth.recordProviderAuthOk("apple-music", { force: true });
  assert.equal(auth.providerNeedsReauth("apple-music"), false);

  const result = await handleAppleDecryptFailure("Decrypting... Failed to run v2: decrypt: auth error", {
    portsOpen: true,
    hasSessionError: true,
  });

  assert.equal(result.held, true);
  assert.equal(result.code, "session_expired");
  assert.match(result.reason || "", /re-authenticate/i);
  assert.equal(auth.providerNeedsReauth("apple-music"), true);

  const authRow = auth.readProviderAuthPublic("apple-music");
  assert.match(authRow?.lastError || "", /re-authenticate/i);

  // Reset
  await auth.recordProviderAuthOk("apple-music", { force: true });
});

test("providerAuthCopy returns 'decryption wrapper not answering' for unreachable holds and 'Re-authenticate' only for session errors (#144)", () => {
  // 1. Unreachable wrapper hold
  const unreachableCopy = auth.providerAuthCopy("apple-music", "Apple Music decryption wrapper is not answering (ports 10020/20020 not answering)");
  assert.equal(unreachableCopy.banner, "Apple Music decryption wrapper is not answering");
  assert.doesNotMatch(unreachableCopy.banner, /re-authenticate/i);
  assert.equal(unreachableCopy.queueMessage, "Waiting for the Apple Music decryption wrapper");

  // 2. Restarting / default unreachable copy (no lastError or ports down)
  const defaultCopy = auth.providerAuthCopy("apple-music", null);
  assert.equal(defaultCopy.banner, "Apple Music decryption wrapper is not answering");
  assert.doesNotMatch(defaultCopy.banner, /re-authenticate/i);

  // 3. Real session problem
  const sessionCopy = auth.providerAuthCopy("apple-music", "Apple Music decryption failed because the wrapper session expired. Re-authenticate Apple Music from the Auth page.");
  assert.equal(sessionCopy.banner, "Re-authenticate Apple Music");
  assert.match(sessionCopy.banner, /re-authenticate/i);
  assert.equal(sessionCopy.queueMessage, "Waiting for Apple Music re-authentication");
});
