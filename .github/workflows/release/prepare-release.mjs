#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "../../..");

function parseArgs(argv) {
  const result = {
    version: "",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--version" || arg === "-v") {
      result.version = String(argv[i + 1] || "").trim();
      i += 1;
    }
  }

  return result;
}

function assertSemver(version) {
  const semverPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
  if (!semverPattern.test(version)) {
    throw new Error(`Invalid version '${version}'. Expected semver like 1.0.1, 1.1.0 or 2.0.0-rc.1`);
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, obj) {
  fs.writeFileSync(filePath, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
}

function updateWorkspaceVersions(version) {
  const apiPkgPath = path.join(repoRoot, "api", "package.json");
  const appPkgPath = path.join(repoRoot, "app", "package.json");

  const apiPkg = readJson(apiPkgPath);
  const appPkg = readJson(appPkgPath);

  apiPkg.version = version;
  appPkg.version = version;

  writeJson(apiPkgPath, apiPkg);
  writeJson(appPkgPath, appPkg);
}

function getLastTag() {
  try {
    return execSync("git describe --tags --abbrev=0", { cwd: repoRoot, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function getCommitSubjects(lastTag) {
  if (!lastTag) {
    return [];
  }

  const range = `${lastTag}..HEAD`;
  const command = `git --no-pager log ${range} --pretty=format:%s --no-merges`;

  try {
    const output = execSync(command, { cwd: repoRoot, encoding: "utf8" }).trim();
    if (!output) {
      return [];
    }
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 60);
  } catch {
    return [];
  }
}

function readFileIfExists(filePath, fallback = "") {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  return fs.readFileSync(filePath, "utf8");
}

function ensureChangelogSection(version) {
  const changelogPath = path.join(repoRoot, "CHANGELOG.md");
  const today = new Date().toISOString().slice(0, 10);
  const current = readFileIfExists(changelogPath, "# Changelog\n\nAll notable changes to this project are documented in this file.\n");

  if (current.includes(`## [${version}]`)) {
    return;
  }

  const lastTag = getLastTag();
  const commits = getCommitSubjects(lastTag);
  const commitLines = commits.length > 0
    ? commits.map((msg) => `- ${msg}`).join("\n")
    : "- Release preparation and maintenance updates";

  const newSection = [
    `## [${version}] - ${today}`,
    "",
    "### Changed",
    commitLines,
    "",
  ].join("\n");

  const headerMatch = current.match(/^# Changelog\r?\n\r?\nAll notable changes to this project are documented in this file\.\r?\n?/);
  if (headerMatch) {
    const header = headerMatch[0].endsWith("\n\n") ? headerMatch[0] : `${headerMatch[0]}\n`;
    const rest = current.slice(headerMatch[0].length).replace(/^\n+/, "");
    fs.writeFileSync(changelogPath, `${header}${newSection}${rest}`, "utf8");
    return;
  }

  fs.writeFileSync(changelogPath, `# Changelog\n\nAll notable changes to this project are documented in this file.\n\n${newSection}${current}`, "utf8");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.version) {
    throw new Error("Missing required --version argument");
  }

  assertSemver(args.version);
  updateWorkspaceVersions(args.version);
  ensureChangelogSection(args.version);

  console.log(`Prepared release ${args.version}`);
  console.log("Updated: api/package.json, app/package.json, CHANGELOG.md");
  console.log("Next: run 'yarn install', 'yarn build', 'yarn lint', commit, tag v<version>, push");
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`release prep failed: ${message}`);
  process.exit(1);
}

