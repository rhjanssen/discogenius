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
const AUTH_FAILURE_TEXT = /token has expired|TIDAL token refresh failed \(HTTP 401\b|invalid\s+arl|arl\s+(?:expired|invalid)|deezer arl is invalid|needs_reauth/iu;

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
  return AUTH_FAILURE_TEXT.test(String(error || ""));
}
