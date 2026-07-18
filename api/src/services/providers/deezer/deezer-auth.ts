import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR } from "../../config/config.js";

export interface DeezerCredentials {
  /** Deezer web cookie used by Streamrip for account-quality downloads. */
  arl: string;
}

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
    return arl ? { arl } : null;
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
  const temporary = `${target}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ arl }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, target);
  try {
    fs.chmodSync(target, 0o600);
  } catch {
    // Windows does not implement POSIX ownership bits. The file still remains
    // inside the provider-owned config root rather than application config.
  }
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
