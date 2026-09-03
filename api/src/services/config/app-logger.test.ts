import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  closeAppLogging,
  getAppLogFilePathForTests,
  getLogs,
  initAppLogging,
  resetAppLoggingForTests,
} from "./app-logger.js";

const previousLogDir = process.env.DISCOGENIUS_LOG_DIR;
const previousArchiveBytes = process.env.DISCOGENIUS_LOG_ARCHIVE_ABOVE_BYTES;
const previousRotate = process.env.DISCOGENIUS_LOG_ROTATE;

function listLogNames(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.startsWith("discogenius") && name.endsWith(".jsonl")).sort();
}

test.after(() => {
  resetAppLoggingForTests();
  closeAppLogging();
  if (previousLogDir === undefined) {
    delete process.env.DISCOGENIUS_LOG_DIR;
  } else {
    process.env.DISCOGENIUS_LOG_DIR = previousLogDir;
  }
  if (previousArchiveBytes === undefined) {
    delete process.env.DISCOGENIUS_LOG_ARCHIVE_ABOVE_BYTES;
  } else {
    process.env.DISCOGENIUS_LOG_ARCHIVE_ABOVE_BYTES = previousArchiveBytes;
  }
  if (previousRotate === undefined) {
    delete process.env.DISCOGENIUS_LOG_ROTATE;
  } else {
    process.env.DISCOGENIUS_LOG_ROTATE = previousRotate;
  }
});

test("UI logs start at this process and ignore leftover jsonl from older runs", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "discogenius-logs-"));
  process.env.DISCOGENIUS_LOG_DIR = dir;
  writeFileSync(
    path.join(dir, "discogenius.jsonl"),
    `${JSON.stringify({
      id: 1,
      level: "info",
      message: "first boot of an older version",
      time: "2024-01-01T00:00:00.000Z",
    })}\n`,
    "utf8",
  );

  resetAppLoggingForTests();
  initAppLogging();
  console.info("current session work");

  const logs = getLogs({ limit: 50 });
  assert.equal(
    logs.records.some((record) => record.message.includes("first boot of an older version")),
    false,
  );
  assert.equal(logs.records.some((record) => record.message.includes("current session work")), true);
  assert.equal(logs.records.some((record) => record.message.startsWith("[Discogenius] ") && record.message.endsWith(" starting")), true);
  assert.equal(logs.records.every((record) => record.id >= 1), true);

  resetAppLoggingForTests();
  rmSync(dir, { recursive: true, force: true });
});

test("jsonl rotates by size and drops archives past the Lidarr-style cap", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "discogenius-logs-rotate-"));
  process.env.DISCOGENIUS_LOG_DIR = dir;
  process.env.DISCOGENIUS_LOG_ARCHIVE_ABOVE_BYTES = "180";
  process.env.DISCOGENIUS_LOG_ROTATE = "2";

  resetAppLoggingForTests();
  initAppLogging();
  for (let index = 0; index < 12; index += 1) {
    console.info(`rotation payload ${index} ${"x".repeat(40)}`);
  }

  const names = listLogNames(dir);
  assert.equal(names.includes("discogenius.jsonl"), true);
  assert.equal(names.includes("discogenius.1.jsonl"), true);
  assert.equal(names.includes("discogenius.3.jsonl"), false);

  const current = readFileSync(getAppLogFilePathForTests(), "utf8");
  assert.equal(current.includes("rotation payload"), true);

  resetAppLoggingForTests();
  rmSync(dir, { recursive: true, force: true });
});
