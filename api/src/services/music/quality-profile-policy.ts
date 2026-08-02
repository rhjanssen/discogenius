import type Database from "better-sqlite3";
import type { AcquisitionQualityProfile, NormalizedAudioQuality } from "./acquisition-plan-optimizer.js";

export interface DesiredOutputFormat {
  codec: "flac" | "mp3" | "aac" | "preserve";
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
  bitDepth?: number | null;
  sampleRate?: number | null;
  bitrate?: number | null;
  spatialFormat?: string | null;
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
  if (!["flac", "mp3", "aac", "preserve"].includes(codec)) {
    throw new Error(`Unsupported output codec '${codec}'`);
  }
  return {
    codec,
    lossless: object.lossless === true || codec === "flac",
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
  // Lossy can only land as lossy. Prefer keep-as-is over rejecting the only
  // available offer when Max/High fell back to SoundCloud / YouTube Music.
  if (source.quality === "lossy" && output.lossless) {
    return {
      accepted: true,
      transcode: false,
      reason: "lossy source preserved; cannot be upscaled to a lossless label",
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
      || (!output.lossless && source.quality !== "lossy")
    ),
    reason: preserve ? "source is preserved" : "source is converted to the profile output",
    sourceQuality: source.quality,
    importedQuality,
    output,
  };
}
