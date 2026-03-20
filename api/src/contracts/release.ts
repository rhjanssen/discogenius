import {
  expectBoolean,
  expectOneOf,
  expectOptionalString,
  expectRecord,
  expectString,
} from "./runtime.js";

export const APP_UPDATE_STATUS_VALUES = ["current", "update-available", "unknown"] as const;
export type AppUpdateStatusValue = (typeof APP_UPDATE_STATUS_VALUES)[number];

export interface AppReleaseInfoContract {
  version: string;
  appVersion: string;
  apiVersion: string;
  latestVersion?: string;
  latestReleaseName?: string;
  latestReleaseUrl?: string;
  latestReleasePublishedAt?: string;
  updateAvailable: boolean;
  updateStatus: AppUpdateStatusValue;
  checkedAt?: string;
  checkError?: string;
}

export function parseAppReleaseInfoContract(value: unknown): AppReleaseInfoContract {
  const record = expectRecord(value, "App release info");

  return {
    version: expectString(record.version, "release.version"),
    appVersion: expectString(record.appVersion, "release.appVersion"),
    apiVersion: expectString(record.apiVersion, "release.apiVersion"),
    latestVersion: expectOptionalString(record.latestVersion, "release.latestVersion"),
    latestReleaseName: expectOptionalString(record.latestReleaseName, "release.latestReleaseName"),
    latestReleaseUrl: expectOptionalString(record.latestReleaseUrl, "release.latestReleaseUrl"),
    latestReleasePublishedAt: expectOptionalString(record.latestReleasePublishedAt, "release.latestReleasePublishedAt"),
    updateAvailable: expectBoolean(record.updateAvailable, "release.updateAvailable"),
    updateStatus: expectOneOf(record.updateStatus, APP_UPDATE_STATUS_VALUES, "release.updateStatus"),
    checkedAt: expectOptionalString(record.checkedAt, "release.checkedAt"),
    checkError: expectOptionalString(record.checkError, "release.checkError"),
  };
}
