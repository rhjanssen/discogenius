import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { resolveFfmpegBinary } from "./audioUtils.js";
import type { ImportQualityDecision } from "../music/quality-profile-policy.js";

export interface QualityTranscodeResult {
  inputPath: string;
  outputPath: string;
  replacedInput: boolean;
}

function outputExtension(decision: ImportQualityDecision, inputPath: string): string {
  switch (decision.output?.codec) {
    case "flac": return ".flac";
    case "mp3": return ".mp3";
    case "aac": return ".m4a";
    default: return path.extname(inputPath);
  }
}

function buildFfmpegArgs(
  inputPath: string,
  outputPath: string,
  decision: ImportQualityDecision,
): string[] {
  const output = decision.output;
  if (!output) throw new Error("Accepted transcode decision is missing an output format");
  const args = [
    "-nostdin",
    "-hide_banner",
    "-loglevel", "error",
    "-y",
    "-i", inputPath,
    "-map", "0:a:0",
    "-map_metadata", "0",
    "-vn",
  ];
  if (output.codec === "flac") {
    args.push("-c:a", "flac");
    if (output.bitDepth === 16) args.push("-sample_fmt", "s16");
  } else if (output.codec === "mp3") {
    args.push("-c:a", "libmp3lame");
    if (output.bitrate) args.push("-b:a", `${Math.round(output.bitrate / 1000)}k`);
  } else if (output.codec === "aac") {
    args.push("-c:a", "aac");
    if (output.bitrate) args.push("-b:a", `${Math.round(output.bitrate / 1000)}k`);
  } else {
    throw new Error(`Cannot transcode to output codec '${output.codec}'`);
  }
  if (output.sampleRate) args.push("-ar", String(output.sampleRate));
  args.push(outputPath);
  return args;
}

function runFfmpeg(
  args: string[],
  isCancelled?: () => boolean,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveFfmpegBinary(), args, {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    const interval = isCancelled
      ? setInterval(() => {
          if (isCancelled()) child.kill("SIGTERM");
        }, 100)
      : null;
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-8_192);
    });
    child.once("error", (error) => {
      if (interval) clearInterval(interval);
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (interval) clearInterval(interval);
      if (isCancelled?.()) {
        reject(new Error("Quality-profile transcode cancelled"));
      } else if (code === 0) {
        resolve();
      } else {
        reject(new Error(
          `FFmpeg quality-profile transcode failed (${signal || code}): ${stderr.trim() || "no diagnostic output"}`,
        ));
      }
    });
  });
}

/**
 * Convert one staged audio file to the profile's requested imported format.
 * Same-extension conversions are swapped atomically with a recoverable sibling
 * backup; extension changes delete the source only after the output succeeds.
 */
export async function transcodeForQualityProfile(
  inputPath: string,
  decision: ImportQualityDecision,
  options: { isCancelled?: () => boolean } = {},
): Promise<QualityTranscodeResult> {
  if (!decision.accepted) throw new Error(decision.reason);
  if (!decision.transcode) {
    return { inputPath, outputPath: inputPath, replacedInput: false };
  }
  if (!fs.existsSync(inputPath) || !fs.statSync(inputPath).isFile()) {
    throw new Error(`Transcode input does not exist: ${inputPath}`);
  }
  const extension = outputExtension(decision, inputPath);
  const sameExtension = extension.toLowerCase() === path.extname(inputPath).toLowerCase();
  const stem = inputPath.slice(0, inputPath.length - path.extname(inputPath).length);
  const finalPath = sameExtension ? inputPath : `${stem}${extension}`;
  if (!sameExtension && fs.existsSync(finalPath)) {
    throw new Error(`Refusing to overwrite existing transcode output: ${finalPath}`);
  }
  const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const temporaryPath = `${stem}.discogenius-transcode-${nonce}${extension}`;
  const backupPath = `${inputPath}.discogenius-source-${nonce}`;
  try {
    await runFfmpeg(buildFfmpegArgs(inputPath, temporaryPath, decision), options.isCancelled);
    if (!fs.existsSync(temporaryPath) || fs.statSync(temporaryPath).size === 0) {
      throw new Error("FFmpeg produced no importable output");
    }
    if (sameExtension) {
      fs.renameSync(inputPath, backupPath);
      try {
        fs.renameSync(temporaryPath, inputPath);
        fs.rmSync(backupPath, { force: true });
      } catch (error) {
        if (fs.existsSync(inputPath)) fs.rmSync(inputPath, { force: true });
        fs.renameSync(backupPath, inputPath);
        throw error;
      }
    } else {
      fs.renameSync(temporaryPath, finalPath);
      fs.rmSync(inputPath, { force: true });
    }
    return { inputPath, outputPath: finalPath, replacedInput: true };
  } finally {
    if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
    if (fs.existsSync(backupPath) && fs.existsSync(inputPath)) {
      fs.rmSync(backupPath, { force: true });
    }
  }
}
