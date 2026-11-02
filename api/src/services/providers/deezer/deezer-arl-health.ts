import { DeezerGwApiError, createDeezerGwSession, type DeezerGwFetchLike, type DeezerGwSession } from "./deezer-gw-api.js";
import { DEEZER_ARL_PATTERN, loadDeezerCredentials, saveDeezerCredentials } from "./deezer-auth.js";
import { ProviderAuthError } from "../provider-auth-error.js";
import { providerAuthLastProbeAt, recordProviderAuthFailure, recordProviderAuthOk } from "../provider-auth-state.js";

/** One gw getUserData probe. Not a per-album or per-tick check. */
export const DEEZER_AUTH_PROBE_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** After a network failure, don't probe again on every queue tick. */
export const DEEZER_AUTH_PROBE_BACKOFF_MS = 15 * 60 * 1000;

export interface DeezerAccountInfo {
  name: string;
  plan: string;
  country: string;
  label: string;
  userId: number;
}

let nextProbeNotBefore = 0;
let probeLoop: ReturnType<typeof setInterval> | null = null;

export function resetDeezerAuthProbeForTests(): void {
  nextProbeNotBefore = 0;
}

export function assertDeezerArlFormat(arl: string): string {
  const trimmed = String(arl || "").trim();
  if (!DEEZER_ARL_PATTERN.test(trimmed)) {
    throw new ProviderAuthError(
      "deezer",
      "De ARL moet 192 hex-tekens zijn. Plak de arl-cookie uit een ingelogde Deezer-sessie.",
      "invalid_arl",
    );
  }
  return trimmed;
}

export function deezerAccountFromSession(session: DeezerGwSession): DeezerAccountInfo {
  return {
    name: session.accountName,
    plan: session.plan,
    country: session.country,
    label: `${session.accountName} · ${session.plan} · ${session.country}`,
    userId: session.userId,
  };
}

/**
 * Format-check, then deezer.getUserData. An invalid paste is not stored.
 * A network failure does not change the saved ARL or the auth state.
 */
export async function validateAndSaveDeezerArl(
  arl: string,
  fetchImpl?: DeezerGwFetchLike,
): Promise<DeezerAccountInfo> {
  const formatted = assertDeezerArlFormat(arl);
  let session: DeezerGwSession;
  try {
    session = await createDeezerGwSession(formatted, fetchImpl);
  } catch (error) {
    if (error instanceof DeezerGwApiError && error.status === 401) {
      const stored = loadDeezerCredentials()?.arl;
      if (!stored || stored === formatted) {
        await recordProviderAuthFailure("deezer", "Deezer ARL is invalid or expired.");
      }
      throw new ProviderAuthError("deezer", "Deze ARL is ongeldig of verlopen. Plak een nieuwe arl-cookie.");
    }
    throw new Error("Deezer is niet bereikbaar. De ARL is niet opgeslagen.");
  }
  const savedAt = new Date().toISOString();
  const before = loadDeezerCredentials()?.savedAt ?? null;
  saveDeezerCredentials({ arl: formatted, savedAt });
  const account = deezerAccountFromSession(session);
  const rotatedAt = loadDeezerCredentials()?.savedAt;
  await recordProviderAuthOk("deezer", {
    accountLabel: account.label,
    credentialSavedAt: rotatedAt && rotatedAt !== before ? rotatedAt : savedAt,
    probedAt: savedAt,
  });
  return account;
}

async function probeStoredDeezerArl(fetchImpl?: DeezerGwFetchLike): Promise<"ok" | "needs_reauth" | "skipped"> {
  const stored = loadDeezerCredentials();
  if (!stored?.arl) return "skipped";
  const beforeSavedAt = stored.savedAt ?? null;
  try {
    const session = await createDeezerGwSession(stored.arl, fetchImpl);
    const probedAt = new Date().toISOString();
    const afterSavedAt = loadDeezerCredentials()?.savedAt ?? null;
    await recordProviderAuthOk("deezer", {
      accountLabel: deezerAccountFromSession(session).label,
      probedAt,
      ...(afterSavedAt && afterSavedAt !== beforeSavedAt ? { credentialSavedAt: afterSavedAt } : {}),
    });
    nextProbeNotBefore = 0;
    return "ok";
  } catch (error) {
    if (error instanceof DeezerGwApiError && error.status === 401) {
      await recordProviderAuthFailure("deezer", "Deezer ARL is invalid or expired.");
      return "needs_reauth";
    }
    nextProbeNotBefore = Date.now() + DEEZER_AUTH_PROBE_BACKOFF_MS;
    return "skipped";
  }
}

/** Health probe. Does nothing when no ARL is stored, so an unused Deezer stays quiet. */
export async function runDeezerAuthProbe(fetchImpl?: DeezerGwFetchLike): Promise<"ok" | "needs_reauth" | "skipped"> {
  return probeStoredDeezerArl(fetchImpl);
}

/**
 * Before a Deezer batch that has been idle. One network call when the last
 * successful probe is older than 6h. A network error backs off in memory for
 * 15 minutes and does not write.
 */
export async function probeDeezerBeforeDownloadBatch(fetchImpl?: DeezerGwFetchLike): Promise<void> {
  if (!loadDeezerCredentials()?.arl) {
    await recordProviderAuthFailure("deezer", "Deezer ARL is invalid or expired.");
    return;
  }
  if (Date.now() < nextProbeNotBefore) return;
  const last = providerAuthLastProbeAt("deezer");
  const parsed = last ? Date.parse(last) : Number.NaN;
  if (Number.isFinite(parsed) && Date.now() - parsed < DEEZER_AUTH_PROBE_INTERVAL_MS) return;
  await probeStoredDeezerArl(fetchImpl);
}

export function startDeezerAuthProbeLoop(fetchImpl?: DeezerGwFetchLike): void {
  if (probeLoop) return;
  probeLoop = setInterval(() => {
    void runDeezerAuthProbe(fetchImpl).catch((error) => {
      console.error("[DEEZER] Auth probe failed:", error instanceof Error ? error.message : "unknown");
    });
  }, DEEZER_AUTH_PROBE_INTERVAL_MS);
  probeLoop.unref?.();
}

export function stopDeezerAuthProbeLoop(): void {
  if (!probeLoop) return;
  clearInterval(probeLoop);
  probeLoop = null;
}
