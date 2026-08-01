import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SYNTHETIC_RUN_FORMAT = "discogenius-release-hardening/v1";

export interface ParsedCli {
  [key: string]: string | boolean;
}

export interface SyntheticRunPaths {
  runRoot: string;
  configRoot: string;
  databasePath: string;
  mediaRoot: string;
  stereoRoot: string;
  spatialRoot: string;
  videoRoot: string;
  downloadRoot: string;
  unmappedRoot: string;
  markerPath: string;
  manifestPath: string;
  expectedPath: string;
  creditedEdgesPath: string;
  eventsPath: string;
  metricsPath: string;
  heartbeatPath: string;
  finalPath: string;
}

export interface SyntheticBehavior {
  kind: "normal" | "slow" | "transient_failure" | "poison" | "worker_crash" | "worker_hang";
  stage?: string;
}

export interface SyntheticGenerationOptions {
  seed: number;
  primaryArtists: number;
  creditedArtists: number;
  historyRows: number;
  concurrency: number;
  outputRoot: string;
  runId: string;
}

export interface SyntheticExpectedState {
  artists: {
    primary: number;
    credited: number;
    canonical: number;
    legacy: number;
    managed: number;
  };
  catalogue: {
    albums: number;
    editions: number;
    recordings: number;
    audioRecordings: number;
    videoRecordings: number;
    tracks: number;
    directVideoTracks: number;
  };
  provider: {
    items: number;
    artistMatches: number;
    editionMatches: number;
    trackMatches: number;
    videoMatches: number;
    audioVariants: number;
  };
  curation: {
    libraryArtists: number;
    libraryAlbums: number;
    libraryEditions: number;
    libraryVideos: number;
    inlineVideos: number;
    plans: number;
    planSources: number;
    planTracks: number;
  };
  files: {
    trackFiles: number;
    unmappedFiles: number;
    totalBytes: number;
  };
  commands: {
    history: number;
    initialPrimary: number;
    initialDownloads: number;
  };
  behavior: Record<SyntheticBehavior["kind"], number>;
}

export interface SyntheticRunManifest {
  format: typeof SYNTHETIC_RUN_FORMAT;
  runId: string;
  gitSha: string;
  dockerImageId: string | null;
  schemaVersion: number;
  seed: number;
  generatedAt: string;
  generatorDurationMs: number;
  configuration: {
    primaryArtists: number;
    creditedArtists: number;
    historyRows: number;
    requestedConcurrency: number;
  };
  paths: {
    runRoot: string;
    databasePath: string;
    stereoRoot: string;
    spatialRoot: string;
    videoRoot: string;
    downloadRoot: string;
    unmappedRoot: string;
  };
  warnings: string[];
}

export function parseCli(argv: readonly string[]): ParsedCli {
  const parsed: ParsedCli = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${token}`);
    }
    const equals = token.indexOf("=");
    if (equals > 2) {
      parsed[token.slice(2, equals)] = token.slice(equals + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next != null && !next.startsWith("--")) {
      parsed[key] = next;
      index += 1;
    } else {
      parsed[key] = true;
    }
  }
  return parsed;
}

export function readIntegerOption(
  cli: ParsedCli,
  key: string,
  fallback: number,
  bounds: { min: number; max: number },
): number {
  const raw = cli[key];
  if (raw == null) return fallback;
  if (raw === true || !/^-?\d+$/.test(String(raw))) {
    throw new Error(`--${key} must be an integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < bounds.min || value > bounds.max) {
    throw new Error(`--${key} must be between ${bounds.min} and ${bounds.max}`);
  }
  return value;
}

export function readStringOption(cli: ParsedCli, key: string, fallback?: string): string {
  const raw = cli[key];
  if (raw == null) {
    if (fallback == null) throw new Error(`--${key} is required`);
    return fallback;
  }
  if (raw === true || !String(raw).trim()) {
    throw new Error(`--${key} requires a non-empty value`);
  }
  return String(raw).trim();
}

export function repoRootFrom(importMetaUrl: string): string {
  let current = path.dirname(fileURLToPath(importMetaUrl));
  while (true) {
    if (
      fs.existsSync(path.join(current, "package.json"))
      && fs.existsSync(path.join(current, "api", "package.json"))
      && fs.existsSync(path.join(current, "app", "package.json"))
    ) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error("Unable to locate the Discogenius repository root");
    }
    current = parent;
  }
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left).toLocaleLowerCase() === path.resolve(right).toLocaleLowerCase();
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * The harness never removes an output root. It creates a new run directory
 * beneath it. This guard prevents even that creation under a broad or valuable
 * location unless the path is the repository's ignored test-results tree or is
 * explicitly named for this disposable harness.
 */
export function assertSafeOutputRoot(outputRoot: string, repoRoot: string): string {
  const resolved = path.resolve(outputRoot);
  const filesystemRoot = path.parse(resolved).root;
  const home = path.resolve(os.homedir());
  const allowedRepoRoot = path.join(repoRoot, "test-results", "release-hardening");
  const hasDisposableSegment = resolved
    .split(path.sep)
    .some((segment) => segment.toLocaleLowerCase().includes("discogenius-release-hardening"));
  const underIgnoredResults = samePath(resolved, allowedRepoRoot) || isWithin(allowedRepoRoot, resolved);

  if (
    samePath(resolved, filesystemRoot)
    || samePath(resolved, home)
    || samePath(resolved, repoRoot)
    || samePath(resolved, path.join(repoRoot, "config"))
    || samePath(resolved, path.join(repoRoot, "library"))
    || samePath(resolved, path.join(repoRoot, "downloads"))
  ) {
    throw new Error(`Refusing unsafe release-hardening output root: ${resolved}`);
  }
  if (!underIgnoredResults && !hasDisposableSegment) {
    throw new Error(
      `Release-hardening output root must be under ${allowedRepoRoot} `
      + `or contain a "discogenius-release-hardening" path segment: ${resolved}`,
    );
  }
  if (fs.existsSync(resolved) && !fs.statSync(resolved).isDirectory()) {
    throw new Error(`Output root is not a directory: ${resolved}`);
  }
  return resolved;
}

export function validateRunId(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(value)) {
    throw new Error("Run id must be 1-80 characters using letters, digits, dot, underscore, or dash");
  }
  return value;
}

export function defaultRunId(seed: number): string {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-seed-${seed}`;
}

export function createRunPaths(outputRoot: string, runId: string): SyntheticRunPaths {
  const runRoot = path.join(outputRoot, runId);
  const mediaRoot = path.join(runRoot, "media");
  return {
    runRoot,
    configRoot: path.join(runRoot, "config"),
    databasePath: path.join(runRoot, "config", "discogenius.db"),
    mediaRoot,
    stereoRoot: path.join(mediaRoot, "stereo"),
    spatialRoot: path.join(mediaRoot, "spatial"),
    videoRoot: path.join(mediaRoot, "video"),
    downloadRoot: path.join(mediaRoot, "downloads"),
    unmappedRoot: path.join(mediaRoot, "unmapped"),
    markerPath: path.join(runRoot, ".discogenius-release-hardening-run.json"),
    manifestPath: path.join(runRoot, "manifest.json"),
    expectedPath: path.join(runRoot, "expected.json"),
    creditedEdgesPath: path.join(runRoot, "credited-edges.ndjson"),
    eventsPath: path.join(runRoot, "events.ndjson"),
    metricsPath: path.join(runRoot, "metrics.ndjson"),
    heartbeatPath: path.join(runRoot, "heartbeat.json"),
    finalPath: path.join(runRoot, "final.json"),
  };
}

export function ensureFreshRunDirectory(paths: SyntheticRunPaths): void {
  if (fs.existsSync(paths.runRoot)) {
    throw new Error(`Run directory already exists; choose a new --run-id: ${paths.runRoot}`);
  }
  for (const directory of [
    paths.configRoot,
    paths.stereoRoot,
    paths.spatialRoot,
    paths.videoRoot,
    paths.downloadRoot,
    paths.unmappedRoot,
  ]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  writeJson(paths.markerPath, {
    format: SYNTHETIC_RUN_FORMAT,
    runRoot: paths.runRoot,
    createdAt: new Date().toISOString(),
    disposable: true,
  });
}

export function requireRunMarker(runRoot: string): SyntheticRunPaths {
  const resolved = path.resolve(runRoot);
  const paths = createRunPaths(path.dirname(resolved), path.basename(resolved));
  if (!fs.existsSync(paths.markerPath)) {
    throw new Error(`Missing release-hardening run marker: ${paths.markerPath}`);
  }
  const marker = readJson<{ format?: string; runRoot?: string }>(paths.markerPath);
  if (marker.format !== SYNTHETIC_RUN_FORMAT || !marker.runRoot || !samePath(marker.runRoot, resolved)) {
    throw new Error(`Invalid or mismatched release-hardening run marker: ${paths.markerPath}`);
  }
  return paths;
}

export function writeJson(filePath: string, value: unknown): void {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    try {
      fs.rmSync(filePath, { force: true });
      fs.renameSync(temporaryPath, filePath);
    } catch {
      fs.rmSync(temporaryPath, { force: true });
      throw error;
    }
  }
}

export function appendNdjson(filePath: string, value: unknown): void {
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

export function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

export function readNdjson<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

export function seededUuid(seed: number, namespace: string, index: number, subIndex = 0): string {
  const hex = createHash("sha256")
    .update(`${seed}:${namespace}:${index}:${subIndex}`)
    .digest("hex")
    .slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function seededNumber(seed: number, namespace: string, index: number, modulo: number): number {
  if (modulo <= 0) return 0;
  const buffer = createHash("sha256")
    .update(`${seed}:${namespace}:${index}`)
    .digest();
  return buffer.readUInt32LE(0) % modulo;
}

export function classifyBehavior(index: number): SyntheticBehavior {
  if (index % 397 === 13) return { kind: "worker_hang", stage: "RescanFolders" };
  if (index % 331 === 11) return { kind: "worker_crash", stage: "RefreshArtist" };
  if (index % 251 === 7) return { kind: "poison", stage: "CurateArtist" };
  if (index % 113 === 5) return { kind: "transient_failure", stage: "MatchArtistProviders" };
  if (index % 97 === 3) return { kind: "slow", stage: "MatchArtistProviders" };
  return { kind: "normal" };
}

export function getGitSha(repoRoot: string): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

export function getDockerImageId(): string | null {
  const configured = process.env.DISCOGENIUS_TEST_IMAGE_ID?.trim();
  return configured || null;
}

export function assertPathWithinRoot(candidate: string, root: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Synthetic path escaped its disposable root: ${candidate} (root ${root})`);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

