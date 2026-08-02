import assert from "node:assert/strict";
import test from "node:test";
import {
  decideImportedQuality,
  parseQualityProfile,
} from "./quality-profile-policy.js";

function profile(overrides: Partial<Parameters<typeof parseQualityProfile>[0]> = {}) {
  return parseQualityProfile({
    id: 1,
    name: "High Quality",
    allowed_source_formats: JSON.stringify(["lossless", "hires-lossless"]),
    preference_order: JSON.stringify(["hires-lossless", "lossless"]),
    cutoff: "lossless",
    continue_upgrades: 0,
    fallback_policy: "best_allowed",
    output_format: JSON.stringify({
      codec: "flac",
      lossless: true,
      bitDepth: 16,
      sampleRate: 44_100,
    }),
    transcode_policy: "downconvert_hires",
    ...overrides,
  });
}

test("HIGH accepts a hi-res source but records a 16/44.1 lossless import", () => {
  assert.deepEqual(
    decideImportedQuality(profile(), {
      quality: "hires-lossless",
      codec: "flac",
      bitDepth: 24,
      sampleRate: 96_000,
    }),
    {
      accepted: true,
      transcode: true,
      reason: "source is converted to the profile output",
      sourceQuality: "hires-lossless",
      importedQuality: "lossless",
      output: {
        codec: "flac",
        lossless: true,
        bitDepth: 16,
        sampleRate: 44_100,
        bitrate: null,
        spatial: false,
      },
    },
  );
});

test("MAX preserves hi-res and never invents technical facts", () => {
  const max = profile({
    name: "Max Quality",
    cutoff: "hires-lossless",
    continue_upgrades: 1,
    output_format: JSON.stringify({ codec: "preserve", lossless: true }),
    transcode_policy: "preserve",
  });
  const decision = decideImportedQuality(max, { quality: "hires-lossless" });
  assert.equal(decision.accepted, true);
  assert.equal(decision.transcode, false);
  assert.equal(decision.importedQuality, "hires-lossless");
});

test("lossy input on a Max/High-style profile is accepted as lossy, never labelled lossless", () => {
  const maxWithFallback = profile({
    name: "Max Quality",
    allowed_source_formats: JSON.stringify(["hires-lossless", "lossless", "lossy"]),
    preference_order: JSON.stringify(["hires-lossless", "lossless", "lossy"]),
    cutoff: "hires-lossless",
    continue_upgrades: 1,
    output_format: JSON.stringify({ codec: "preserve", lossless: true }),
    transcode_policy: "preserve",
  });
  const decision = decideImportedQuality(maxWithFallback, { quality: "lossy", codec: "mp3" });
  assert.equal(decision.accepted, true);
  assert.equal(decision.transcode, false);
  assert.equal(decision.importedQuality, "lossy");
  assert.equal(decision.output?.lossless, false);
  assert.match(decision.reason, /cannot be upscaled/);
});

test("NORMAL can transcode a lossless source to an actual lossy output", () => {
  const normal = profile({
    name: "Normal Quality",
    allowed_source_formats: JSON.stringify(["lossy", "lossless", "hires-lossless"]),
    preference_order: JSON.stringify(["lossless", "hires-lossless", "lossy"]),
    cutoff: "lossy",
    output_format: JSON.stringify({ codec: "mp3", lossless: false, bitrate: 320_000 }),
    transcode_policy: "transcode_allowed",
  });
  const decision = decideImportedQuality(normal, { quality: "lossless", codec: "flac" });
  assert.equal(decision.accepted, true);
  assert.equal(decision.transcode, true);
  assert.equal(decision.importedQuality, "lossy");
});
