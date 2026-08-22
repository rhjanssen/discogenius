import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { BASE_SCHEMA_VERSION } from "../../database/schema/version.js";
import {
  assertSafeOutputRoot,
  readJson,
  type SyntheticRunManifest,
} from "../../../scripts/release-hardening/synthetic-load-common.js";

const apiRoot = path.resolve(process.cwd());
const repoRoot = path.resolve(apiRoot, "..");

function runTsx(script: string, args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", script, ...args],
    {
      cwd: apiRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
      timeout: 45_000,
    },
  );
}

test("synthetic release-hardening harness generates and drains an isolated deterministic fixture", () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-release-hardening-smoke-"));
  const runId = "node-test-seed-2028";
  const runRoot = path.join(outputRoot, runId);
  try {
    const generated = runTsx(
      "scripts/release-hardening/generate-synthetic-load.ts",
      [
        "--seed", "2028",
        "--primary-artists", "8",
        "--credited-artists", "16",
        "--history-rows", "50",
        "--concurrency", "2",
        "--output-root", outputRoot,
        "--run-id", runId,
      ],
    );
    assert.equal(
      generated.status,
      0,
      `generator failed\nstdout:\n${generated.stdout}\nstderr:\n${generated.stderr}`,
    );

    const manifestPath = path.join(runRoot, "manifest.json");
    const expectedPath = path.join(runRoot, "expected.json");
    const markerPath = path.join(runRoot, ".discogenius-release-hardening-run.json");
    assert.equal(fs.existsSync(markerPath), true);
    assert.equal(fs.existsSync(manifestPath), true);
    assert.equal(fs.existsSync(expectedPath), true);
    const manifest = readJson<SyntheticRunManifest>(manifestPath);
    assert.equal(manifest.schemaVersion, BASE_SCHEMA_VERSION);
    assert.equal(manifest.configuration.primaryArtists, 8);
    assert.equal(manifest.configuration.creditedArtists, 16);
    assert.equal(manifest.configuration.historyRows, 50);
    for (const root of [
      manifest.paths.stereoRoot,
      manifest.paths.spatialRoot,
      manifest.paths.videoRoot,
      manifest.paths.downloadRoot,
      manifest.paths.unmappedRoot,
    ]) {
      assert.equal(path.relative(runRoot, root).startsWith(".."), false);
    }

    const fixtureDb = new Database(manifest.paths.databasePath, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      assert.equal(fixtureDb.pragma("user_version", { simple: true }), BASE_SCHEMA_VERSION);
      assert.equal(fixtureDb.pragma("quick_check", { simple: true }), "ok");
      assert.deepEqual(fixtureDb.pragma("foreign_key_check"), []);
      const commandCount = fixtureDb.prepare("SELECT COUNT(*) AS count FROM commands").get() as {
        count: number;
      };
      assert.equal(commandCount.count, 59);
    } finally {
      fixtureDb.close();
    }

    const runResult = runTsx(
      "scripts/release-hardening/run-synthetic-load.ts",
      [
        "--run-root", runRoot,
        "--concurrency", "2",
        "--lease-ms", "750",
        "--heartbeat-ms", "50",
        "--metrics-ms", "100",
        "--timeout-ms", "30000",
      ],
    );
    assert.equal(
      runResult.status,
      0,
      `runner failed\nstdout:\n${runResult.stdout}\nstderr:\n${runResult.stderr}`,
    );
    const final = readJson<{
      status: string;
      progress: {
        completedArtists: number;
        failedArtists: number;
        completedCreditedArtists: number;
        firstPrimaryDownloadReadyTerminalCount: number | null;
      };
      recovery: { retryRecovered: number };
      assertions: Array<{ pass: boolean; name: string }>;
      limitations: string[];
    }>(path.join(runRoot, "final.json"));
    assert.equal(final.status, "passed");
    assert.equal(final.progress.completedArtists, 7);
    assert.equal(final.progress.failedArtists, 1);
    assert.equal(final.progress.completedCreditedArtists, 16);
    assert.ok((final.progress.firstPrimaryDownloadReadyTerminalCount ?? 8) < 8);
    assert.ok(final.recovery.retryRecovered > 0);
    assert.equal(final.assertions.every((entry) => entry.pass), true);
    assert.ok(final.limitations.some((value) => value.includes("HTTP API latency")));

    const heartbeat = readJson<{
      status: string;
      activeCommands: number;
      queueDepth: number;
      finalResult: string;
    }>(path.join(runRoot, "heartbeat.json"));
    assert.equal(heartbeat.status, "passed");
    assert.equal(heartbeat.activeCommands, 0);
    assert.equal(heartbeat.queueDepth, 0);
    assert.equal(path.resolve(heartbeat.finalResult), path.join(runRoot, "final.json"));

    const metricsLines = fs.readFileSync(path.join(runRoot, "metrics.ndjson"), "utf8")
      .trim()
      .split(/\r?\n/);
    assert.ok(metricsLines.length > 0);
    const metric = JSON.parse(metricsLines[metricsLines.length - 1]) as {
      database?: { walBytes?: number };
      workers?: { configured?: number };
      apiLatency?: unknown;
      apiLatencyReason?: string;
    };
    assert.equal(metric.workers?.configured, 2);
    assert.equal(typeof metric.database?.walBytes, "number");
    assert.equal(metric.apiLatency, null);
    assert.match(metric.apiLatencyReason ?? "", /does not launch the HTTP API/);
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});

test("synthetic harness refuses broad or real runtime output roots", () => {
  assert.throws(
    () => assertSafeOutputRoot(repoRoot, repoRoot),
    /Refusing unsafe release-hardening output root/,
  );
  assert.throws(
    () => assertSafeOutputRoot(path.join(repoRoot, "config"), repoRoot),
    /Refusing unsafe release-hardening output root/,
  );
  assert.throws(
    () => assertSafeOutputRoot(os.homedir(), repoRoot),
    /Refusing unsafe release-hardening output root/,
  );
});

