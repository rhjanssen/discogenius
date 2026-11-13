import {
  generateFingerprint,
  isAcoustIdConfigured,
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

export type RecordingVerificationStatus = "verified" | "mismatch" | "unverified";

export interface RecordingVerificationResult {
  status: RecordingVerificationStatus;
  verified: boolean;
  reason: string | null;
  matchedRecordingId: string | null;
  detectedRecordingIds: string[];
  detectedLabel: string | null;
  expectedLabel: string;
}

export interface VerifyAudioFileRecordingParams {
  filePath: string;
  expectedRecordingMbid: string | null | undefined;
  expectedTitle?: string | null;
  knownMergedFromMbids?: readonly string[];
  identify?: (
    filePath: string,
    options?: AcoustIdIdentificationOptions,
  ) => Promise<AcoustIdIdentificationResult>;
  lookupRecording?: typeof lookupMusicBrainzRecording;
  isConfigured?: () => boolean;
}

function formatRecordingLabel(mbid: string, title?: string | null): string {
  const cleanTitle = String(title || "").trim();
  return cleanTitle ? `${mbid} ("${cleanTitle}")` : mbid;
}

/**
 * Fingerprint an audio file via AcoustID and verify whether it matches the
 * expected canonical MusicBrainz recording (including merged recordings).
 *
 * - Confident match -> "verified"
 * - Confident mismatch -> "mismatch" with `Fingerprint matches <recording> not <expected>`
 * - Missing key, no AcoustID result, rate limit, or error -> "unverified" (falls back)
 */
export async function verifyAudioFileRecording(
  params: VerifyAudioFileRecordingParams,
): Promise<RecordingVerificationResult> {
  const rawExpected = String(params.expectedRecordingMbid || "").trim();
  const expectedLower = rawExpected.toLowerCase();
  const expectedLabel = formatRecordingLabel(rawExpected || "unknown", params.expectedTitle);

  if (!expectedLower) {
    return {
      status: "unverified",
      verified: false,
      reason: "Expected recording MBID is missing",
      matchedRecordingId: null,
      detectedRecordingIds: [],
      detectedLabel: null,
      expectedLabel,
    };
  }

  const configured = params.isConfigured
    ? params.isConfigured()
    : (params.identify ? true : isAcoustIdConfigured());
  if (!configured) {
    return {
      status: "unverified",
      verified: false,
      reason: "AcoustID API key is not configured",
      matchedRecordingId: null,
      detectedRecordingIds: [],
      detectedLabel: null,
      expectedLabel,
    };
  }

  const identify = params.identify ?? identifyAudioFileByAcoustId;
  const lookupRecording = params.lookupRecording ?? lookupMusicBrainzRecording;

  let result: AcoustIdIdentificationResult;
  try {
    result = await identify(params.filePath, {
      embeddedRecordingMbid: null,
      ...(params.lookupRecording ? { dependencies: { lookupRecording } } : {}),
    });
  } catch (error) {
    return {
      status: "unverified",
      verified: false,
      reason: error instanceof Error ? error.message : String(error),
      matchedRecordingId: null,
      detectedRecordingIds: [],
      detectedLabel: null,
      expectedLabel,
    };
  }

  if (result.status !== "matched" && result.status !== "ambiguous") {
    return {
      status: "unverified",
      verified: false,
      reason: result.error || result.status,
      matchedRecordingId: null,
      detectedRecordingIds: [],
      detectedLabel: null,
      expectedLabel,
    };
  }

  const detectedIds = result.recordingIds.map((id) => id.trim()).filter(Boolean);
  if (detectedIds.length === 0) {
    return {
      status: "unverified",
      verified: false,
      reason: "AcoustID returned no recording candidates",
      matchedRecordingId: null,
      detectedRecordingIds: [],
      detectedLabel: null,
      expectedLabel,
    };
  }

  const mergedSet = new Set(
    (params.knownMergedFromMbids ?? [])
      .map((id) => String(id || "").trim().toLowerCase())
      .filter(Boolean),
  );
  mergedSet.add(expectedLower);

  const directMatch = detectedIds.find((id) => mergedSet.has(id.toLowerCase()));
  if (directMatch) {
    return {
      status: "verified",
      verified: true,
      reason: null,
      matchedRecordingId: directMatch,
      detectedRecordingIds: detectedIds,
      detectedLabel: null,
      expectedLabel,
    };
  }

  // Check whether MusicBrainz merged the expected recording into one of the detected recordings.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawExpected)) {
    try {
      const resolvedExpected = await lookupRecording(rawExpected);
      const resolvedLower = resolvedExpected?.id?.trim().toLowerCase();
      if (resolvedLower) {
        const mergedMatch = detectedIds.find((id) => id.toLowerCase() === resolvedLower);
        if (mergedMatch) {
          return {
            status: "verified",
            verified: true,
            reason: null,
            matchedRecordingId: mergedMatch,
            detectedRecordingIds: detectedIds,
            detectedLabel: null,
            expectedLabel,
          };
        }
      }
    } catch {
      // Non-fatal: if MusicBrainz redirect lookup fails, fall through to mismatch check.
    }
  }

  const firstCandidate = result.candidates[0]?.recording;
  const detectedLabel = firstCandidate
    ? formatRecordingLabel(firstCandidate.id, firstCandidate.title)
    : detectedIds[0];

  return {
    status: "mismatch",
    verified: false,
    reason: `Fingerprint matches ${detectedLabel} not ${expectedLabel}`,
    matchedRecordingId: null,
    detectedRecordingIds: detectedIds,
    detectedLabel,
    expectedLabel,
  };
}
