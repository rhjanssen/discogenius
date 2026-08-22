import assert from "node:assert/strict";
import test from "node:test";
import { UpgradableSpecification } from "./upgradable-specification.js";

function profile(
  audioQuality: "high" | "max" | "normal" | "low",
  extras: { downconvert?: boolean; upgrade?: boolean } = {},
) {
  return UpgradableSpecification.buildEffectiveProfile({
    audio_quality: audioQuality,
    video_quality: "fhd",
    embed_cover: true,
    embed_lyrics: true,
    upgrade_existing_files: extras.upgrade !== false,
    downconvert_existing_files: extras.downconvert === true,
    extract_flac: true,
    convert_video_mp4: true,
  });
}

test("24/48 MAX file plus Apple HIGH offer is not an upgrade or a downconvert", () => {
  const evaluation = UpgradableSpecification.evaluateAudioChange({
    profile: profile("high"),
    currentQuality: "HIRES_LOSSLESS",
    sourceQuality: "LOSSLESS",
    codec: "ALAC",
    extension: "m4a",
    bitDepth: 24,
    sampleRate: 48000,
  });
  assert.equal(evaluation.needsChange, false);
  assert.equal(evaluation.direction, "downgrade");
});

test("24/48 MAX file plus TIDAL HIRES offer is not a CheckUpgrades loop", () => {
  const evaluation = UpgradableSpecification.evaluateAudioChange({
    profile: profile("max"),
    currentQuality: "HIRES_LOSSLESS",
    sourceQuality: "HIRES_LOSSLESS",
    codec: "FLAC",
    extension: "flac",
    bitDepth: 24,
    sampleRate: 48000,
  });
  assert.equal(evaluation.needsChange, false);
  assert.equal(evaluation.direction, "none");
});

test("24/48 Apple ALAC already satisfies MAX without chasing FLAC forever", () => {
  const evaluation = UpgradableSpecification.evaluateAudioChange({
    profile: profile("max"),
    currentQuality: "HIRES_LOSSLESS",
    sourceQuality: "HIRES_LOSSLESS",
    codec: "ALAC",
    extension: "m4a",
    bitDepth: 24,
    sampleRate: 48000,
  });
  assert.equal(evaluation.needsChange, false);
});

test("downconvert toggle marks 24/48 vs HIGH as a wanted downconvert", () => {
  const evaluation = UpgradableSpecification.evaluateAudioChange({
    profile: profile("high", { downconvert: true }),
    currentQuality: "HIRES_LOSSLESS",
    sourceQuality: "LOSSLESS",
    codec: "FLAC",
    extension: "flac",
    bitDepth: 24,
    sampleRate: 48000,
  });
  assert.equal(evaluation.needsChange, true);
  assert.equal(evaluation.direction, "downgrade");
  assert.equal(evaluation.targetQuality, "LOSSLESS");
});

test("LOSSLESS file vs Settings MAX with a hi-res offer is still an upgrade", () => {
  const evaluation = UpgradableSpecification.evaluateAudioChange({
    profile: profile("max"),
    currentQuality: "LOSSLESS",
    sourceQuality: "HIRES_LOSSLESS",
    codec: "FLAC",
    extension: "flac",
    bitDepth: 16,
    sampleRate: 44100,
  });
  assert.equal(evaluation.needsChange, true);
  assert.equal(evaluation.direction, "upgrade");
  assert.equal(evaluation.targetQuality, "HIRES_LOSSLESS");
});

test("spatial files are never a stereo downconvert", () => {
  const evaluation = UpgradableSpecification.evaluateAudioChange({
    profile: profile("low", { downconvert: true }),
    currentQuality: "DOLBY_ATMOS",
    codec: "eac3",
    extension: "m4a",
  });
  assert.equal(evaluation.needsChange, false);
  assert.equal(evaluation.direction, "none");
});
