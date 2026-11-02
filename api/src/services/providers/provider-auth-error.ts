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
 * One classifier for auth failures that arrive as plain errors (tiddl, older
 * Streamrip output, history rows from before this type existed).
 * Transient network text does not match.
 */
const AUTH_FAILURE_TEXT = /tidal login expired|TIDAL token refresh failed \(HTTP 401\b|invalid\s+arl|arl\s+(?:expired|invalid)|deezer arl is invalid|needs_reauth/iu;
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
  if (error instanceof ProviderAuthError) return true;
  const message = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "";
  return AUTH_FAILURE_TEXT.test(message);
}

export function asProviderAuthError(provider: string, error: unknown): ProviderAuthError | null {
  if (!errorIndicatesProviderAuth(error)) return null;
  if (error instanceof ProviderAuthError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new ProviderAuthError(provider, message, "needs_reauth");
}

export function isHistoricalAuthFailure(error: string | null | undefined): boolean {
  const text = String(error || "");
  return AUTH_FAILURE_TEXT.test(text) || HISTORICAL_AUTH_FAILURE_TEXT.test(text);
}
