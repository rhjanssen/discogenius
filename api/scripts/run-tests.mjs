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

function runOnce(files, { capture = false } = {}) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "--test", "--test-concurrency=1", ...runnerArgs, ...files],
    {
      cwd: root,
      stdio: capture ? ["inherit", "pipe", "pipe"] : "inherit",
      shell: false,
      encoding: capture ? "utf8" : undefined,
      maxBuffer: 256 * 1024 * 1024,
    },
  );
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
    const name = match[1].trim();
    if (/\.test\.ts$/.test(name)) files.add(name);
    else tests.push(name);
  }
  return { files: [...files], tests };
}

let result = runOnce(testFiles, { capture: true });
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);

// Node's test runner intermittently fails a whole file with "Unable to
// deserialize cloned data" — a child-process result-serialization flake, not a
// test assertion. Detect it across both output streams because Node has emitted
// the signature on either one. Real assertion failures do not match and fail
// immediately; retrying those would hide a flaky or genuinely broken test.
const combinedOutput = `${String(result.stdout || "")}\n${String(result.stderr || "")}`;
if ((result.status ?? 1) !== 0 && combinedOutput.includes(CLONE_FLAKE_SIGNATURE)) {
  const { files: failedFiles, tests: failedTests } = parseFailures(combinedOutput);
  if (failedTests.length > 0) {
    // Assertions failed for reasons that have nothing to do with the flake.
    // Re-running the flaked file cannot absolve them, so the suite stays red.
    console.error(
      `[api tests] Test-runner clone flake detected, but ${failedTests.length} test(s) failed on their own merits; not retrying:\n`
      + failedTests.map((name) => `  - ${name}`).join("\n"),
    );
    process.exit(result.status ?? 1);
  }
  if (failedFiles.length > 0) {
    console.warn(`[api tests] Test-runner clone flake detected; re-running ${failedFiles.length} affected file(s) in isolation: ${failedFiles.join(", ")}`);
    result = runOnce(failedFiles, { capture: false });
  } else {
    console.warn("[api tests] Test-runner clone flake detected without a parseable file; retrying the whole suite once.");
    result = runOnce(testFiles, { capture: false });
  }
}

process.exit(result.status ?? 1);
