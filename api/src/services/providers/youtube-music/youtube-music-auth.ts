import fs from "node:fs";
import path from "node:path";

import { CONFIG_DIR } from "../../config/config.js";

export interface YouTubeMusicCredentialsInput {
  /** ytmusicapi browser headers, either as a JSON object or serialized JSON. */
  headers?: unknown;
  /** Netscape cookies.txt content or a raw Cookie header. */
  cookies?: unknown;
}

export interface YouTubeMusicCredentialState {
  browserHeadersConfigured: boolean;
  cookiesConfigured: boolean;
}

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const COOKIE_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const COOKIE_EXPIRY = "2147483647";
const YOUTUBE_MUSIC_COOKIE_HOST = "music.youtube.com";
const HTTP_ONLY_PREFIX = "#HttpOnly_";

export const YOUTUBE_MUSIC_PROVIDER_DIR = path.join(CONFIG_DIR, "providers", "youtube-music");
export const YOUTUBE_MUSIC_HEADERS_FILE = path.join(YOUTUBE_MUSIC_PROVIDER_DIR, "browser.json");
export const YOUTUBE_MUSIC_COOKIES_FILE = path.join(YOUTUBE_MUSIC_PROVIDER_DIR, "cookies.txt");

function parseHeaders(input: unknown): Record<string, string> {
  if (input == null || input === "") return {};
  let value = input;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      throw new Error("YouTube Music browser headers must be a valid JSON object.");
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("YouTube Music browser headers must be a JSON object.");
  }

  const result: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(value as Record<string, unknown>)) {
    const name = rawName.trim();
    if (!HEADER_NAME.test(name)) {
      throw new Error(`YouTube Music browser header name is invalid: ${rawName}`);
    }
    if (typeof rawValue !== "string" && typeof rawValue !== "number" && typeof rawValue !== "boolean") {
      throw new Error(`YouTube Music browser header ${name} must have a scalar value.`);
    }
    const headerValue = String(rawValue).trim();
    if (/\r|\n|\0/u.test(headerValue)) {
      throw new Error(`YouTube Music browser header ${name} contains an invalid control character.`);
    }
    if (headerValue) result[name] = headerValue;
  }
  return result;
}

function normalizeNetscapeCookies(content: string): { netscape: string; cookieHeader: string } {
  const rows: string[] = [];
  const pairs: string[] = [];
  for (const line of content.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || (trimmed.startsWith("#") && !trimmed.startsWith(HTTP_ONLY_PREFIX))) continue;
    const fields = line.split("\t");
    if (fields.length < 7) {
      throw new Error("YouTube Music cookies.txt has a malformed Netscape cookie row.");
    }
    const rawDomain = (fields[0] || "").trim();
    const cookieDomain = (rawDomain.startsWith(HTTP_ONLY_PREFIX)
      ? rawDomain.slice(HTTP_ONLY_PREFIX.length)
      : rawDomain).replace(/^\./u, "").toLowerCase();
    const includeSubdomains = (fields[1] || "").trim().toUpperCase();
    const name = fields[5]?.trim() || "";
    const value = fields.slice(6).join("\t").trim();
    if (
      !cookieDomain
      || !["TRUE", "FALSE"].includes(includeSubdomains)
      || !COOKIE_NAME.test(name)
      || /\r|\n|\0/u.test(value)
    ) {
      throw new Error("YouTube Music cookies.txt contains an invalid cookie.");
    }

    const youtubeOwnedDomain = cookieDomain === "youtube.com" || cookieDomain.endsWith(".youtube.com");
    const appliesToMusic = cookieDomain === YOUTUBE_MUSIC_COOKIE_HOST
      || (includeSubdomains === "TRUE" && YOUTUBE_MUSIC_COOKIE_HOST.endsWith(`.${cookieDomain}`));
    if (!youtubeOwnedDomain || !appliesToMusic) continue;

    rows.push(line);
    pairs.push(`${name}=${value}`);
  }
  if (pairs.length === 0) {
    throw new Error("YouTube Music cookies.txt does not contain any cookies for music.youtube.com.");
  }
  return {
    netscape: `# Netscape HTTP Cookie File\n# Managed by Discogenius. Manual edits may be overwritten.\n${rows.join("\n")}\n`,
    cookieHeader: pairs.join("; "),
  };
}

function normalizeRawCookieHeader(content: string): { netscape: string; cookieHeader: string } {
  const raw = content.replace(/^cookie\s*:\s*/iu, "").trim();
  if (/\r|\n|\t|\0/u.test(raw)) {
    throw new Error("A raw YouTube Music Cookie header must be on one line.");
  }
  const rows: string[] = [];
  const pairs: string[] = [];
  for (const part of raw.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!COOKIE_NAME.test(name)) {
      throw new Error(`YouTube Music cookie name is invalid: ${name}`);
    }
    pairs.push(`${name}=${value}`);
    rows.push([".youtube.com", "TRUE", "/", "TRUE", COOKIE_EXPIRY, name, value].join("\t"));
  }
  if (rows.length === 0) {
    throw new Error("YouTube Music cookies must contain at least one name=value pair.");
  }
  return {
    netscape: `# Netscape HTTP Cookie File\n# Managed by Discogenius. Manual edits may be overwritten.\n${rows.join("\n")}\n`,
    cookieHeader: pairs.join("; "),
  };
}

export function normalizeYouTubeMusicCookies(input: unknown): { netscape: string; cookieHeader: string } | null {
  const content = String(input ?? "").trim();
  if (!content) return null;
  if (content.length > 2_000_000 || content.includes("\0")) {
    throw new Error("YouTube Music cookies are invalid or unexpectedly large.");
  }
  if (/^#(?:\s*)Netscape HTTP Cookie File/iu.test(content)) {
    return normalizeNetscapeCookies(content);
  }
  return normalizeRawCookieHeader(content);
}

function findHeader(headers: Record<string, string>, name: string): string | undefined {
  const match = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return match ? headers[match] : undefined;
}

function setHeader(headers: Record<string, string>, name: string, value: string): void {
  const existing = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  headers[existing || name] = value;
}

function atomicWrite(target: string, content: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, target);
  try {
    fs.chmodSync(target, 0o600);
  } catch {
    // Windows does not implement POSIX ownership bits. The provider-owned
    // config directory still keeps these credentials out of application TOML.
  }
}

export function saveYouTubeMusicCredentials(input: YouTubeMusicCredentialsInput): void {
  const headers = parseHeaders(input.headers);
  const normalizedCookies = normalizeYouTubeMusicCookies(input.cookies);
  const headerCookie = findHeader(headers, "cookie");
  const cookies = normalizedCookies || (headerCookie ? normalizeRawCookieHeader(headerCookie) : null);

  if (Object.keys(headers).length === 0 && !cookies) {
    throw new Error("Provide YouTube Music browser headers, cookies, or both.");
  }

  if (cookies && (normalizedCookies || !headerCookie)) {
    setHeader(headers, "Cookie", cookies.cookieHeader);
  }
  if (!findHeader(headers, "User-Agent")) {
    setHeader(headers, "User-Agent", "Mozilla/5.0");
  }
  if (!findHeader(headers, "Origin")) {
    setHeader(headers, "Origin", "https://music.youtube.com");
  }
  if (!findHeader(headers, "Content-Type")) {
    setHeader(headers, "Content-Type", "application/json");
  }

  atomicWrite(YOUTUBE_MUSIC_HEADERS_FILE, `${JSON.stringify(headers, null, 2)}\n`);
  if (cookies) {
    atomicWrite(YOUTUBE_MUSIC_COOKIES_FILE, cookies.netscape);
  } else {
    fs.rmSync(YOUTUBE_MUSIC_COOKIES_FILE, { force: true });
  }
}

export function loadYouTubeMusicHeaders(): Record<string, string> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(YOUTUBE_MUSIC_HEADERS_FILE, "utf8")) as unknown;
    const headers = parseHeaders(parsed);
    return Object.keys(headers).length > 0 ? headers : null;
  } catch {
    return null;
  }
}

export function getYouTubeMusicCredentialState(): YouTubeMusicCredentialState {
  return {
    browserHeadersConfigured: Boolean(loadYouTubeMusicHeaders()),
    cookiesConfigured: fs.existsSync(YOUTUBE_MUSIC_COOKIES_FILE),
  };
}

export function clearYouTubeMusicCredentials(): void {
  fs.rmSync(YOUTUBE_MUSIC_HEADERS_FILE, { force: true });
  fs.rmSync(YOUTUBE_MUSIC_COOKIES_FILE, { force: true });
}
