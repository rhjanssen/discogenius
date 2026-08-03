import { mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();

// Isolate tests from the developer's live runtime config (provider tokens,
// config.toml). Real credentials in ./config must never change test results —
// CI runs with an empty config directory and local runs must match it.
if (!process.env.DISCOGENIUS_CONFIG_DIR?.trim()) {
  process.env.DISCOGENIUS_CONFIG_DIR = mkdtempSync(join(tmpdir(), "discogenius-test-config-"));
}
const srcDir = join(root, "src");

function collectTests(dir) {
  const entries = readdirSync(dir).sort((left, right) => left.localeCompare(right));
  const files = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...collectTests(fullPath));
    } else if (entry.endsWith(".test.ts")) {
      files.push(relative(root, fullPath).replace(/\\/g, "/"));
    }
  }
  return files;
}

const passthroughArgs = process.argv.slice(2);
const explicitTestFiles = passthroughArgs.filter((arg) => arg.endsWith(".test.ts"));
const runnerArgs = passthroughArgs.filter((arg) => !arg.endsWith(".test.ts"));
const testFiles = explicitTestFiles.length > 0
  ? explicitTestFiles.map((file) => file.replace(/\\/g, "/"))
  : collectTests(srcDir);
if (testFiles.length === 0) {
  console.error("No API test files found.");
  process.exit(1);
}

const CLONE_FLAKE_SIGNATURE = "Unable to deserialize cloned data";

// Default process isolation is required for the full suite: many files set
// DB_PATH / import database at module load, so they need a clean process each.
// Clone-flake retries re-run only the flaked file(s) with isolation=none so
// results never cross a structured-clone boundary (the IPC path that flakes).
function runOnce(files, { capture = false, isolation = "process" } = {}) {
  // Node 22 still ships this as --experimental-test-isolation; the non-prefixed
  // alias is not available on all 22.x builds used in CI and locally.
  const isolationArgs = isolation === "none"
    ? ["--experimental-test-isolation=none"]
    : [];
  return spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--test",
      "--test-concurrency=1",
      ...isolationArgs,
      ...runnerArgs,
      ...files,
    ],
    {
      cwd: root,
      stdio: capture ? ["inherit", "pipe", "pipe"] : "inherit",
      shell: false,
      encoding: capture ? "utf8" : undefined,
      maxBuffer: 256 * 1024 * 1024,
    },
  );
}

function writeCaptured(result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

// Parse the top-level TAP results. A whole file that dies reports as
// "not ok 102 - src/…/foo.test.ts"; an individual assertion failure reports as
// "not ok 359 - a shared cover survives …". Only the first kind can be a clone
// flake, and only the second kind proves a genuine defect — so they are counted
// separately. Conflating them is what let a flake anywhere in the suite mask
// every real failure elsewhere.
function parseFailures(stdout) {
  const files = new Set();
  const tests = [];
  for (const rawLine of String(stdout || "").split(/\r?\n/)) {
    const match = /^not ok \d+ - (\S.*)$/.exec(rawLine.trim());
    if (!match) continue;
    // Windows TAP names use backslashes; normalize so retries open the file.
    const name = match[1].trim().replace(/\\/g, "/");
    if (/\.test\.ts$/.test(name)) files.add(name);
    else tests.push(name);
  }
  return { files: [...files], tests };
}

const MAX_CLONE_FLAKE_RETRIES = 5;

function isCloneFlakeOnly(stdout, stderr, status) {
  if ((status ?? 1) === 0) return { flaked: false };
  const combined = `${String(stdout || "")}\n${String(stderr || "")}`;
  if (!combined.includes(CLONE_FLAKE_SIGNATURE)) return { flaked: false };
  const { files: failedFiles, tests: failedTests } = parseFailures(combined);
  return { flaked: true, failedFiles, failedTests, combined };
}

// A single file can safely run in-process and avoids the process-isolation
// clone flake entirely. The full suite still needs process isolation so each
// file gets a clean module graph / DB_PATH.
const initialIsolation = testFiles.length === 1 ? "none" : "process";
let result = runOnce(testFiles, { capture: true, isolation: initialIsolation });
writeCaptured(result);

// Node's test runner intermittently fails a whole file with "Unable to
// deserialize cloned data" — a child-process result-serialization flake, not a
// test assertion. Detect it across both output streams because Node has emitted
// the signature on either one. Real assertion failures do not match and fail
// immediately; retrying those would hide a flaky or genuinely broken test.
// Isolation retries still flake under process isolation on CI, so each flaked
// file is re-run alone with --test-isolation=none (no structured-clone IPC).
const flake = isCloneFlakeOnly(result.stdout, result.stderr, result.status);
if (flake.flaked) {
  if (flake.failedTests.length > 0) {
    console.error(
      `[api tests] Test-runner clone flake detected, but ${flake.failedTests.length} test(s) failed on their own merits; not retrying:\n`
      + flake.failedTests.map((name) => `  - ${name}`).join("\n"),
    );
    process.exit(result.status ?? 1);
  }

  // Prefer the files Node named. If TAP did not name a file, re-run the whole
  // suite under process isolation (cannot safely isolation=none the full set).
  const namedFiles = flake.failedFiles;
  if (namedFiles.length === 0) {
    for (let attempt = 1; attempt <= MAX_CLONE_FLAKE_RETRIES; attempt += 1) {
      console.warn(
        `[api tests] Test-runner clone flake detected without a file name; whole-suite retry ${attempt}/${MAX_CLONE_FLAKE_RETRIES}`,
      );
      result = runOnce(testFiles, { capture: true });
      writeCaptured(result);
      if ((result.status ?? 1) === 0) process.exit(0);
      const again = isCloneFlakeOnly(result.stdout, result.stderr, result.status);
      if (!again.flaked) process.exit(result.status ?? 1);
      if (again.failedTests.length > 0) process.exit(result.status ?? 1);
      if (again.failedFiles.length > 0) {
        // Named files appeared — fall through to per-file isolation=none below.
        namedFiles.push(...again.failedFiles);
        break;
      }
    }
  }

  if (namedFiles.length > 0) {
    for (const file of namedFiles) {
      let passed = false;
      for (let attempt = 1; attempt <= MAX_CLONE_FLAKE_RETRIES; attempt += 1) {
        console.warn(
          `[api tests] Test-runner clone flake detected; isolation=none retry ${attempt}/${MAX_CLONE_FLAKE_RETRIES}: ${file}`,
        );
        result = runOnce([file], { capture: true, isolation: "none" });
        writeCaptured(result);
        if ((result.status ?? 1) === 0) {
          passed = true;
          break;
        }
        const again = isCloneFlakeOnly(result.stdout, result.stderr, result.status);
        if (!again.flaked) {
          console.error(
            `[api tests] Isolation retry for ${file} failed without clone-flake signature; treating as real failure.`,
          );
          process.exit(result.status ?? 1);
        }
        if (again.failedTests.length > 0) {
          console.error(
            `[api tests] Isolation retry saw real assertion failures; not retrying further:\n`
            + again.failedTests.map((name) => `  - ${name}`).join("\n"),
          );
          process.exit(result.status ?? 1);
        }
      }
      if (!passed) {
        console.error(
          `[api tests] Clone-flake isolation retries exhausted for ${file}.`,
        );
        process.exit(result.status ?? 1);
      }
    }
    process.exit(0);
  }
}

process.exit(result.status ?? 1);
