import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAppReleaseInfo,
  compareReleaseVersions,
  type CurrentAppReleaseInfo,
} from "./app-release.js";

const currentRelease: CurrentAppReleaseInfo = {
  version: "1.0.4",
  appVersion: "1.0.4",
  apiVersion: "1.0.4",
};

test("compareReleaseVersions handles semver-style tags", () => {
  assert.equal(compareReleaseVersions("v1.0.4", "1.0.4"), 0);
  assert.equal(compareReleaseVersions("1.0.5", "1.0.4"), 1);
  assert.equal(compareReleaseVersions("1.0.4", "1.0.5"), -1);
});

test("buildAppReleaseInfo marks releases current when versions match", () => {
  const info = buildAppReleaseInfo(currentRelease, {
    version: "1.0.4",
    name: "v1.0.4",
    url: "https://example.com/v1.0.4",
    publishedAt: "2026-03-20T12:00:00.000Z",
    checkedAt: "2026-03-20T12:05:00.000Z",
  });

  assert.equal(info.updateAvailable, false);
  assert.equal(info.updateStatus, "current");
  assert.equal(info.latestVersion, "1.0.4");
});

test("buildAppReleaseInfo marks update availability when latest release is newer", () => {
  const info = buildAppReleaseInfo(currentRelease, {
    version: "1.0.5",
    name: "v1.0.5",
    url: "https://example.com/v1.0.5",
    publishedAt: "2026-03-20T12:00:00.000Z",
    checkedAt: "2026-03-20T12:05:00.000Z",
  });

  assert.equal(info.updateAvailable, true);
  assert.equal(info.updateStatus, "update-available");
  assert.equal(info.latestVersion, "1.0.5");
});

test("buildAppReleaseInfo falls back cleanly when latest release lookup is unavailable", () => {
  const info = buildAppReleaseInfo(currentRelease, {
    checkedAt: "2026-03-20T12:05:00.000Z",
    error: "network unavailable",
  });

  assert.equal(info.updateAvailable, false);
  assert.equal(info.updateStatus, "unknown");
  assert.equal(info.checkError, "network unavailable");
});
