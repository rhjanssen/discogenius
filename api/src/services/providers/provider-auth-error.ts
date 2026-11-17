/**
 * A download provider rejected the account itself.
 *
 * Callers must branch on this type. Matching error text at each album is the
 * failure mode that turned one expired Tidal refresh into a queue of failures.
 */
export class ProviderAuthError extends Error {
  readonly provider: string;
  readonly code: string;

  constructor(provider: string, message: string, code = "needs_reauth") {
    super(message);
    this.name = "ProviderAuthError";
    this.provider = normalizeProviderId(provider);
    this.code = code;
  }
}

export function normalizeProviderId(provider: string): string {
  return String(provider || "").trim().toLowerCase();
}

/**
 * Corrupt or truncated media segment errors from the downloader/demuxer.
 * These are transient network / restart / CDN delivery drops, never session
 * failures, and must not cause an auth hold or re-login banner.
 */
export const APPLE_TRUNCATED_SEGMENT_PATTERN =
  /decode mdat|does not match expected length|unexpected eof/iu;

export function isAppleTruncatedSegmentError(error: unknown): boolean {
  if (!error) return false;
  const message = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : String(error);
  return APPLE_TRUNCATED_SEGMENT_PATTERN.test(message);
}

/**
 * One classifier for auth failures that arrive as plain errors (tiddl, older
 * Streamrip output, history rows from before this type existed).
 * Transient network text does not match.
 */
const AUTH_FAILURE_TEXT =
  /tidal login expired|TIDAL token refresh failed \(HTTP 401\b|invalid\s+arl|arl\s+(?:expired|invalid)|deezer arl is invalid|needs_reauth|apple music decryption (?:failed|wrapper)|decryption wrapper (?:port|is (?:not answering|unreachable))|failed to run v2:\s*decrypt|decrypting\.\.\.\s*failed/iu;
/**
 * An expired ACCESS token ("The token has expired. (Expired on time)" from a
 * TIDAL API call) is not a dead login: the refresh token renews it. Treating
 * it as one marked TIDAL needs_reauth and held every download until a manual
 * re-login (23 Oct 2026). Only the refresh endpoint decides that a login is
 * dead, and it throws ProviderAuthError. History rows written before that
 * distinction still count as auth failures so a reconnect retries them.
 */
const HISTORICAL_AUTH_FAILURE_TEXT = /token has expired/iu;

export function errorIndicatesProviderAuth(error: unknown): boolean {
  if (isAppleTruncatedSegmentError(error)) return false;
  if (error instanceof ProviderAuthError) return true;
  const message = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "";
  return AUTH_FAILURE_TEXT.test(message);
}

export function asProviderAuthError(provider: string, error: unknown): ProviderAuthError | null {
  if (isAppleTruncatedSegmentError(error)) return null;
  if (!errorIndicatesProviderAuth(error)) return null;
  if (error instanceof ProviderAuthError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new ProviderAuthError(provider, message, "needs_reauth");
}

export function isHistoricalAuthFailure(error: string | null | undefined): boolean {
  if (isAppleTruncatedSegmentError(error)) return false;
  const text = String(error || "");
  return AUTH_FAILURE_TEXT.test(text) || HISTORICAL_AUTH_FAILURE_TEXT.test(text);
}
