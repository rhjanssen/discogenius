import type Database from "better-sqlite3";
import type { AcquisitionQualityProfile, NormalizedAudioQuality } from "./acquisition-plan-optimizer.js";

export interface DesiredOutputFormat {
  codec: "flac" | "alac" | "mp3" | "aac" | "opus" | "preserve";
  lossless: boolean;
  bitDepth?: number | null;
  sampleRate?: number | null;
  bitrate?: number | null;
  spatial?: boolean;
}

export interface QualityProfilePolicy extends AcquisitionQualityProfile {
  id: number;
  name: string;
  fallbackPolicy: string;
  outputFormat: DesiredOutputFormat;
  transcodePolicy: "preserve" | "downconvert_hires" | "transcode_allowed";
}

export interface SourceAudioFacts {
  quality: NormalizedAudioQuality;
  codec?: string | null;
  extension?: string | null;
  bitDepth?: number | null;
  sampleRate?: number | null;
  bitrate?: number | null;
  spatialFormat?: string | null;
}

export interface ImportQualityOptions {
  /** When true, 24-bit lossless on a lossless profile is transcoded to 16/44.1. */
  conformToTarget?: boolean;
}

export interface ImportQualityDecision {
  accepted: boolean;
  transcode: boolean;
  reason: string;
  sourceQuality: NormalizedAudioQuality;
  importedQuality: NormalizedAudioQuality | null;
  output: DesiredOutputFormat | null;
}

interface QualityProfileRow {
  id: number;
  name: string;
  allowed_source_formats: string | null;
  preference_order: string | null;
  cutoff: string;
  continue_upgrades: number | null;
  fallback_policy: string | null;
  output_format: string | null;
  transcode_policy: string | null;
}

const qualities = new Set<NormalizedAudioQuality>([
  "lossy",
  "lossless",
  "hires-lossless",
  "spatial",
]);

function parseQualityList(value: string | null, label: string): NormalizedAudioQuality[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value || "[]");
  } catch {
    throw new Error(`Quality profile ${label} must be valid JSON`);
  }
  if (!Array.isArray(parsed)) throw new Error(`Quality profile ${label} must be an array`);
  const result = parsed.map((item) => String(item)) as NormalizedAudioQuality[];
  for (const quality of result) {
    if (!qualities.has(quality)) throw new Error(`Unknown normalized quality '${quality}'`);
  }
  return [...new Set(result)];
}

function parseOutputFormat(value: string | null): DesiredOutputFormat {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value || "{}");
  } catch {
    throw new Error("Quality profile output_format must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Quality profile output_format must be an object");
  }
  const object = parsed as Record<string, unknown>;
  const codec = String(object.codec || "preserve") as DesiredOutputFormat["codec"];
  if (!["flac", "alac", "mp3", "aac", "opus", "preserve"].includes(codec)) {
    throw new Error(`Unsupported output codec '${codec}'`);
  }
  return {
    codec,
    lossless: object.lossless === true || codec === "flac" || codec === "alac",
    bitDepth: object.bitDepth == null ? null : Number(object.bitDepth),
    sampleRate: object.sampleRate == null ? null : Number(object.sampleRate),
    bitrate: object.bitrate == null ? null : Number(object.bitrate),
    spatial: object.spatial === true,
  };
}

export function parseQualityProfile(row: QualityProfileRow): QualityProfilePolicy {
  const allowed = parseQualityList(row.allowed_source_formats, "allowed_source_formats");
  const preference = parseQualityList(row.preference_order, "preference_order");
  const cutoff = String(row.cutoff) as NormalizedAudioQuality;
  if (!qualities.has(cutoff)) throw new Error(`Unknown normalized cutoff '${cutoff}'`);
  const transcodePolicy = String(row.transcode_policy || "preserve") as QualityProfilePolicy["transcodePolicy"];
  if (!["preserve", "downconvert_hires", "transcode_allowed"].includes(transcodePolicy)) {
    throw new Error(`Unsupported transcode policy '${transcodePolicy}'`);
  }
  return {
    id: row.id,
    name: row.name,
    allowedQualities: new Set(allowed),
    preferenceOrder: preference,
    cutoff,
    continueUpgradesAfterCutoff: Boolean(row.continue_upgrades),
    fallbackPolicy: row.fallback_policy || "unavailable",
    outputFormat: parseOutputFormat(row.output_format),
    transcodePolicy,
  };
}

export class QualityProfileRepository {
  constructor(private readonly db: Database.Database) {}

  get(profileId: number): QualityProfilePolicy {
    const row = this.db.prepare(`
      SELECT
        id, name, allowed_source_formats, preference_order, cutoff,
        continue_upgrades, fallback_policy, output_format, transcode_policy
      FROM quality_profiles
      WHERE id = ?
    `).get(profileId) as QualityProfileRow | undefined;
    if (!row) throw new Error(`Quality profile ${profileId} does not exist`);
    return parseQualityProfile(row);
  }
}

function importedQualityFor(output: DesiredOutputFormat, source: SourceAudioFacts): NormalizedAudioQuality {
  if (output.spatial || source.quality === "spatial") return "spatial";
  if (!output.lossless) return "lossy";
  const bitDepth = output.bitDepth ?? source.bitDepth ?? null;
  const sampleRate = output.sampleRate ?? source.sampleRate ?? null;
  return (bitDepth != null && bitDepth > 16) || (sampleRate != null && sampleRate > 48_000)
    ? "hires-lossless"
    : "lossless";
}

export const NORMAL_DOWNCONVERT_BITRATE = 160_000;
export const LOW_DOWNCONVERT_BITRATE = 96_000;

/** Same-codec CD-quality target: ALAC stays ALAC, everything else becomes FLAC. */
export function losslessDownconvertCodec(source: {
  codec?: string | null;
  extension?: string | null;
}): "flac" | "alac" {
  const codec = String(source.codec || "").toLowerCase();
  const extension = String(source.extension || "").replace(/^\./, "").toLowerCase();
  if (codec.includes("alac") || codec.includes("apple lossless") || extension === "alac") {
    return "alac";
  }
  return "flac";
}

export function buildDownconvertDecision(input: {
  audioQuality: "low" | "normal" | "high" | "max";
  codec?: string | null;
  extension?: string | null;
}): ImportQualityDecision {
  if (input.audioQuality === "high") {
    const codec = losslessDownconvertCodec(input);
    return {
      accepted: true,
      transcode: true,
      reason: `Downconvert to 16-bit/44.1 ${codec.toUpperCase()}`,
      sourceQuality: "hires-lossless",
      importedQuality: "lossless",
      output: {
        codec,
        lossless: true,
        bitDepth: 16,
        sampleRate: 44_100,
        bitrate: null,
        spatial: false,
      },
    };
  }
  if (input.audioQuality === "normal") {
    return {
      accepted: true,
      transcode: true,
      reason: "Downconvert to Opus 160 kbps",
      sourceQuality: "lossless",
      importedQuality: "lossy",
      output: {
        codec: "opus",
        lossless: false,
        bitrate: NORMAL_DOWNCONVERT_BITRATE,
        spatial: false,
      },
    };
  }
  if (input.audioQuality === "low") {
    return {
      accepted: true,
      transcode: true,
      reason: "Downconvert to Opus 96 kbps",
      sourceQuality: "lossless",
      importedQuality: "lossy",
      output: {
        codec: "opus",
        lossless: false,
        bitrate: LOW_DOWNCONVERT_BITRATE,
        spatial: false,
      },
    };
  }
  return {
    accepted: true,
    transcode: false,
    reason: "MAX has no downconvert target",
    sourceQuality: "hires-lossless",
    importedQuality: "hires-lossless",
    output: null,
  };
}

/**
 * Decide import conversion from normalized facts only.
 *
 * Settings quality is a preference ladder (try higher, fall back lower), so a
 * lossy source on a Max/High profile is accepted when the profile allows it —
 * imported and labelled as lossy, never upscaled to a fabricated lossless file.
 */
export function decideImportedQuality(
  profile: QualityProfilePolicy,
  source: SourceAudioFacts,
  options: ImportQualityOptions = {},
): ImportQualityDecision {
  if (!profile.allowedQualities.has(source.quality)) {
    return {
      accepted: false,
      transcode: false,
      reason: "source quality is not allowed by the profile",
      sourceQuality: source.quality,
      importedQuality: null,
      output: null,
    };
  }
  const output = profile.outputFormat;
  // 24-bit lossless is already MAX. Apple HIGH can deliver 24/48 ALAC; keep it
  // on lossless profiles unless Settings asked to conform the library down.
  // Lossy profiles (Normal/Low) still convert leftover lossless, including 24-bit.
  if (
    output.lossless
    && (source.quality === "lossless" || source.quality === "hires-lossless")
    && source.bitDepth != null
    && source.bitDepth >= 24
  ) {
    if (options.conformToTarget) {
      const codec = losslessDownconvertCodec(source);
      return {
        accepted: true,
        transcode: true,
        reason: "conforming 24-bit lossless to 16-bit/44.1",
        sourceQuality: source.quality,
        importedQuality: "lossless",
        output: {
          codec,
          lossless: true,
          bitDepth: 16,
          sampleRate: 44_100,
          bitrate: null,
          spatial: false,
        },
      };
    }
    return {
      accepted: true,
      transcode: false,
      reason: "native 24-bit lossless kept; not downconverted to 16-bit",
      sourceQuality: source.quality,
      importedQuality: "hires-lossless",
      output: {
        codec: "preserve",
        lossless: true,
        bitDepth: source.bitDepth,
        sampleRate: source.sampleRate ?? null,
        bitrate: null,
        spatial: false,
      },
    };
  }
  // Lossy lands as lossy. Keep the acquired AAC/Opus/Vorbis/MP3 file instead of
  // a second lossy generation, and never invent a lossless label for it.
  if (source.quality === "lossy") {
    return {
      accepted: true,
      transcode: false,
      reason: output.lossless
        ? "lossy source preserved; cannot be upscaled to a lossless label"
        : "native lossy delivery kept; no second lossy generation",
      sourceQuality: source.quality,
      importedQuality: "lossy",
      output: {
        codec: "preserve",
        lossless: false,
        bitDepth: null,
        sampleRate: null,
        bitrate: source.bitrate ?? output.bitrate ?? null,
        spatial: false,
      },
    };
  }
  const preserve = output.codec === "preserve"
    || profile.transcodePolicy === "preserve"
    || (source.quality === "spatial" && output.spatial);
  const importedQuality = preserve
    ? source.quality
    : importedQualityFor(output, source);
  const downconvertsHires = source.quality === "hires-lossless"
    && importedQuality === "lossless";
  if (downconvertsHires && profile.transcodePolicy !== "downconvert_hires"
    && profile.transcodePolicy !== "transcode_allowed") {
    return {
      accepted: false,
      transcode: false,
      reason: "profile does not permit hi-res downconversion",
      sourceQuality: source.quality,
      importedQuality: null,
      output: null,
    };
  }
  return {
    accepted: true,
    transcode: !preserve && (
      output.codec !== "preserve"
      || downconvertsHires
    ),
    reason: preserve ? "source is preserved" : "source is converted to the profile output",
    sourceQuality: source.quality,
    importedQuality,
    output,
  };
}
