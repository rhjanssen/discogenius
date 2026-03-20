import fs from "fs";
import path from "path";
import { REPO_ROOT } from "./config.js";

export type CurrentAppReleaseInfo = {
  version: string;
  appVersion: string;
  apiVersion: string;
};

export type LatestReleaseLookup = {
  version?: string;
  name?: string;
  url?: string;
  publishedAt?: string;
  checkedAt: string;
  error?: string;
};

export type AppReleaseInfo = CurrentAppReleaseInfo & {
  latestVersion?: string;
  latestReleaseName?: string;
  latestReleaseUrl?: string;
  latestReleasePublishedAt?: string;
  updateAvailable: boolean;
  updateStatus: "current" | "update-available" | "unknown";
  checkedAt?: string;
  checkError?: string;
};

const DEFAULT_RELEASE_REPO = process.env.DISCOGENIUS_RELEASE_REPO || "rhjanssen/discogenius";
const DISABLE_UPDATE_CHECK = process.env.DISCOGENIUS_DISABLE_UPDATE_CHECK === "1";
const RELEASE_CHECK_TTL_MS = 30 * 60 * 1000;

let cachedLatestReleaseLookup:
  | {
      expiresAt: number;
      value: LatestReleaseLookup;
    }
  | null = null;
let latestReleaseLookupPromise: Promise<LatestReleaseLookup> | null = null;

function readPackageVersion(packageJsonPath: string, fallback = "0.0.0"): string {
  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as { version?: string };
    return packageJson.version || fallback;
  } catch {
    return fallback;
  }
}

function normalizeVersionTag(version: string): string {
  return version.trim().replace(/^v/i, "").split("-")[0];
}

export function compareReleaseVersions(left: string, right: string): number {
  const leftParts = normalizeVersionTag(left)
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = normalizeVersionTag(right)
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  const maxLength = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < maxLength; index += 1) {
    const leftValue = leftParts[index] || 0;
    const rightValue = rightParts[index] || 0;

    if (leftValue !== rightValue) {
      return leftValue > rightValue ? 1 : -1;
    }
  }

  return 0;
}

export function getCurrentAppReleaseInfo(): CurrentAppReleaseInfo {
  const appVersion = readPackageVersion(path.join(REPO_ROOT, "app", "package.json"));
  const apiVersion = readPackageVersion(path.join(REPO_ROOT, "api", "package.json"), appVersion);

  return {
    version: appVersion !== "0.0.0" ? appVersion : apiVersion,
    appVersion,
    apiVersion,
  };
}

export function buildAppReleaseInfo(
  current: CurrentAppReleaseInfo,
  latest: LatestReleaseLookup,
): AppReleaseInfo {
  const latestVersion = latest.version ? normalizeVersionTag(latest.version) : undefined;
  const currentVersion = normalizeVersionTag(current.version);
  const updateAvailable = latestVersion
    ? compareReleaseVersions(latestVersion, currentVersion) > 0
    : false;
  const updateStatus = latestVersion
    ? (updateAvailable ? "update-available" : "current")
    : "unknown";

  return {
    ...current,
    latestVersion,
    latestReleaseName: latest.name,
    latestReleaseUrl: latest.url,
    latestReleasePublishedAt: latest.publishedAt,
    updateAvailable,
    updateStatus,
    checkedAt: latest.checkedAt,
    checkError: latest.error,
  };
}

async function fetchLatestReleaseLookup(): Promise<LatestReleaseLookup> {
  const checkedAt = new Date().toISOString();

  if (DISABLE_UPDATE_CHECK) {
    return {
      checkedAt,
      error: "update checks are disabled",
    };
  }

  const response = await fetch(`https://api.github.com/repos/${DEFAULT_RELEASE_REPO}/releases/latest`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "Discogenius/1.0",
    },
    signal: AbortSignal.timeout(5000),
  });

  if (!response.ok) {
    throw new Error(`GitHub release lookup failed with status ${response.status}`);
  }

  const payload = await response.json() as {
    tag_name?: string;
    name?: string;
    html_url?: string;
    published_at?: string;
  };

  return {
    version: payload.tag_name ? normalizeVersionTag(payload.tag_name) : undefined,
    name: payload.name || payload.tag_name,
    url: payload.html_url,
    publishedAt: payload.published_at,
    checkedAt,
  };
}

async function getLatestReleaseLookupCached(): Promise<LatestReleaseLookup> {
  const now = Date.now();

  if (cachedLatestReleaseLookup && cachedLatestReleaseLookup.expiresAt > now) {
    return cachedLatestReleaseLookup.value;
  }

  if (!latestReleaseLookupPromise) {
    latestReleaseLookupPromise = fetchLatestReleaseLookup()
      .catch((error) => ({
        checkedAt: new Date().toISOString(),
        error: (error as Error).message,
      }))
      .then((value) => {
        cachedLatestReleaseLookup = {
          value,
          expiresAt: Date.now() + RELEASE_CHECK_TTL_MS,
        };
        latestReleaseLookupPromise = null;
        return value;
      });
  }

  return latestReleaseLookupPromise;
}

export async function getAppReleaseInfo(): Promise<AppReleaseInfo> {
  const current = getCurrentAppReleaseInfo();
  const latest = await getLatestReleaseLookupCached();
  return buildAppReleaseInfo(current, latest);
}
