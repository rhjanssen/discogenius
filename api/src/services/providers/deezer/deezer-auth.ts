import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR } from "../../config/config.js";

export interface DeezerCredentials {
  /** Deezer web cookie used by Streamrip for account-quality downloads. */
  arl: string;
  /** When this ARL value was stored. Never log `arl`. */
  savedAt?: string;
}

/** A pasted Deezer web ARL is 192 hex characters. Shorter fixtures stay valid for the file writer. */
export const DEEZER_ARL_PATTERN = /^[0-9a-f]{192}$/i;

export function getDeezerConfigDir(): string {
  return path.join(CONFIG_DIR, "providers", "deezer");
}

export function getDeezerCredentialsPath(): string {
  return path.join(getDeezerConfigDir(), "auth.json");
}

export function loadDeezerCredentials(): DeezerCredentials | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(getDeezerCredentialsPath(), "utf8")) as Partial<DeezerCredentials>;
    const arl = String(parsed.arl || "").trim();
    if (!arl) return null;
    const savedAt = typeof parsed.savedAt === "string" && parsed.savedAt.trim() ? parsed.savedAt.trim() : undefined;
    return savedAt ? { arl, savedAt } : { arl };
  } catch {
    return null;
  }
}

export function saveDeezerCredentials(credentials: DeezerCredentials): void {
  const arl = String(credentials.arl || "").trim();
  if (arl.length < 16 || /[\r\n"']/u.test(arl)) {
    throw new Error("Deezer ARL must be a valid cookie value.");
  }

  const configDir = getDeezerConfigDir();
  fs.mkdirSync(configDir, { recursive: true });
  const target = getDeezerCredentialsPath();
  const previous = loadDeezerCredentials();
  const savedAt = String(credentials.savedAt || "").trim()
    || (previous?.arl === arl ? previous.savedAt : undefined)
    || new Date().toISOString();
  const temporary = `${target}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ arl, savedAt }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, target);
  try {
    fs.chmodSync(target, 0o600);
  } catch {
    // Windows does not implement POSIX ownership bits. The file still remains
    // inside the provider-owned config root rather than application config.
  }
}

/**
 * Persist a gw-light Set-Cookie arl when Deezer rotates it.
 * Ignores values that are not a 192-hex ARL. Does not log the cookie.
 */
export function adoptDeezerSetCookie(header: string | null | undefined): boolean {
  if (!header) return false;
  const match = header.match(/(?:^|[\s,])arl=([0-9a-f]{192})(?:;|$)/i);
  const arl = match?.[1];
  if (!arl || !DEEZER_ARL_PATTERN.test(arl)) return false;
  if (loadDeezerCredentials()?.arl === arl) return false;
  saveDeezerCredentials({ arl, savedAt: new Date().toISOString() });
  return true;
}

export function clearDeezerCredentials(): void {
  const credentialsPath = getDeezerCredentialsPath();
  for (const target of [
    credentialsPath,
    `${credentialsPath}.tmp`,
    path.join(getDeezerConfigDir(), "streamrip.toml"),
  ]) {
    fs.rmSync(target, { force: true });
  }
}
