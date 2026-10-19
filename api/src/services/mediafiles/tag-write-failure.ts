/**
 * A TagLib read-back that does not match is not damage: the in-place undo or
 * the discarded working copy leaves the original file as it was. Those notices
 * are warnings. A layout, permission, lock, or strip-clear failure is a real
 * file error because the audio container or the requested destructive clear
 * did not stay intact.
 */
const INFORMATIONAL_VERIFICATION = [
  /^TagLib verification failed for \S/,
  /^Multi-value verification failed for \S/,
  /^Artist ID verification failed for \S/,
  /^ISRC verification failed for \S/,
  /^TagLib removal verification failed for \S/,
  /^TagLib cover verification failed$/,
];

const REAL_WRITE_FAILURE = [
  /MP4 layout became unreadable/,
  /MP4 ftyp changed/,
  /MP4 mdat payload length changed/,
  /MP4 audio sample entry changed/,
  /MP4 mdat moved/,
  /MP4 chunk offsets changed/,
  /TagLib clear verification failed/,
  /\bEACCES\b/,
  /\bEROFS\b/,
  /\bEPERM\b/,
  /read-only/i,
  /permission denied/i,
  /\bEBUSY\b/,
  /resource busy/i,
];

export function metadataWriteFailureKind(message: string): "warning" | "error" {
  if (REAL_WRITE_FAILURE.some((pattern) => pattern.test(message))) return "error";
  if (INFORMATIONAL_VERIFICATION.some((pattern) => pattern.test(message))) return "warning";
  return "error";
}
