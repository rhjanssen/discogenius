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

const tsxBin = join(root, "..", "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");

const CLONE_FLAKE_SIGNATURE = "Unable to deserialize cloned data";

function runOnce(files, { capture = false } = {}) {
  return spawnSync(
    tsxBin,
    ["--test", "--test-concurrency=1", ...runnerArgs, ...files],
    {
      cwd: root,
      stdio: capture ? ["inherit", "pipe", "pipe"] : "inherit",
      shell: process.platform === "win32",
      encoding: capture ? "utf8" : undefined,
      maxBuffer: 256 * 1024 * 1024,
    },
  );
}

// Parse the top-level TAP results for failed test *files* (node --test reports
// one numbered subtest per file: "not ok 102 - src/…/foo.test.ts").
function parseFailedFiles(stdout) {
  const failed = new Set();
  for (const rawLine of String(stdout || "").split(/\r?\n/)) {
    const match = /^not ok \d+ - (\S.*\.test\.ts)(?:\s|$)/.exec(rawLine.trim());
    if (match) failed.add(match[1].trim());
  }
  return [...failed];
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
  const failedFiles = parseFailedFiles(combinedOutput);
  if (failedFiles.length > 0) {
    console.warn(`[api tests] Test-runner clone flake detected; re-running ${failedFiles.length} affected file(s) in isolation: ${failedFiles.join(", ")}`);
    result = runOnce(failedFiles, { capture: false });
  } else {
    console.warn("[api tests] Test-runner clone flake detected without a parseable file; retrying the whole suite once.");
    result = runOnce(testFiles, { capture: false });
  }
}

process.exit(result.status ?? 1);
