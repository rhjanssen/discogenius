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

test("HIGH import leaves a 24/48 source untouched", {
  skip: !ffmpegAvailable,
}, async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-quality-transcode-"));
  const source = path.join(folder, "source.flac");
  try {
    const generated = spawnSync(ffmpeg, [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=0.3",
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
      sampleRate: 48_000,
    });
    assert.equal(decision.transcode, false);
    const result = await transcodeForQualityProfile(source, decision);
    assert.equal(result.outputPath, source);
    assert.equal(result.replacedInput, false);
    const metrics = await parseAudioFile(source);
    assert.equal(metrics.sampleRate, 48_000);
    assert.ok((metrics.bitDepth ?? 0) >= 24);
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

function writeSine(output: string, args: string[]): void {
  const generated = spawnSync(ffmpeg, [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=0.3",
    ...args,
    output,
  ], { windowsHide: true });
  assert.equal(generated.status, 0, String(generated.stderr || ""));
}

test("HIGH conform transcodes 24/48 FLAC to 16/44.1 FLAC in place", {
  skip: !ffmpegAvailable,
}, async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-quality-flac-cd-"));
  const source = path.join(folder, "source.flac");
  try {
    writeSine(source, ["-c:a", "flac", "-sample_fmt", "s32"]);
    const decision = decideImportedQuality(parseQualityProfile({
      id: 1,
      name: "High Quality",
      allowed_source_formats: '["lossless","hires-lossless"]',
      preference_order: '["hires-lossless","lossless"]',
      cutoff: "lossless",
      continue_upgrades: 0,
      fallback_policy: "best_allowed",
      output_format: '{"codec":"preserve","lossless":true}',
      transcode_policy: "preserve",
    }), {
      quality: "hires-lossless",
      codec: "flac",
      extension: "flac",
      bitDepth: 24,
      sampleRate: 48_000,
    }, { conformToTarget: true });
    assert.equal(decision.transcode, true);
    const result = await transcodeForQualityProfile(source, decision);
    assert.equal(result.outputPath, source);
    assert.equal(result.replacedInput, true);
    const metrics = await parseAudioFile(source);
    assert.equal(metrics.sampleRate, 44_100);
    assert.equal(metrics.bitDepth, 16);
    assert.match(String(metrics.codec || ""), /flac/i);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("HIGH conform transcodes 24/48 ALAC to 16/44.1 ALAC in place", {
  skip: !ffmpegAvailable,
}, async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-quality-alac-cd-"));
  const source = path.join(folder, "source.m4a");
  try {
    writeSine(source, ["-c:a", "alac", "-sample_fmt", "s32p"]);
    const decision = decideImportedQuality(parseQualityProfile({
      id: 1,
      name: "High Quality",
      allowed_source_formats: '["lossless","hires-lossless"]',
      preference_order: '["hires-lossless","lossless"]',
      cutoff: "lossless",
      continue_upgrades: 0,
      fallback_policy: "best_allowed",
      output_format: '{"codec":"preserve","lossless":true}',
      transcode_policy: "preserve",
    }), {
      quality: "hires-lossless",
      codec: "alac",
      extension: "m4a",
      bitDepth: 24,
      sampleRate: 48_000,
    }, { conformToTarget: true });
    assert.equal(decision.output?.codec, "alac");
    const result = await transcodeForQualityProfile(source, decision);
    assert.equal(result.outputPath, source);
    const probe = spawnSync("ffprobe", [
      "-v", "error",
      "-show_entries", "stream=codec_name,sample_rate,sample_fmt",
      "-of", "default=noprint_wrappers=1",
      source,
    ], { windowsHide: true, encoding: "utf-8" });
    assert.equal(probe.status, 0, probe.stderr);
    assert.match(probe.stdout, /codec_name=alac/);
    assert.match(probe.stdout, /sample_rate=44100/);
    assert.match(probe.stdout, /sample_fmt=s16p/);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("NORMAL conform transcodes 16-bit FLAC to Opus 160, not MP3", {
  skip: !ffmpegAvailable,
}, async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-quality-opus-"));
  const source = path.join(folder, "source.flac");
  try {
    const generated = spawnSync(ffmpeg, [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=0.3",
      "-c:a", "flac", "-sample_fmt", "s16", source,
    ], { windowsHide: true });
    assert.equal(generated.status, 0, String(generated.stderr || ""));
    const result = await transcodeForQualityProfile(source, {
      accepted: true,
      transcode: true,
      reason: "test",
      sourceQuality: "lossless",
      importedQuality: "lossy",
      output: { codec: "opus", lossless: false, bitrate: 160_000 },
    });
    assert.equal(path.extname(result.outputPath), ".opus");
    assert.equal(fs.existsSync(source), false);
    assert.equal(fs.existsSync(result.outputPath), true);
    const metrics = await parseAudioFile(result.outputPath);
    assert.match(String(metrics.codec || ""), /opus/i);
    assert.notEqual(path.extname(result.outputPath), ".mp3");
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("LOW conform transcodes FLAC to Opus 96", {
  skip: !ffmpegAvailable,
}, async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-quality-opus96-"));
  const source = path.join(folder, "source.flac");
  try {
    writeSine(source, ["-c:a", "flac", "-sample_fmt", "s32"]);
    const result = await transcodeForQualityProfile(source, {
      accepted: true,
      transcode: true,
      reason: "test",
      sourceQuality: "hires-lossless",
      importedQuality: "lossy",
      output: { codec: "opus", lossless: false, bitrate: 96_000 },
    });
    assert.equal(path.extname(result.outputPath), ".opus");
    const metrics = await parseAudioFile(result.outputPath);
    assert.match(String(metrics.codec || ""), /opus/i);
    assert.ok((metrics.bitrate ?? 0) < 140_000);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

