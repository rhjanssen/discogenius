/**
 * A session entitlement has to reach the rows it changes.
 *
 * YouTube Music's 256 kbps tier is a Premium feature, so the same track is a
 * different expectation on a different login. The probe and its cache existed
 * before this and were simply never connected: the three places that persist
 * variants hold only a provider id, so `capabilities` was always empty and a
 * Premium account still stored Opus 128.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { expectedFactsForProviderTier } from "./audio-facts.js";
import {
  clearProviderSessionCapabilities,
  getProviderSessionCapabilities,
  publishProviderSessionCapabilities,
} from "./provider-session-capabilities.js";

test("an unpublished provider gets the base expectation", () => {
  clearProviderSessionCapabilities();
  assert.deepEqual(getProviderSessionCapabilities("youtube-music"), {});
  assert.deepEqual(getProviderSessionCapabilities(null), {});
  // Under-promising rather than over-promising.
  assert.equal(
    expectedFactsForProviderTier(
      "youtube-music", "stereo:lossy", getProviderSessionCapabilities("youtube-music"),
    )!.bitrateKbps,
    128,
  );
});

test("a published Premium session changes what a variant row expects", () => {
  clearProviderSessionCapabilities();
  publishProviderSessionCapabilities("youtube-music", { youtubePremium: true });
  assert.equal(
    expectedFactsForProviderTier(
      "youtube-music", "stereo:lossy", getProviderSessionCapabilities("youtube-music"),
    )!.bitrateKbps,
    256,
  );
});

test("the registry is keyed per provider and case-insensitively", () => {
  clearProviderSessionCapabilities();
  publishProviderSessionCapabilities("YouTube-Music", { youtubePremium: true });
  assert.deepEqual(getProviderSessionCapabilities("youtube-music"), { youtubePremium: true });
  // Publishing for one provider must not answer for another.
  assert.deepEqual(getProviderSessionCapabilities("tidal"), {});
});

test("clearing one provider leaves the others standing", () => {
  clearProviderSessionCapabilities();
  publishProviderSessionCapabilities("youtube-music", { youtubePremium: true });
  publishProviderSessionCapabilities("tidal", {});
  clearProviderSessionCapabilities("youtube-music");
  assert.deepEqual(getProviderSessionCapabilities("youtube-music"), {});
  assert.deepEqual(getProviderSessionCapabilities("tidal"), {});
});

test("losing Premium reverts the expectation", () => {
  // A re-probe after a downgrade must not leave the richer expectation behind.
  clearProviderSessionCapabilities();
  publishProviderSessionCapabilities("youtube-music", { youtubePremium: true });
  publishProviderSessionCapabilities("youtube-music", { youtubePremium: false });
  assert.equal(
    expectedFactsForProviderTier(
      "youtube-music", "stereo:lossy", getProviderSessionCapabilities("youtube-music"),
    )!.bitrateKbps,
    128,
  );
});
