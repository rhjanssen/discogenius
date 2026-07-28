import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { parseAudioFile, resolveFfmpegBinary } from "./audioUtils.js";
import { decideImportedQuality, parseQualityProfile } from "../music/quality-profile-policy.js";
import { transcodeForQualityProfile } from "./quality-profile-transcoder.js";

const ffmpeg = resolveFfmpegBinary();
const ffmpegAvailable = spawnSync(ffmpeg, ["-version"], { windowsHide: true }).status === 0;

test("real ffmpeg downconverts a hi-res source for HIGH and reports actual output", {
  skip: !ffmpegAvailable,
}, async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-quality-transcode-"));
  const source = path.join(folder, "source.flac");
  try {
    const generated = spawnSync(ffmpeg, [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=96000:duration=0.3",
      "-c:a", "flac", "-sample_fmt", "s32", source,
    ], { windowsHide: true });
    assert.equal(generated.status, 0, String(generated.stderr || ""));
    const decision = decideImportedQuality(parseQualityProfile({
      id: 1,
      name: "High Quality",
      allowed_source_formats: '["lossless","hires-lossless"]',
      preference_order: '["hires-lossless","lossless"]',
      cutoff: "lossless",
      continue_upgrades: 0,
      fallback_policy: "best_allowed",
      output_format: '{"codec":"flac","lossless":true,"bitDepth":16,"sampleRate":44100}',
      transcode_policy: "downconvert_hires",
    }), {
      quality: "hires-lossless",
      codec: "flac",
      bitDepth: 24,
      sampleRate: 96_000,
    });
    const result = await transcodeForQualityProfile(source, decision);
    assert.equal(result.outputPath, source);
    assert.equal(result.replacedInput, true);
    const metrics = await parseAudioFile(source);
    assert.equal(metrics.sampleRate, 44_100);
    assert.equal(metrics.bitDepth, 16);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("cancelled transcodes do not replace their source", {
  skip: !ffmpegAvailable,
}, async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-quality-cancel-"));
  const source = path.join(folder, "source.wav");
  try {
    const generated = spawnSync(ffmpeg, [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=96000:duration=1",
      source,
    ], { windowsHide: true });
    assert.equal(generated.status, 0);
    await assert.rejects(
      transcodeForQualityProfile(source, {
        accepted: true,
        transcode: true,
        reason: "test",
        sourceQuality: "hires-lossless",
        importedQuality: "lossless",
        output: {
          codec: "flac",
          lossless: true,
          bitDepth: 16,
          sampleRate: 44_100,
        },
      }, { isCancelled: () => true }),
      /cancelled/,
    );
    assert.equal(fs.existsSync(source), true);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
