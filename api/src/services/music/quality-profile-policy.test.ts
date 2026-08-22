import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDownconvertDecision,
  decideImportedQuality,
  LOW_DOWNCONVERT_BITRATE,
  NORMAL_DOWNCONVERT_BITRATE,
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

test("HIGH keeps 24/48 instead of ffmpeg down to 16/44.1", () => {
  assert.deepEqual(
    decideImportedQuality(profile(), {
      quality: "hires-lossless",
      codec: "alac",
      bitDepth: 24,
      sampleRate: 48_000,
    }),
    {
      accepted: true,
      transcode: false,
      reason: "native 24-bit lossless kept; not downconverted to 16-bit",
      sourceQuality: "hires-lossless",
      importedQuality: "hires-lossless",
      output: {
        codec: "preserve",
        lossless: true,
        bitDepth: 24,
        sampleRate: 48_000,
        bitrate: null,
        spatial: false,
      },
    },
  );
});

test("HIGH keeps 24-bit even when the Apple offer was tagged lossless", () => {
  const decision = decideImportedQuality(profile(), {
    quality: "lossless",
    codec: "alac",
    bitDepth: 24,
    sampleRate: 48_000,
  });
  assert.equal(decision.accepted, true);
  assert.equal(decision.transcode, false);
  assert.equal(decision.importedQuality, "hires-lossless");
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

test("NORMAL transcodes 24-bit FLAC to lossy; the 24-bit keep is lossless-profile only", () => {
  const normal = profile({
    name: "Normal Quality",
    allowed_source_formats: JSON.stringify(["lossy", "lossless", "hires-lossless"]),
    preference_order: JSON.stringify(["lossless", "hires-lossless", "lossy"]),
    cutoff: "lossy",
    output_format: JSON.stringify({ codec: "opus", lossless: false, bitrate: 160_000 }),
    transcode_policy: "transcode_allowed",
  });
  const decision = decideImportedQuality(normal, {
    quality: "hires-lossless",
    codec: "flac",
    bitDepth: 24,
    sampleRate: 48_000,
  });
  assert.equal(decision.accepted, true);
  assert.equal(decision.transcode, true);
  assert.equal(decision.importedQuality, "lossy");
  assert.equal(decision.output?.codec, "opus");
});

test("HIGH conforms 24/48 FLAC to 16/44.1 FLAC when requested", () => {
  const decision = decideImportedQuality(profile(), {
    quality: "hires-lossless",
    codec: "flac",
    extension: "flac",
    bitDepth: 24,
    sampleRate: 48_000,
  }, { conformToTarget: true });
  assert.equal(decision.transcode, true);
  assert.equal(decision.importedQuality, "lossless");
  assert.equal(decision.output?.codec, "flac");
  assert.equal(decision.output?.bitDepth, 16);
  assert.equal(decision.output?.sampleRate, 44_100);
});

test("HIGH conforms 24/48 ALAC to 16/44.1 ALAC when requested", () => {
  const decision = decideImportedQuality(profile(), {
    quality: "hires-lossless",
    codec: "alac",
    extension: "m4a",
    bitDepth: 24,
    sampleRate: 48_000,
  }, { conformToTarget: true });
  assert.equal(decision.output?.codec, "alac");
  assert.equal(decision.output?.bitDepth, 16);
  assert.equal(decision.output?.sampleRate, 44_100);
});

test("NORMAL can transcode a lossless source to an actual lossy output", () => {
  const normal = profile({
    name: "Normal Quality",
    allowed_source_formats: JSON.stringify(["lossy", "lossless", "hires-lossless"]),
    preference_order: JSON.stringify(["lossless", "hires-lossless", "lossy"]),
    cutoff: "lossy",
    output_format: JSON.stringify({ codec: "aac", lossless: false, bitrate: 320_000 }),
    transcode_policy: "transcode_allowed",
  });
  const decision = decideImportedQuality(normal, { quality: "lossless", codec: "flac" });
  assert.equal(decision.accepted, true);
  assert.equal(decision.transcode, true);
  assert.equal(decision.importedQuality, "lossy");
  assert.equal(decision.output?.codec, "aac");
});

test("LOW downconvert is Opus 96", () => {
  const decision = buildDownconvertDecision({
    audioQuality: "low",
    codec: "flac",
    extension: "flac",
  });
  assert.equal(decision.output?.codec, "opus");
  assert.equal(decision.output?.bitrate, LOW_DOWNCONVERT_BITRATE);
});

test("MAX has no downconvert target", () => {
  const decision = buildDownconvertDecision({ audioQuality: "max", codec: "flac" });
  assert.equal(decision.transcode, false);
});

test("HIGH downconvert keeps ALAC as ALAC at 16/44.1", () => {
  const decision = buildDownconvertDecision({
    audioQuality: "high",
    codec: "alac",
    extension: "m4a",
  });
  assert.equal(decision.output?.codec, "alac");
  assert.equal(decision.output?.bitDepth, 16);
  assert.equal(decision.output?.sampleRate, 44_100);
});

test("NORMAL downconvert is Opus 160, not MP3", () => {
  const decision = buildDownconvertDecision({
    audioQuality: "normal",
    codec: "flac",
    extension: "flac",
  });
  assert.equal(decision.output?.codec, "opus");
  assert.equal(decision.output?.bitrate, NORMAL_DOWNCONVERT_BITRATE);
});

test("NORMAL keeps a compliant native AAC file instead of transcoding to MP3", () => {
  const normal = profile({
    name: "Normal Quality",
    allowed_source_formats: JSON.stringify(["lossy", "lossless", "hires-lossless"]),
    preference_order: JSON.stringify(["hires-lossless", "lossless", "lossy"]),
    cutoff: "lossy",
    output_format: JSON.stringify({ codec: "mp3", lossless: false, bitrate: 320_000 }),
    transcode_policy: "transcode_allowed",
  });
  const decision = decideImportedQuality(normal, {
    quality: "lossy",
    codec: "aac",
    bitrate: 256_000,
  });
  assert.equal(decision.accepted, true);
  assert.equal(decision.transcode, false);
  assert.equal(decision.importedQuality, "lossy");
  assert.equal(decision.output?.codec, "preserve");
  assert.match(decision.reason, /native lossy/);
});
