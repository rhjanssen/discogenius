import fs from "node:fs";
import path from "node:path";

import { CONFIG_DIR } from "../../config/config.js";

export interface YouTubeMusicCredentialsInput {
  /** ytmusicapi browser headers: flat JSON, headers object, or a Copy as fetch / Copy as Node.js fetch paste. */
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
/** Prefer a full browser UA — a bare "Mozilla/5.0" stub is rejected by some YTM endpoints. */
const DEFAULT_YOUTUBE_MUSIC_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0";


/** Headers ytmusicapi / Discogenius actually need — everything else from a fetch paste is dropped. */
const STORED_HEADER_CANONICAL: Record<string, string> = {
  accept: "Accept",
  authorization: "Authorization",
  "content-type": "Content-Type",
  cookie: "Cookie",
  "user-agent": "User-Agent",
  "x-goog-authuser": "X-Goog-AuthUser",
  "x-origin": "x-origin",
  origin: "x-origin",
};

const RESPONSE_BODY_KEYS = new Set([
  "responseContext",
  "contents",
  "trackingParams",
  "frameworkUpdates",
  "continuationContents",
]);

export const YOUTUBE_MUSIC_PROVIDER_DIR = path.join(CONFIG_DIR, "providers", "youtube-music");
export const YOUTUBE_MUSIC_HEADERS_FILE = path.join(YOUTUBE_MUSIC_PROVIDER_DIR, "browser.json");
export const YOUTUBE_MUSIC_COOKIES_FILE = path.join(YOUTUBE_MUSIC_PROVIDER_DIR, "cookies.txt");

function looksLikeYouTubeApiResponseBody(value: Record<string, unknown>): boolean {
  return Object.keys(value).some((key) => RESPONSE_BODY_KEYS.has(key));
}

function extractBalancedObject(source: string, openBraceIndex: number): string | null {
  let depth = 0;
  let inString: '"' | "'" | null = null;
  let escaped = false;
  for (let i = openBraceIndex; i < source.length; i++) {
    const ch = source[i]!;
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(openBraceIndex, i + 1);
    }
  }
  return null;
}

function parseJsonObjectLoose(raw: string): Record<string, unknown> | null {
  const cleaned = raw.replace(/,\s*([}\]])/gu, "$1");
  try {
    const parsed = JSON.parse(cleaned) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function extractHeadersRecordFromObject(value: Record<string, unknown>): Record<string, unknown> | null {
  if (looksLikeYouTubeApiResponseBody(value)) {
    throw new Error(
      "That JSON is a YouTube Music API response body, not request headers. "
      + "In DevTools → Network, right-click a music.youtube.com/youtubei request → Copy → Copy as Node.js fetch.",
    );
  }
  const nested = value.headers;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    return nested as Record<string, unknown>;
  }
  return value;
}

function extractHeadersFromFetchPaste(raw: string): Record<string, unknown> | null {
  const match = /["']?headers["']?\s*:\s*\{/iu.exec(raw);
  if (!match || match.index == null) return null;
  const openBrace = match.index + match[0].length - 1;
  const block = extractBalancedObject(raw, openBrace);
  if (!block) return null;
  return parseJsonObjectLoose(block);
}

function parseColonHeaderDump(raw: string): Record<string, unknown> | null {
  const lines = raw.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) return null;
  const result: Record<string, unknown> = {};
  let matched = 0;
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!HEADER_NAME.test(name) || !value) continue;
    result[name] = value;
    matched += 1;
  }
  return matched >= 2 ? result : null;
}

function coerceHeadersRecord(input: unknown): Record<string, unknown> {
  if (input == null || input === "") return {};

  if (typeof input === "object" && !Array.isArray(input)) {
    const extracted = extractHeadersRecordFromObject(input as Record<string, unknown>);
    return extracted || {};
  }

  if (typeof input !== "string") {
    throw new Error("YouTube Music browser headers must be a JSON object or a Copy as fetch paste.");
  }

  const raw = input.trim();
  if (!raw) return {};

  const fromFetch = extractHeadersFromFetchPaste(raw);
  if (fromFetch) return fromFetch;

  if (raw.startsWith("{")) {
    const parsed = parseJsonObjectLoose(raw);
    if (!parsed) {
      throw new Error("YouTube Music browser headers must be valid JSON or a Copy as Node.js fetch paste.");
    }
    return extractHeadersRecordFromObject(parsed) || {};
  }

  const fromDump = parseColonHeaderDump(raw);
  if (fromDump) return fromDump;

  throw new Error(
    "Could not parse YouTube Music headers. Paste Chrome's \"Copy as Node.js fetch\" for a music.youtube.com/youtubei request, "
    + "or a flat JSON headers object.",
  );
}

function parseHeaders(input: unknown): Record<string, string> {
  const record = coerceHeadersRecord(input);
  const result: Record<string, string> = {};

  for (const [rawName, rawValue] of Object.entries(record)) {
    const name = rawName.trim();
    const canonical = STORED_HEADER_CANONICAL[name.toLowerCase()];
    if (!canonical) continue;
    if (typeof rawValue !== "string" && typeof rawValue !== "number" && typeof rawValue !== "boolean") {
      throw new Error(`YouTube Music browser header ${name} must have a scalar value.`);
    }
    const headerValue = String(rawValue).trim();
    if (/\r|\n|\0/u.test(headerValue)) {
      throw new Error(`YouTube Music browser header ${name} contains an invalid control character.`);
    }
    if (!headerValue) continue;
    // Prefer an explicit x-origin over Origin when both appear in a fetch paste.
    if (canonical === "x-origin" && result["x-origin"] && name.toLowerCase() === "origin") continue;
    result[canonical] = headerValue;
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
  const headerInputProvided = input.headers != null && String(input.headers).trim() !== "";
  const headers = parseHeaders(input.headers);
  const normalizedCookies = normalizeYouTubeMusicCookies(input.cookies);
  const headerCookie = findHeader(headers, "cookie");
  const cookies = normalizedCookies || (headerCookie ? normalizeRawCookieHeader(headerCookie) : null);

  if (Object.keys(headers).length === 0 && !cookies) {
    throw new Error("Provide YouTube Music browser headers, cookies, or both.");
  }

  if (headerInputProvided && Object.keys(headers).length === 0) {
    throw new Error(
      "Could not find usable auth headers in that paste. Use Copy as Node.js fetch on a youtubei request, not the Response body.",
    );
  }

  if (headerInputProvided && !headerCookie && !normalizedCookies) {
    throw new Error(
      "The pasted headers are missing Cookie. Use Chrome's \"Copy as Node.js fetch\" "
      + "(plain \"Copy as fetch\" often omits it), or paste a cookies.txt export in the cookies field.",
    );
  }

  if (headerInputProvided && !findHeader(headers, "authorization")) {
    throw new Error(
      "The pasted headers are missing Authorization (SAPISIDHASH). "
      + "Copy a logged-in music.youtube.com/youtubei request via Copy as Node.js fetch.",
    );
  }

  if (cookies && (normalizedCookies || !headerCookie)) {
    setHeader(headers, "Cookie", cookies.cookieHeader);
  }
  if (!findHeader(headers, "Accept")) {
    setHeader(headers, "Accept", "*/*");
  }
  const existingUserAgent = findHeader(headers, "User-Agent")?.trim();
  if (!existingUserAgent || existingUserAgent === "Mozilla/5.0") {
    setHeader(headers, "User-Agent", DEFAULT_YOUTUBE_MUSIC_USER_AGENT);
  }
  if (!findHeader(headers, "x-origin") && !findHeader(headers, "Origin")) {
    setHeader(headers, "x-origin", "https://music.youtube.com");
  }
  if (!findHeader(headers, "Content-Type")) {
    setHeader(headers, "Content-Type", "application/json");
  }
  if (!findHeader(headers, "X-Goog-AuthUser")) {
    setHeader(headers, "X-Goog-AuthUser", "0");
  }

  // Persist only the allowlisted auth headers, in ytmusicapi's expected shape.
  const stored: Record<string, string> = {};
  for (const canonical of [...new Set(Object.values(STORED_HEADER_CANONICAL))]) {
    const value = findHeader(headers, canonical);
    if (value) stored[canonical] = value;
  }

  atomicWrite(YOUTUBE_MUSIC_HEADERS_FILE, `${JSON.stringify(stored, null, 2)}\n`);
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
