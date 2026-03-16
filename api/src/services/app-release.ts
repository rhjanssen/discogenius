import fs from "fs";
import path from "path";
import { REPO_ROOT } from "./config.js";

export type AppReleaseInfo = {
  version: string;
  appVersion: string;
  apiVersion: string;
};

function readPackageVersion(packageJsonPath: string, fallback = "0.0.0"): string {
  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as { version?: string };
    return packageJson.version || fallback;
  } catch {
    return fallback;
  }
}

export function getAppReleaseInfo(): AppReleaseInfo {
  const appVersion = readPackageVersion(path.join(REPO_ROOT, "app", "package.json"));
  const apiVersion = readPackageVersion(path.join(REPO_ROOT, "api", "package.json"), appVersion);

  return {
    version: appVersion !== "0.0.0" ? appVersion : apiVersion,
    appVersion,
    apiVersion,
  };
}
