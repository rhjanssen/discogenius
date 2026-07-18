import fs from "node:fs";
import { BlockList, isIP } from "node:net";
import path from "node:path";
import { CONFIG_DIR } from "../../config/config.js";

export const DEFAULT_AMAZON_MUSIC_API_BASE = "https://amz.dezalty.com";
export const ALLOW_PRIVATE_AMAZON_MUSIC_API_BASE_ENV = "DISCOGENIUS_ALLOW_PRIVATE_AMAZON_MUSIC_API_BASE";

export interface AmazonMusicCredentials {
  accessToken: string;
  apiBase: string;
}

export function getAmazonMusicConfigDir(): string {
  return path.join(CONFIG_DIR, "providers", "amazon-music");
}

export function getAmazonMusicCredentialsPath(): string {
  return path.join(getAmazonMusicConfigDir(), "auth.json");
}

const nonPublicIpv4Addresses = new BlockList();
const nonPublicIpv6Addresses = new BlockList();

for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  nonPublicIpv4Addresses.addSubnet(network, prefix, "ipv4");
}

for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  nonPublicIpv6Addresses.addSubnet(network, prefix, "ipv6");
}

function unbracketHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/gu, "").replace(/%.+$/u, "");
}

export function isPrivateAmazonMusicApiBaseAllowed(): boolean {
  return /^(?:1|true|yes|on)$/iu.test(String(process.env[ALLOW_PRIVATE_AMAZON_MUSIC_API_BASE_ENV] || "").trim());
}

export function isPublicAmazonMusicNetworkAddress(address: string): boolean {
  const normalized = unbracketHostname(String(address || "").trim());
  const family = isIP(normalized);
  if (family === 4) return !nonPublicIpv4Addresses.check(normalized, "ipv4");
  if (family === 6) return !nonPublicIpv6Addresses.check(normalized, "ipv6");
  return false;
}

function isExplicitPrivateHostname(hostname: string): boolean {
  const normalized = unbracketHostname(hostname).toLowerCase().replace(/\.$/u, "");
  if (isIP(normalized)) return !isPublicAmazonMusicNetworkAddress(normalized);
  if (!normalized.includes(".")) return true;
  return [
    ".localhost",
    ".local",
    ".internal",
    ".lan",
    ".home",
    ".home.arpa",
    ".test",
    ".invalid",
    ".example",
    ".onion",
  ].some((suffix) => normalized === suffix.slice(1) || normalized.endsWith(suffix));
}

export function normalizeAmazonMusicApiBase(raw: unknown): string {
  const value = String(raw || DEFAULT_AMAZON_MUSIC_API_BASE).trim().replace(/\/+$/u, "");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Amazon Music API base must be a valid URL.");
  }
  if (!(["https:", "http:"] as string[]).includes(parsed.protocol)) {
    throw new Error("Amazon Music API base must use HTTP or HTTPS.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Amazon Music API base must not include embedded credentials.");
  }
  if (parsed.hash || value.includes("#")) {
    throw new Error("Amazon Music API base must not include a URL fragment.");
  }

  const explicitlyPrivate = isExplicitPrivateHostname(parsed.hostname);
  if (explicitlyPrivate && !isPrivateAmazonMusicApiBaseAllowed()) {
    throw new Error(
      `Amazon Music API base must use a public HTTPS host. Private or loopback endpoints require ${ALLOW_PRIVATE_AMAZON_MUSIC_API_BASE_ENV}=true.`,
    );
  }
  if (parsed.protocol !== "https:" && !explicitlyPrivate) {
    throw new Error("Amazon Music API base must use HTTPS for public hosts.");
  }
  return parsed.toString().replace(/\/+$/u, "");
}

export function loadAmazonMusicCredentials(): AmazonMusicCredentials | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(getAmazonMusicCredentialsPath(), "utf8")) as Partial<AmazonMusicCredentials>;
    const accessToken = String(parsed.accessToken || "").trim();
    if (!accessToken) return null;
    return { accessToken, apiBase: normalizeAmazonMusicApiBase(parsed.apiBase) };
  } catch {
    return null;
  }
}

export function saveAmazonMusicCredentials(credentials: AmazonMusicCredentials): void {
  const accessToken = String(credentials.accessToken || "").trim();
  if (accessToken.length < 8 || /[\r\n]/u.test(accessToken)) {
    throw new Error("Amazon Music API access token is invalid.");
  }
  const value: AmazonMusicCredentials = {
    accessToken,
    apiBase: normalizeAmazonMusicApiBase(credentials.apiBase),
  };
  const directory = getAmazonMusicConfigDir();
  fs.mkdirSync(directory, { recursive: true });
  const target = getAmazonMusicCredentialsPath();
  const temporary = `${target}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, target);
  try {
    fs.chmodSync(target, 0o600);
  } catch {
    // POSIX modes are unavailable on Windows.
  }
}

export function clearAmazonMusicCredentials(): void {
  fs.rmSync(getAmazonMusicCredentialsPath(), { force: true });
}
