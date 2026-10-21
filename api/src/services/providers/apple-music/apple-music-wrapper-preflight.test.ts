import "./setup-test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";

import { ensureAppleWrapperReadyForDownload, type AppleMusicDownloaderCapabilitySnapshot } from "./apple-music-backend.js";
import { ProviderAuthError } from "../provider-auth-error.js";

function snap(portsOpen: boolean): AppleMusicDownloaderCapabilitySnapshot {
  return {
    authenticated: true, downloaderBinary: "amd", downloaderBinaryAvailable: true, mp4BoxAvailable: true,
    mp4DecryptAvailable: true, wrapperDecryptPortOpen: portsOpen, wrapperM3u8PortOpen: portsOpen,
    downloaderConfigExists: true, downloaderWorkingDirectory: "/tmp",
  };
}
const fast = { initialTimeoutMs: 1, restartTimeoutMs: 30, pollMs: 1 };

test("open ports: no restart requested", async () => {
  let restarts = 0;
  await ensureAppleWrapperReadyForDownload({ ...fast, readSnapshot: async () => snap(true), requestRestart: () => (restarts++, true) });
  assert.equal(restarts, 0);
});

test("hung wrapper: restart requested, then proceeds once ports answer", async () => {
  let restarted = false;
  const result = await ensureAppleWrapperReadyForDownload({
    ...fast, readSnapshot: async () => snap(restarted), requestRestart: () => (restarted = true),
  });
  assert.equal(result.wrapperDecryptPortOpen, true);
});

test("still down after restart: provider hold instead of a per-album failure", async () => {
  await assert.rejects(
    ensureAppleWrapperReadyForDownload({ ...fast, readSnapshot: async () => snap(false), requestRestart: () => true }),
    (error: unknown) => error instanceof ProviderAuthError && error.provider === "apple-music" && error.code === "wrapper_unreachable",
  );
});
