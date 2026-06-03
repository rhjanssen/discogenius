import fs from "fs";
import path from "path";
import { REPO_ROOT } from "./config.js";

const DEFAULT_CONTACT_URL = "https://github.com/rhjanssen/discogenius";

let cachedVersion: string | null = null;

function readPackageVersion(packageJsonPath: string, fallback = "0.0.0"): string {
  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as { version?: string };
    return packageJson.version || fallback;
  } catch {
    return fallback;
  }
}

export function getDiscogeniusVersion(): string {
  if (cachedVersion) {
    return cachedVersion;
  }

  const appVersion = readPackageVersion(path.join(REPO_ROOT, "app", "package.json"));
  const apiVersion = readPackageVersion(path.join(REPO_ROOT, "api", "package.json"), appVersion);
  cachedVersion = appVersion !== "0.0.0" ? appVersion : apiVersion;
  return cachedVersion;
}

export function getDiscogeniusUserAgent(purpose?: string | null): string {
  const trimmedPurpose = String(purpose || "").trim();
  const detail = trimmedPurpose
    ? `${trimmedPurpose}; ${DEFAULT_CONTACT_URL}`
    : DEFAULT_CONTACT_URL;
  return `Discogenius/${getDiscogeniusVersion()} (${detail})`;
}
