import fs from "node:fs";
import path from "node:path";
import { db } from "../../database.js";
import type { QualityConfig } from "../config/config.js";
import { buildDownconvertDecision } from "../music/quality-profile-policy.js";
import { deriveQuality, parseAudioFile } from "./audioUtils.js";
import { resolveStoredLibraryPath } from "./library-paths.js";
import { transcodeForQualityProfile } from "./quality-profile-transcoder.js";

export type ConformTrackFileInput = {
  fileId: number;
  filePath: string;
  relativePath?: string | null;
  libraryRoot?: string | null;
  filename?: string | null;
  expectedPath?: string | null;
  codec?: string | null;
  extension?: string | null;
  quality?: string | null;
  bitDepth?: number | null;
  sampleRate?: number | null;
  audioQuality: QualityConfig["audio_quality"];
  isCancelled?: () => boolean;
};

function qualityTagForDecision(
  decision: { importedQuality: string | null; output?: { codec?: string | null; bitrate?: number | null } | null },
  derived: string,
): string {
  if (decision.importedQuality === "lossless") return "LOSSLESS";
  if (decision.importedQuality === "hires-lossless") return "HIRES_LOSSLESS";
  if (decision.output?.codec === "opus") {
    return (decision.output.bitrate ?? 0) >= 128_000 ? "HIGH" : "LOW";
  }
  return derived;
}

function swapExtension(input: string, nextExt: string): string {
  const match = String(input).match(/\.[^./\\]+$/);
  if (!match) return `${input}${nextExt}`;
  return `${input.slice(0, input.length - match[0].length)}${nextExt}`;
}

/**
 * Transcode one stereo library file in place (or same stem, new extension) and
 * rewrite TrackFiles quality facts from the probed output.
 */
export async function conformExistingTrackFile(
  input: ConformTrackFileInput,
): Promise<{ outputPath: string; quality: string }> {
  const resolved = resolveStoredLibraryPath({
    filePath: input.filePath,
    libraryRoot: input.libraryRoot,
    relativePath: input.relativePath,
  });
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error(`Library file is missing: ${resolved}`);
  }
  const decision = buildDownconvertDecision({
    audioQuality: input.audioQuality,
    codec: input.codec,
    extension: input.extension || path.extname(resolved),
  });
  const result = await transcodeForQualityProfile(resolved, decision, {
    isCancelled: input.isCancelled,
  });
  const outputPath = result.outputPath;
  const metrics = await parseAudioFile(outputPath);
  const output = decision.output;
  const merged = {
    ...metrics,
    codec: metrics.codec || output?.codec || undefined,
    bitDepth: metrics.bitDepth || output?.bitDepth || undefined,
    sampleRate: metrics.sampleRate || output?.sampleRate || undefined,
    bitrate: (output?.codec === "opus" ? output.bitrate : null) || metrics.bitrate || output?.bitrate || undefined,
  };
  const nextExt = path.extname(outputPath);
  const derived = deriveQuality(nextExt, merged);
  const quality = qualityTagForDecision(decision, derived);
  const stat = fs.statSync(outputPath);
  const nextRelative = input.relativePath
    ? swapExtension(input.relativePath, nextExt)
    : input.relativePath;
  const nextFilename = input.filename
    ? swapExtension(input.filename, nextExt)
    : path.basename(outputPath);
  const nextExpected = input.expectedPath
    ? swapExtension(input.expectedPath, nextExt)
    : input.expectedPath;

  db.prepare(`
    UPDATE TrackFiles
    SET
      file_path = ?,
      relative_path = COALESCE(?, relative_path),
      filename = ?,
      extension = ?,
      file_size = ?,
      quality = ?,
      imported_quality = ?,
      codec = ?,
      bit_depth = ?,
      sample_rate = ?,
      bitrate = ?,
      duration = ?,
      expected_path = COALESCE(?, expected_path),
      modified_at = ?,
      verified_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    outputPath,
    nextRelative ?? null,
    nextFilename,
    nextExt.replace(/^\./, ""),
    stat.size,
    quality,
    decision.importedQuality,
    merged.codec ?? null,
    merged.bitDepth ?? null,
    merged.sampleRate ?? null,
    merged.bitrate ?? null,
    merged.duration ?? null,
    nextExpected ?? null,
    stat.mtime.toISOString(),
    input.fileId,
  );

  return { outputPath, quality };
}
