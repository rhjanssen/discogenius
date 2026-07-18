import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR } from "../../config/config.js";

export interface SpotifyCredentials {
  clientId: string;
  clientSecret: string;
  /** Absolute or provider-config-relative Netscape cookies file for Votify. */
  cookiesPath?: string | null;
}

export interface SpotifyCredentialInput {
  clientId?: unknown;
  clientSecret?: unknown;
  cookiesPath?: unknown;
  cookiesText?: unknown;
  /** Accepted aliases make generic provider credential forms easier to wire. */
  client_id?: unknown;
  client_secret?: unknown;
  netscapeCookies?: unknown;
  cookies?: unknown;
}

export interface SpotifyAuthStore {
  load(): SpotifyCredentials | null;
  save(input: SpotifyCredentialInput): SpotifyCredentials;
  clear(): void;
}

export const SPOTIFY_PROVIDER_DIR = path.join(CONFIG_DIR, "providers", "spotify");
export const SPOTIFY_CREDENTIALS_FILE = path.join(SPOTIFY_PROVIDER_DIR, "credentials.json");
export const SPOTIFY_COOKIES_FILE = path.join(SPOTIFY_PROVIDER_DIR, "cookies.txt");

function nonEmptyString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function writePrivateFile(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, contents, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Windows ACLs do not map cleanly to POSIX modes. The provider-owned
    // directory still keeps these artifacts out of application config.
  }
}

export function looksLikeNetscapeCookies(contents: string): boolean {
  const trimmed = contents.trim();
  if (!trimmed) return false;
  if (/^#\s*Netscape HTTP Cookie File/im.test(trimmed)) return true;
  return trimmed.split(/\r?\n/).some((line) => {
    if (!line || line.startsWith("#")) return false;
    return line.split("\t").length >= 7;
  });
}

export class FileSpotifyAuthStore implements SpotifyAuthStore {
  readonly providerDir: string;
  readonly credentialsFile: string;
  readonly ownedCookiesFile: string;

  constructor(providerDir = SPOTIFY_PROVIDER_DIR) {
    this.providerDir = providerDir;
    this.credentialsFile = path.join(providerDir, "credentials.json");
    this.ownedCookiesFile = path.join(providerDir, "cookies.txt");
  }

  load(): SpotifyCredentials | null {
    if (!fs.existsSync(this.credentialsFile)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.credentialsFile, "utf8")) as Partial<SpotifyCredentials>;
      const clientId = nonEmptyString(parsed.clientId);
      const clientSecret = nonEmptyString(parsed.clientSecret);
      if (!clientId || !clientSecret) return null;
      const savedCookiesPath = nonEmptyString(parsed.cookiesPath);
      const cookiesPath = savedCookiesPath
        ? (path.isAbsolute(savedCookiesPath) ? savedCookiesPath : path.resolve(this.providerDir, savedCookiesPath))
        : (fs.existsSync(this.ownedCookiesFile) ? this.ownedCookiesFile : null);
      return { clientId, clientSecret, cookiesPath };
    } catch {
      return null;
    }
  }

  save(input: SpotifyCredentialInput): SpotifyCredentials {
    const clientId = nonEmptyString(input.clientId ?? input.client_id);
    const clientSecret = nonEmptyString(input.clientSecret ?? input.client_secret);
    if (!clientId || !clientSecret) {
      throw new Error("Spotify clientId and clientSecret are required");
    }

    const cookiesText = nonEmptyString(input.cookiesText ?? input.netscapeCookies ?? input.cookies);
    let cookiesPath = nonEmptyString(input.cookiesPath) || null;
    if (cookiesText) {
      if (!looksLikeNetscapeCookies(cookiesText)) {
        throw new Error("Spotify cookies must use Netscape cookies.txt format");
      }
      writePrivateFile(this.ownedCookiesFile, `${cookiesText.trimEnd()}\n`);
      cookiesPath = this.ownedCookiesFile;
    }

    fs.mkdirSync(this.providerDir, { recursive: true, mode: 0o700 });
    const persistedCookiesPath = cookiesPath === this.ownedCookiesFile
      ? path.basename(this.ownedCookiesFile)
      : cookiesPath;
    writePrivateFile(this.credentialsFile, `${JSON.stringify({
      clientId,
      clientSecret,
      cookiesPath: persistedCookiesPath,
    }, null, 2)}\n`);
    return { clientId, clientSecret, cookiesPath };
  }

  clear(): void {
    fs.rmSync(this.credentialsFile, { force: true });
    fs.rmSync(this.ownedCookiesFile, { force: true });
  }
}

export const spotifyAuthStore = new FileSpotifyAuthStore();

export function loadStoredSpotifyCredentials(): SpotifyCredentials | null {
  return spotifyAuthStore.load();
}

export function saveStoredSpotifyCredentials(input: SpotifyCredentialInput): SpotifyCredentials {
  return spotifyAuthStore.save(input);
}

export function clearStoredSpotifyCredentials(): void {
  spotifyAuthStore.clear();
}

