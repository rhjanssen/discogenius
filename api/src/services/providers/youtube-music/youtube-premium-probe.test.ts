/**
 * The entitlement is a property of the login, so it is probed once.
 *
 * Google gates YouTube Music's 256 kbps tier behind Premium, and that single
 * bit is the only thing that moves our expectation for a YouTube offer between
 * ~128 and ~256 kbps. Asking per track would be a request per track for
 * something that cannot vary between them.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { expectedFactsForProviderTier } from "../audio-facts.js";
import {
  getYouTubeSessionCapabilities,
  invalidateYouTubeSessionCapabilities,
  youtubePremiumForExpectations,
} from "./youtube-premium-probe.js";

const at = () => new Date("2026-08-07T00:00:00.000Z");

test("an unauthenticated session is never Premium and is never probed", async () => {
  invalidateYouTubeSessionCapabilities();
  // A binary that does not exist: reaching it at all would throw or hang.
  const capabilities = await getYouTubeSessionCapabilities({
    authenticated: false, binary: "definitely-not-a-real-binary", now: at,
  });
  assert.deepEqual(capabilities, {
    authenticated: false, premium: false, checkedAt: at().toISOString(),
  });
});

test("a probe that cannot run reports unknown rather than throwing", async () => {
  invalidateYouTubeSessionCapabilities();
  const capabilities = await getYouTubeSessionCapabilities({
    authenticated: true, binary: "definitely-not-a-real-binary", now: at,
  });
  assert.equal(capabilities.authenticated, true);
  assert.equal(capabilities.premium, null, "unknown, not false");
});

test("the result is cached until credentials change", async () => {
  invalidateYouTubeSessionCapabilities();
  const first = await getYouTubeSessionCapabilities({
    authenticated: false, binary: "x", now: at,
  });
  // A second call with different inputs must not re-probe.
  const second = await getYouTubeSessionCapabilities({
    authenticated: true, binary: "x", now: () => new Date("2030-01-01T00:00:00.000Z"),
  });
  assert.equal(second, first, "same object, so no second probe ran");

  invalidateYouTubeSessionCapabilities();
  const third = await getYouTubeSessionCapabilities({
    authenticated: false, binary: "x", now: at,
  });
  assert.notEqual(third, first, "invalidation forces a fresh probe");
});

test("an unknown entitlement under-promises rather than over-promises", () => {
  // Being wrong here should cost a pessimistic estimate, not a failed download.
  assert.equal(youtubePremiumForExpectations(null), false);
  assert.equal(
    youtubePremiumForExpectations({ authenticated: true, premium: null, checkedAt: "" }),
    false,
  );
  assert.equal(
    youtubePremiumForExpectations({ authenticated: true, premium: true, checkedAt: "" }),
    true,
  );
});

test("the flag is what moves the expected YouTube bitrate", () => {
  const expectationFor = (premium: boolean) => expectedFactsForProviderTier(
    "youtube-music", "stereo:lossy",
    { youtubePremium: youtubePremiumForExpectations({
      authenticated: true, premium, checkedAt: "",
    }) },
  );
  assert.equal(expectationFor(false)!.bitrateKbps, 128);
  assert.equal(expectationFor(true)!.bitrateKbps, 256);
  // Opus either way: yt-dlp prefers it wherever YouTube offers it.
  assert.equal(expectationFor(false)!.codec, "opus");
  assert.equal(expectationFor(true)!.codec, "opus");
});
