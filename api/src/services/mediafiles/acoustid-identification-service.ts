import {
  generateFingerprint,
  lookupAcoustIdDetailed,
  lookupMusicBrainzRecording,
  type AcoustIdLookupOutcome,
  type MusicBrainzRecording,
} from "./fingerprint.js";

export type AcoustIdIdentificationStatus =
  | "embedded_identity"
  | "matched"
  | "ambiguous"
  | "no_match"
  | "duration_mismatch"
  | "missing_client"
  | "invalid_input"
  | "service_error"
  | "fingerprint_error";

export type AcoustIdRecordingCandidate = {
  acoustId: string;
  score: number | null;
  recording: MusicBrainzRecording;
  durationDeltaSeconds: number | null;
};

export type AcoustIdIdentificationResult = {
  status: AcoustIdIdentificationStatus;
  fingerprint: string | null;
  duration: number | null;
  cached: boolean;
  recordingIds: string[];
  candidates: AcoustIdRecordingCandidate[];
  rejected: Array<{ recordingId: string; reason: string }>;
  error?: string;
};

type Dependencies = {
  generateFingerprint: typeof generateFingerprint;
  lookup: (fingerprint: string, duration: number) => Promise<AcoustIdLookupOutcome>;
  lookupRecording: typeof lookupMusicBrainzRecording;
};

export type AcoustIdIdentificationOptions = {
  embeddedRecordingMbid?: string | null;
  durationToleranceSeconds?: number;
  dependencies?: Partial<Dependencies>;
};

function emptyResult(
  status: AcoustIdIdentificationStatus,
  overrides: Partial<AcoustIdIdentificationResult> = {},
): AcoustIdIdentificationResult {
  return {
    status,
    fingerprint: null,
    duration: null,
    cached: false,
    recordingIds: [],
    candidates: [],
    rejected: [],
    ...overrides,
  };
}

/**
 * Identify an unknown audio file without consulting any streaming provider.
 * AcoustID supplies MusicBrainz Recording candidates; edition/track assignment
 * remains a separate canonical-catalog decision.
 */
export async function identifyAudioFileByAcoustId(
  filePath: string,
  options: AcoustIdIdentificationOptions = {},
): Promise<AcoustIdIdentificationResult> {
  const embeddedRecordingMbid = String(options.embeddedRecordingMbid || "").trim();
  if (embeddedRecordingMbid) {
    return emptyResult("embedded_identity", {
      recordingIds: [embeddedRecordingMbid],
    });
  }

  const dependencies: Dependencies = {
    generateFingerprint,
    lookup: async (fingerprint, duration) =>
      lookupAcoustIdDetailed({ fingerprint, duration }),
    lookupRecording: lookupMusicBrainzRecording,
    ...options.dependencies,
  };

  let fingerprintResult: { duration: number; fingerprint: string };
  try {
    fingerprintResult = await dependencies.generateFingerprint(filePath);
  } catch (error) {
    return emptyResult("fingerprint_error", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const lookup = await dependencies.lookup(
    fingerprintResult.fingerprint,
    fingerprintResult.duration,
  );
  if (lookup.status !== "matched") {
    return emptyResult(lookup.status, {
      fingerprint: fingerprintResult.fingerprint,
      duration: fingerprintResult.duration,
      cached: lookup.cached,
      error: lookup.error,
    });
  }

  const evidence = new Map<string, { acoustId: string; score: number | null }>();
  for (const match of lookup.matches) {
    for (const recordingId of match.recordingIds) {
      const current = evidence.get(recordingId);
      if (!current || (match.score ?? -1) > (current.score ?? -1)) {
        evidence.set(recordingId, { acoustId: match.id, score: match.score });
      }
    }
  }

  const tolerance = Math.max(0, options.durationToleranceSeconds ?? 5);
  const candidates: AcoustIdRecordingCandidate[] = [];
  const rejected: Array<{ recordingId: string; reason: string }> = [];
  for (const [recordingId, match] of evidence) {
    const recording = await dependencies.lookupRecording(recordingId);
    if (!recording) {
      rejected.push({ recordingId, reason: "MusicBrainz Recording unavailable" });
      continue;
    }
    const durationDeltaSeconds = recording.durationSeconds == null
      ? null
      : Math.abs(recording.durationSeconds - fingerprintResult.duration);
    if (durationDeltaSeconds != null && durationDeltaSeconds > tolerance) {
      rejected.push({
        recordingId,
        reason: `Duration differs by ${durationDeltaSeconds}s (maximum ${tolerance}s)`,
      });
      continue;
    }
    candidates.push({
      acoustId: match.acoustId,
      score: match.score,
      recording,
      durationDeltaSeconds,
    });
  }

  const recordingIds = candidates.map((candidate) => candidate.recording.id);
  const base = {
    fingerprint: fingerprintResult.fingerprint,
    duration: fingerprintResult.duration,
    cached: lookup.cached,
    recordingIds,
    candidates,
    rejected,
  };
  if (candidates.length === 1) return emptyResult("matched", base);
  if (candidates.length > 1) return emptyResult("ambiguous", base);
  if (rejected.some((entry) => entry.reason.startsWith("Duration differs"))) {
    return emptyResult("duration_mismatch", base);
  }
  return emptyResult("no_match", base);
}
