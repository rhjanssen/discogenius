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
const result = spawnSync(
  tsxBin,
  ["--test", "--test-concurrency=1", ...runnerArgs, ...testFiles],
  { cwd: root, stdio: "inherit", shell: process.platform === "win32" },
);

process.exit(result.status ?? 1);
