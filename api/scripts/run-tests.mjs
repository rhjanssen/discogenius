import { mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const CLONE_FLAKE_SIGNATURE = "Unable to deserialize cloned data";
const MAX_CLONE_FLAKE_RETRIES = 5;

function stripAnsi(text) {
  return String(text || "").replace(/\u001b\[[0-9;]*m/g, "");
}

/**
 * Node 22's default reporter is TAP and ends with a plan line (`1..N`) plus
 * `# tests` / `# fail`. Node 24's default reporter is spec: no plan line, and
 * the summary is `ℹ tests` / `ℹ fail`. Either summary means the runner finished.
 * A plan line is not required.
 */
export function reporterSummary(output) {
  const text = stripAnsi(output);
  const tests = [...text.matchAll(/^(?:#|\u2139)\s+tests\s+(\d+)\s*$/gm)];
  const fails = [...text.matchAll(/^(?:#|\u2139)\s+fail\s+(\d+)\s*$/gm)];
  if (tests.length === 0 || fails.length === 0) return null;
  return {
    tests: Number(tests.at(-1)[1]),
    fail: Number(fails.at(-1)[1]),
  };
}

export function runnerOutput(result) {
  return `${result?.stdout || ""}\n${result?.stderr || ""}`;
}

/** The child exited on its own and printed a reporter summary. */
export function runnerCompleted(result) {
  if (result?.error || result?.signal) return false;
  return reporterSummary(runnerOutput(result)) !== null;
}

/** Clean exit and a summary that records zero failures. */
export function runnerSucceeded(result) {
  if (!runnerCompleted(result)) return false;
  if ((result?.status ?? 1) !== 0) return false;
  return reporterSummary(runnerOutput(result)).fail === 0;
}

export function describeRunnerStop(result) {
  const parts = [`status=${result?.status ?? "null"}`];
  if (result?.signal) parts.push(`signal=${result.signal}`);
  if (result?.error) {
    const code = result.error.code ? `${result.error.code} ` : "";
    parts.push(`error=${code}${result.error.message || result.error}`);
  }
  const summary = reporterSummary(runnerOutput(result));
  if (summary) parts.push(`summary tests=${summary.tests} fail=${summary.fail}`);
  else parts.push("summary=missing");
  return parts.join(" ");
}

function toRepoTestFile(file) {
  const normalized = String(file || "").replace(/\\/g, "/");
  const marker = "/src/";
  const index = normalized.lastIndexOf(marker);
  if (index >= 0) return `src/${normalized.slice(index + marker.length)}`;
  if (normalized.startsWith("src/") && normalized.endsWith(".test.ts")) return normalized;
  return null;
}

/**
 * TAP `not ok` lines whose diagnostic is the clone-flake signature are runner
 * failures, not assertion failures. Node 22 reports those either as the file
 * name or as the individual test name, with the signature in the YAML block.
 */
export function classifyTapFailures(stdout) {
  const lines = stripAnsi(stdout).split(/\r?\n/);
  const realTests = [];
  const flakeFiles = new Set();
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^not ok \d+ - (\S.*)$/.exec(lines[index].trim());
    if (!match) continue;
    const name = match[1].trim().replace(/\\/g, "/");
    const block = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (lines[cursor].trim() === "...") break;
      block.push(lines[cursor]);
    }
    const diagnostic = block.join("\n");
    const flake = diagnostic.includes(CLONE_FLAKE_SIGNATURE);
    const location = /location:\s*['"]?([^'"\n]+?\.test\.ts)/.exec(diagnostic);
    const file = toRepoTestFile(location?.[1] || (name.endsWith(".test.ts") ? name : ""));
    if (flake) {
      if (file) flakeFiles.add(file);
      continue;
    }
    realTests.push(name);
  }
  return { realTests, flakeFiles: [...flakeFiles] };
}

export function isCloneFlakeOnly(stdout, stderr, status) {
  if ((status ?? 1) === 0) return { flaked: false };
  const combined = `${String(stdout || "")}\n${String(stderr || "")}`;
  if (!stripAnsi(combined).includes(CLONE_FLAKE_SIGNATURE)) return { flaked: false };
  const { realTests, flakeFiles } = classifyTapFailures(combined);
  return { flaked: true, failedFiles: flakeFiles, failedTests: realTests, combined };
}

function writeAll(stream, chunk) {
  return new Promise((resolve, reject) => {
    stream.write(chunk, (error) => (error ? reject(error) : resolve()));
  });
}

async function writeCaptured(result) {
  if (result?.stdout) await writeAll(process.stdout, result.stdout);
  if (result?.stderr) await writeAll(process.stderr, result.stderr);
}

function flushStreams() {
  return Promise.all([writeAll(process.stdout, ""), writeAll(process.stderr, "")]);
}

async function exitAfterFlush(code) {
  const status = Number.isInteger(code) ? code : 1;
  await flushStreams();
  process.exit(status);
}

function collectTests(dir, root) {
  const entries = readdirSync(dir).sort((left, right) => left.localeCompare(right));
  const files = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...collectTests(fullPath, root));
    } else if (entry.endsWith(".test.ts") || entry.endsWith(".test.mjs")) {
      files.push(relative(root, fullPath).replace(/\\/g, "/"));
    }
  }
  return files;
}

function runOnce(root, files, runnerArgs, { isolation = "process" } = {}) {
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
      stdio: ["inherit", "pipe", "pipe"],
      shell: false,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    },
  );
}

async function emit(result) {
  await writeCaptured(result);
  return result;
}

async function main() {
  const root = process.cwd();

  // Isolate tests from the developer's live runtime config (provider tokens,
  // config.toml). Real credentials in ./config must never change test results —
  // CI runs with an empty config directory and local runs must match it.
  if (!process.env.DISCOGENIUS_CONFIG_DIR?.trim()) {
    process.env.DISCOGENIUS_CONFIG_DIR = mkdtempSync(join(tmpdir(), "discogenius-test-config-"));
  }

  const passthroughArgs = process.argv.slice(2);
  const explicitTestFiles = passthroughArgs.filter((arg) => /\.test\.(?:ts|mjs)$/.test(arg));
  const runnerArgs = passthroughArgs.filter((arg) => !/\.test\.(?:ts|mjs)$/.test(arg));
  const testFiles = explicitTestFiles.length > 0
    ? explicitTestFiles.map((file) => file.replace(/\\/g, "/"))
    : collectTests(join(root, "src"), root);
  if (testFiles.length === 0) {
    console.error("No API test files found.");
    await exitAfterFlush(1);
  }

  // A single file can safely run in-process and avoids the process-isolation
  // clone flake entirely. The full suite still needs process isolation so each
  // file gets a clean module graph / DB_PATH.
  const initialIsolation = testFiles.length === 1 ? "none" : "process";
  let result = await emit(runOnce(root, testFiles, runnerArgs, { isolation: initialIsolation }));

  // Retry only completed test runs. An interrupted runner can contain an earlier
  // clone-flake signature; retrying just those files would skip the rest of the
  // suite and incorrectly report success. Completion is the reporter summary
  // (Node 22 `# fail`, Node 24 `ℹ fail`), not the TAP plan line Node 24 omits.
  if (!runnerCompleted(result)) {
    console.error(
      `[api tests] Test runner did not complete (${describeRunnerStop(result)}); refusing clone-flake retries.`,
    );
    await exitAfterFlush(result.status ?? 1);
  }
  if (runnerSucceeded(result)) {
    await exitAfterFlush(0);
  }
  const summary = reporterSummary(runnerOutput(result));
  if ((result.status ?? 1) === 0 && summary.fail > 0) {
    console.error(
      `[api tests] Test runner exited 0 but the summary reports ${summary.fail} failure(s).`,
    );
    await exitAfterFlush(1);
  }

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
      await exitAfterFlush(result.status ?? 1);
    }

    // Prefer the files Node named. If TAP did not name a file, re-run the whole
    // suite under process isolation (cannot safely isolation=none the full set).
    const namedFiles = flake.failedFiles;
    if (namedFiles.length === 0) {
      for (let attempt = 1; attempt <= MAX_CLONE_FLAKE_RETRIES; attempt += 1) {
        console.warn(
          `[api tests] Test-runner clone flake detected without a file name; whole-suite retry ${attempt}/${MAX_CLONE_FLAKE_RETRIES}`,
        );
        result = await emit(runOnce(root, testFiles, runnerArgs));
        if (runnerSucceeded(result)) await exitAfterFlush(0);
        if (!runnerCompleted(result)) {
          console.error(
            `[api tests] Test runner did not complete (${describeRunnerStop(result)}); refusing further retries.`,
          );
          await exitAfterFlush(result.status ?? 1);
        }
        const again = isCloneFlakeOnly(result.stdout, result.stderr, result.status);
        if (!again.flaked) await exitAfterFlush(result.status ?? 1);
        if (again.failedTests.length > 0) await exitAfterFlush(result.status ?? 1);
        if (again.failedFiles.length > 0) {
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
          result = await emit(runOnce(root, [file], runnerArgs, { isolation: "none" }));
          if (runnerSucceeded(result)) {
            passed = true;
            break;
          }
          if (!runnerCompleted(result)) {
            console.error(
              `[api tests] Isolation retry for ${file} did not complete (${describeRunnerStop(result)}).`,
            );
            await exitAfterFlush(result.status ?? 1);
          }
          const again = isCloneFlakeOnly(result.stdout, result.stderr, result.status);
          if (!again.flaked) {
            console.error(
              `[api tests] Isolation retry for ${file} failed without clone-flake signature; treating as real failure.`,
            );
            await exitAfterFlush(result.status ?? 1);
          }
          if (again.failedTests.length > 0) {
            console.error(
              `[api tests] Isolation retry saw real assertion failures; not retrying further:\n`
              + again.failedTests.map((name) => `  - ${name}`).join("\n"),
            );
            await exitAfterFlush(result.status ?? 1);
          }
        }
        if (!passed) {
          console.error(
            `[api tests] Clone-flake isolation retries exhausted for ${file}.`,
          );
          await exitAfterFlush(result.status ?? 1);
        }
      }
      await exitAfterFlush(0);
    }
  }

  await exitAfterFlush(result.status ?? 1);
}

const isDirectRun = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isDirectRun) {
  await main();
}
