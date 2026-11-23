import type Database from "better-sqlite3";
import { readIntEnv } from "../../utils/env.js";
import { presentFailure } from "../commands/failure-presentation.js";
import { getYouTubeMusicCredentialState } from "../providers/youtube-music/youtube-music-auth.js";

export const REPEATED_OFFER_FAILURE_THRESHOLD = readIntEnv(
  "DISCOGENIUS_OFFER_FAILURE_THRESHOLD",
  3,
  1,
);

export const PERMANENTLY_UNAVAILABLE_STATUSES = [
  "0",
  "false",
  "unavailable",
  "no",
  "",
  "no_longer_available",
  "geography_restricted",
  "entitlement_restricted",
  "explicit_policy_ineligible",
  "quality_unavailable",
] as const;

const UNAVAILABLE_STATUS_SET = new Set<string>(PERMANENTLY_UNAVAILABLE_STATUSES);

const OFFER_FAILURE_KEY_PREFIX = "download.offer_failure.";

export type OfferFailureTarget = {
  provider: string;
  entityType: "track" | "album" | "release" | "video";
  providerId: string;
};

export interface OfferFailureSignature {
  signature: string;
  category: string;
  summary: string;
  detail: string;
}

export interface RepeatedOfferFailureResult {
  count: number;
  markedUnavailable: boolean;
  signature: string | null;
}

export function isYouTubeCookiesConfigured(): boolean {
  return getYouTubeMusicCredentialState().cookiesConfigured;
}

export function isOfferAvailabilityUsable(
  value: unknown,
  provider?: string | null,
): boolean {
  const availability = String(value ?? "unknown").trim().toLowerCase();
  if (UNAVAILABLE_STATUS_SET.has(availability)) return false;
  if (availability === "needs_cookies") {
    const normalizedProvider = String(provider ?? "").trim().toLowerCase();
    if (!normalizedProvider || normalizedProvider === "youtube-music") {
      return isYouTubeCookiesConfigured();
    }
    return false;
  }
  return true;
}

/**
 * SQL predicate that drops permanently unavailable offers and, while YouTube
 * cookies are not configured, skips offers marked `needs_cookies`.
 */
export function providerItemAvailableSql(
  availabilityColumn: string,
  providerColumn?: string,
): string {
  const unavailableList = PERMANENTLY_UNAVAILABLE_STATUSES.map((s) => `'${s}'`).join(", ");
  const cookiesClause = isYouTubeCookiesConfigured()
    ? ""
    : providerColumn
      ? ` AND NOT (LOWER(CAST(${providerColumn} AS TEXT)) = 'youtube-music' AND LOWER(CAST(${availabilityColumn} AS TEXT)) = 'needs_cookies')`
      : ` AND LOWER(CAST(${availabilityColumn} AS TEXT)) != 'needs_cookies'`;
  return `(
    ${availabilityColumn} IS NULL
    OR (
      LOWER(CAST(${availabilityColumn} AS TEXT)) NOT IN (${unavailableList})${cookiesClause}
    )
  )`;
}

function normalizeOfferEntityType(entityType: OfferFailureTarget["entityType"]): "track" | "release" | "video" {
  return entityType === "album" ? "release" : entityType;
}

function offerFailureConfigKey(target: OfferFailureTarget): string | null {
  const provider = String(target.provider || "").trim().toLowerCase();
  const providerId = String(target.providerId || "").trim();
  if (!provider || !providerId) return null;
  const entityType = normalizeOfferEntityType(target.entityType);
  return `${OFFER_FAILURE_KEY_PREFIX}${provider}.${entityType}.${providerId}`;
}

/**
 * Reuse `presentFailure` to classify an offer error into a stable signature for
 * repeated-failure detection. Transient, account, storage, interrupted, and
 * local-import failures return null so they never mark a provider offer
 * unavailable.
 */
export function classifyRepeatableOfferFailure(
  error: unknown,
  provider: string,
): OfferFailureSignature | null {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const presented = presentFailure(raw, { provider });
  if (!presented) return null;

  if (
    presented.category === "network"
    || presented.category === "rate-limit"
    || presented.category === "interrupted"
    || presented.category === "storage"
    || presented.category === "import"
    || presented.category === "account"
  ) {
    return null;
  }

  if (presented.category === "quality" && /plan doesn't include/iu.test(presented.summary)) {
    return null;
  }

  if (
    presented.category === "unknown"
    && (
      /database stayed busy/iu.test(presented.summary)
      || /failed without giving a reason/iu.test(presented.summary)
    )
  ) {
    return null;
  }

  return {
    signature: `${presented.category}:${presented.summary}`,
    category: presented.category,
    summary: presented.summary,
    detail: presented.detail,
  };
}

export function hasOfferFailureStreakOrNeedsCookies(
  database: Database.Database,
  target: OfferFailureTarget,
): boolean {
  const key = offerFailureConfigKey(target);
  if (!key) return false;
  const streak = database.prepare("SELECT 1 FROM config WHERE key = ?").get(key);
  if (streak) return true;
  const provider = String(target.provider || "").trim().toLowerCase();
  const entityType = normalizeOfferEntityType(target.entityType);
  const providerId = String(target.providerId || "").trim();
  const row = database.prepare(`
    SELECT 1 FROM ProviderItems
    WHERE provider = ? AND entity_type = ? AND provider_id = ? AND availability = 'needs_cookies'
  `).get(provider, entityType, providerId);
  return Boolean(row);
}

export function clearOfferFailureStreak(
  database: Database.Database,
  target: OfferFailureTarget,
): void {
  const key = offerFailureConfigKey(target);
  if (!key) return;
  database.prepare("DELETE FROM config WHERE key = ?").run(key);
}

export function clearOfferFailureStateOnSuccess(
  database: Database.Database,
  target: OfferFailureTarget,
): void {
  clearOfferFailureStreak(database, target);
  const provider = String(target.provider || "").trim().toLowerCase();
  const entityType = normalizeOfferEntityType(target.entityType);
  const providerId = String(target.providerId || "").trim();
  if (!provider || !providerId) return;
  database.prepare(`
    UPDATE ProviderItems
    SET availability = 'available', availability_reason = NULL, checked_at = ?
    WHERE provider = ? AND entity_type = ? AND provider_id = ? AND availability IN ('needs_cookies', 'unavailable')
  `).run(new Date().toISOString(), provider, entityType, providerId);
}

/**
 * Record one failed download attempt for a provider offer. When the same
 * deterministic failure repeats `threshold` times in a row, mark the offer
 * `unavailable` in `ProviderItems` and clear the counter.
 */
export function recordRepeatedOfferFailure(
  database: Database.Database,
  input: OfferFailureTarget & { error: unknown; threshold?: number },
): RepeatedOfferFailureResult {
  const key = offerFailureConfigKey(input);
  if (!key) {
    return { count: 0, markedUnavailable: false, signature: null };
  }

  const provider = String(input.provider || "").trim().toLowerCase();
  const entityType = normalizeOfferEntityType(input.entityType);
  const providerId = String(input.providerId || "").trim();
  const classified = classifyRepeatableOfferFailure(input.error, provider);
  if (!classified) {
    return { count: 0, markedUnavailable: false, signature: null };
  }

  const threshold = Math.max(1, input.threshold ?? REPEATED_OFFER_FAILURE_THRESHOLD);
  const existingRow = database.prepare("SELECT value FROM config WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  let previousCount = 0;
  if (existingRow?.value) {
    try {
      const parsed = JSON.parse(existingRow.value) as { signature?: string; count?: number };
      if (parsed.signature === classified.signature && Number.isInteger(parsed.count) && (parsed.count ?? 0) > 0) {
        previousCount = parsed.count!;
      }
    } catch {
      previousCount = 0;
    }
  }

  const nextCount = previousCount + 1;
  const now = new Date().toISOString();
  if (nextCount >= threshold) {
    const reason = `Repeated failure (${nextCount}x): ${classified.detail}`;
    database.prepare(`
      UPDATE ProviderItems
      SET availability = 'unavailable', availability_reason = ?, checked_at = ?
      WHERE provider = ? AND entity_type = ? AND provider_id = ?
    `).run(reason, now, provider, entityType, providerId);
    database.prepare("DELETE FROM config WHERE key = ?").run(key);
    return { count: nextCount, markedUnavailable: true, signature: classified.signature };
  }

  database.prepare(`
    INSERT INTO config (key, value, description, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    key,
    JSON.stringify({
      signature: classified.signature,
      count: nextCount,
      lastSeenAt: now,
    }),
    "Consecutive deterministic download failures for a provider offer",
  );
  return { count: nextCount, markedUnavailable: false, signature: classified.signature };
}
