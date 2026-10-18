import { db, withSqliteWriteGate } from "../../database.js";
import { appEvents, AppEvent } from "../commands/app-events.js";
import { normalizeProviderId } from "./provider-auth-error.js";

export type ProviderAuthStatus = "ok" | "needs_reauth" | "unknown";

export interface ProviderAuthCopy {
  provider: string;
  banner: string;
  queueMessage: string;
  href: string;
  settingsLabel: string;
}

export interface ProviderAuthPublic {
  provider: string;
  status: ProviderAuthStatus;
  since: string | null;
  lastOkAt: string | null;
  lastError: string | null;
  accountLabel: string | null;
  credentialSavedAt: string | null;
  credentialAgeDays: number | null;
  ageWarning: string | null;
  held: number;
  banner: string | null;
  queueMessage: string | null;
  href: string | null;
  settingsLabel: string | null;
}

export interface ProviderAuthTransition {
  provider: string;
  status: ProviderAuthStatus;
  transitioned: boolean;
  persisted: boolean;
}

const ARL_WARN_AFTER_DAYS = 75;
const OK_TOUCH_INTERVAL_MS = 6 * 60 * 60 * 1000;

interface ProviderAuthRow {
  provider: string;
  status: ProviderAuthStatus;
  last_ok_at: string | null;
  last_error: string | null;
  since: string | null;
  notified_status: string | null;
  account_label: string | null;
  credential_saved_at: string | null;
  last_probe_at: string | null;
  updated_at: string;
}

let tableReady: boolean | null = null;
let cacheLoaded = false;
const cache = new Map<string, ProviderAuthRow>();

const COPY: Record<string, Omit<ProviderAuthCopy, "provider">> = {
  tidal: {
    banner: "Tidal opnieuw inloggen",
    queueMessage: "Waiting for Tidal login",
    href: "/auth?provider=tidal#provider-connect-tidal",
    settingsLabel: "Naar Tidal-login",
  },
  deezer: {
    banner: "Deezer opnieuw koppelen",
    queueMessage: "Waiting for Deezer login",
    href: "/auth?provider=deezer#deezer-arl",
    settingsLabel: "Naar Deezer-ARL",
  },
};

export function providerAuthCopy(provider: string): ProviderAuthCopy {
  const id = normalizeProviderId(provider);
  const known = COPY[id];
  if (known) return { provider: id, ...known };
  const label = id || "provider";
  return {
    provider: id,
    banner: `${label} opnieuw koppelen`,
    queueMessage: `Waiting for ${label} login`,
    href: `/auth?provider=${encodeURIComponent(id)}`,
    settingsLabel: `Naar ${label}`,
  };
}

export function queueHoldMessage(provider: string): string {
  return providerAuthCopy(provider).queueMessage;
}

export function authHoldRecord(provider: string): { provider: string; message: string } {
  const copy = providerAuthCopy(provider);
  return { provider: copy.provider, message: copy.queueMessage };
}

export function authHoldMessageFromPayload(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const message = (value as { message?: unknown }).message;
  return typeof message === "string" && message.trim() ? message : undefined;
}

export function resetProviderAuthCacheForTests(): void {
  tableReady = null;
  cacheLoaded = false;
  cache.clear();
}

function authTableReady(): boolean {
  if (tableReady === true) return true;
  try {
    const row = db.prepare(`
      SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'ProviderAuthState'
    `).get() as { present?: number } | undefined;
    if (row) tableReady = true;
    return Boolean(row);
  } catch {
    return false;
  }
}

function loadCache(): void {
  if (cacheLoaded || !authTableReady()) return;
  const rows = db.prepare(`SELECT * FROM ProviderAuthState`).all() as ProviderAuthRow[];
  cache.clear();
  for (const row of rows) cache.set(row.provider, row);
  cacheLoaded = true;
}

function readRow(provider: string): ProviderAuthRow | null {
  const id = normalizeProviderId(provider);
  if (!id || !authTableReady()) return null;
  loadCache();
  return cache.get(id) ?? null;
}

export function providerNeedsReauth(provider: string): boolean {
  return readRow(provider)?.status === "needs_reauth";
}

function isoNow(): string {
  return new Date().toISOString();
}

function ageDays(savedAt: string | null, now = Date.now()): number | null {
  if (!savedAt) return null;
  const parsed = Date.parse(savedAt);
  if (!Number.isFinite(parsed)) return null;
  return Math.floor((now - parsed) / 86_400_000);
}

function recentOk(row: ProviderAuthRow | null, now = Date.now()): boolean {
  if (!row?.last_ok_at) return false;
  const parsed = Date.parse(row.last_ok_at);
  return Number.isFinite(parsed) && now - parsed < OK_TOUCH_INTERVAL_MS;
}

function heldCount(provider: string): number {
  if (!authTableReady()) return 0;
  try {
    const row = db.prepare(`
      SELECT COUNT(*) AS count
      FROM DownloadQueue
      WHERE command_id IS NULL
        AND lower(COALESCE(provider, '')) = ?
    `).get(provider) as { count?: number } | undefined;
    return Number(row?.count || 0);
  } catch {
    return 0;
  }
}

function stampHeld(provider: string, message: string): void {
  const payload = JSON.stringify({ provider, message });
  db.prepare(`
    UPDATE DownloadQueue
    SET payload = json_set(
          CASE WHEN json_valid(payload) THEN payload ELSE '{}' END,
          '$.authHold',
          json(?)
        ),
        updated_at = CURRENT_TIMESTAMP
    WHERE command_id IS NULL
      AND lower(COALESCE(provider, '')) = ?
      AND (
        json_valid(payload) = 0
        OR json_extract(payload, '$.authHold.message') IS NULL
        OR json_extract(payload, '$.authHold.message') != ?
      )
  `).run(payload, provider, message);
}

function clearHeld(provider: string): void {
  db.prepare(`
    UPDATE DownloadQueue
    SET payload = json_remove(
          CASE WHEN json_valid(payload) THEN payload ELSE '{}' END,
          '$.authHold'
        ),
        updated_at = CURRENT_TIMESTAMP
    WHERE command_id IS NULL
      AND json_valid(payload)
      AND json_extract(payload, '$.authHold.provider') = ?
  `).run(provider);
}

function emitTransition(row: ProviderAuthRow): void {
  const copy = row.status === "needs_reauth" ? providerAuthCopy(row.provider) : null;
  appEvents.emit(AppEvent.PROVIDER_AUTH_CHANGED, {
    provider: row.provider,
    status: row.status,
    banner: copy?.banner ?? null,
    queueMessage: copy?.queueMessage ?? null,
    held: row.status === "needs_reauth" ? heldCount(row.provider) : 0,
    href: copy?.href ?? null,
    settingsLabel: copy?.settingsLabel ?? null,
  });
}

function persistRow(row: ProviderAuthRow): void {
  db.prepare(`
    INSERT INTO ProviderAuthState (
      provider, status, last_ok_at, last_error, since, notified_status,
      account_label, credential_saved_at, last_probe_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider) DO UPDATE SET
      status = excluded.status,
      last_ok_at = excluded.last_ok_at,
      last_error = excluded.last_error,
      since = excluded.since,
      notified_status = excluded.notified_status,
      account_label = excluded.account_label,
      credential_saved_at = excluded.credential_saved_at,
      last_probe_at = excluded.last_probe_at,
      updated_at = excluded.updated_at
  `).run(
    row.provider,
    row.status,
    row.last_ok_at,
    row.last_error,
    row.since,
    row.notified_status,
    row.account_label,
    row.credential_saved_at,
    row.last_probe_at,
    row.updated_at,
  );
}

function remember(row: ProviderAuthRow): void {
  cache.set(row.provider, row);
  cacheLoaded = true;
}

export async function recordProviderAuthFailure(provider: string, message: string): Promise<ProviderAuthTransition> {
  const id = normalizeProviderId(provider);
  if (!id || !authTableReady()) return { provider: id, status: "unknown", transitioned: false, persisted: false };
  loadCache();
  const current = cache.get(id) ?? null;
  // Already held. A second refresh failure must not write or notify again.
  if (current?.status === "needs_reauth") {
    return { provider: id, status: "needs_reauth", transitioned: false, persisted: false };
  }
  const now = isoNow();
  const copy = providerAuthCopy(id);
  const row: ProviderAuthRow = {
    provider: id,
    status: "needs_reauth",
    last_ok_at: current?.last_ok_at ?? null,
    last_error: message.slice(0, 500),
    since: now,
    notified_status: "needs_reauth",
    account_label: current?.account_label ?? null,
    credential_saved_at: current?.credential_saved_at ?? null,
    last_probe_at: current?.last_probe_at ?? null,
    updated_at: now,
  };
  await withSqliteWriteGate(() => {
    const write = db.transaction(() => {
      persistRow(row);
      stampHeld(id, copy.queueMessage);
    });
    write();
  }, "provider-auth:needs-reauth");
  remember(row);
  emitTransition(row);
  return { provider: id, status: "needs_reauth", transitioned: true, persisted: true };
}

export interface RecordProviderAuthOkOptions {
  accountLabel?: string | null;
  credentialSavedAt?: string | null;
  probedAt?: string | null;
}

export async function recordProviderAuthOk(provider: string, options: RecordProviderAuthOkOptions = {}): Promise<ProviderAuthTransition> {
  const id = normalizeProviderId(provider);
  if (!id || !authTableReady()) return { provider: id, status: "unknown", transitioned: false, persisted: false };
  loadCache();
  const current = cache.get(id) ?? null;
  const now = isoNow();
  const accountLabel = options.accountLabel === undefined ? current?.account_label ?? null : options.accountLabel;
  const credentialSavedAt = options.credentialSavedAt === undefined
    ? current?.credential_saved_at ?? null
    : options.credentialSavedAt;
  const probedAt = options.probedAt === undefined ? current?.last_probe_at ?? null : options.probedAt;
  const labelChanged = (accountLabel ?? null) !== (current?.account_label ?? null);
  const credentialChanged = (credentialSavedAt ?? null) !== (current?.credential_saved_at ?? null);
  const probeChanged = (probedAt ?? null) !== (current?.last_probe_at ?? null);
  const alreadyOk = current?.status === "ok";
  // Steady state: a healthy provider refreshes often. Touch the row at most
  // every 6h unless the account label, saved credential, or probe time changed.
  if (alreadyOk && !labelChanged && !credentialChanged && !probeChanged && recentOk(current)) {
    return { provider: id, status: "ok", transitioned: false, persisted: false };
  }
  const transitioned = !alreadyOk;
  // A first successful login is not a recovery. Notify only when leaving needs_reauth.
  const notify = current?.status === "needs_reauth";
  const row: ProviderAuthRow = {
    provider: id,
    status: "ok",
    last_ok_at: now,
    last_error: null,
    since: transitioned ? now : current?.since ?? now,
    notified_status: notify ? "ok" : current?.notified_status ?? null,
    account_label: accountLabel,
    credential_saved_at: credentialSavedAt,
    last_probe_at: probedAt,
    updated_at: now,
  };
  await withSqliteWriteGate(() => {
    const write = db.transaction(() => {
      persistRow(row);
      if (transitioned) clearHeld(id);
    });
    write();
  }, "provider-auth:ok");
  remember(row);
  if (notify) emitTransition(row);
  return { provider: id, status: "ok", transitioned, persisted: true };
}

/** A probe ran but the network failed. Status is left alone. No steady-state write. */
export function noteProviderAuthProbeSkipped(provider: string): void {
  void provider;
}

export function providerAuthLastProbeAt(provider: string): string | null {
  return readRow(provider)?.last_probe_at ?? null;
}

export function toPublicProviderAuth(row: ProviderAuthRow, now = Date.now()): ProviderAuthPublic {
  const days = ageDays(row.credential_saved_at, now);
  const ageWarning = row.provider === "deezer" && days != null && days >= ARL_WARN_AFTER_DAYS
    ? `Deze ARL is ${days} dagen oud. Plak een nieuwe voor hij verloopt.`
    : null;
  const copy = row.status === "needs_reauth" ? providerAuthCopy(row.provider) : null;
  return {
    provider: row.provider,
    status: row.status,
    since: row.since,
    lastOkAt: row.last_ok_at,
    lastError: row.last_error,
    accountLabel: row.account_label,
    credentialSavedAt: row.credential_saved_at,
    credentialAgeDays: days,
    ageWarning,
    held: row.status === "needs_reauth" ? heldCount(row.provider) : 0,
    banner: copy?.banner ?? null,
    queueMessage: copy?.queueMessage ?? null,
    href: copy?.href ?? null,
    settingsLabel: copy?.settingsLabel ?? null,
  };
}

export function listProviderAuthPublic(): ProviderAuthPublic[] {
  if (!authTableReady()) return [];
  loadCache();
  return [...cache.values()]
    .sort((a, b) => a.provider.localeCompare(b.provider))
    .map((row) => toPublicProviderAuth(row));
}

export function readProviderAuthPublic(provider: string): ProviderAuthPublic | null {
  const row = readRow(provider);
  return row ? toPublicProviderAuth(row) : null;
}

export const PROVIDER_AUTH_ARL_WARN_AFTER_DAYS = ARL_WARN_AFTER_DAYS;
