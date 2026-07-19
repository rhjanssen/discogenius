import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function findRepoRoot(startDir: string): string {
  let current = startDir;

  while (true) {
    const packageJsonPath = path.join(current, "package.json");
    const hasApiWorkspace = fs.existsSync(path.join(current, "api", "package.json"));
    const hasAppWorkspace = fs.existsSync(path.join(current, "app", "package.json"));

    if (hasApiWorkspace && hasAppWorkspace) {
      return current;
    }

    if (fs.existsSync(packageJsonPath)) {
      try {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as { workspaces?: unknown };
        if (Array.isArray(packageJson.workspaces) && packageJson.workspaces.includes("api") && packageJson.workspaces.includes("app")) {
          return current;
        }
      } catch {
        // Ignore parse errors and keep walking upward.
      }
    }

    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return path.resolve(startDir, "..", "..", "..");
}

export const REPO_ROOT = findRepoRoot(__dirname);

function resolveOverridePath(rawPath: string): string {
  if (path.isAbsolute(rawPath)) {
    return rawPath;
  }

  return path.join(REPO_ROOT, rawPath);
}

const DEFAULT_APP_DATA_DIR = process.env.DOCKER === 'true' ? "/config" : path.join(REPO_ROOT, "config");
const APP_DATA_DIR_OVERRIDE = process.env.DISCOGENIUS_APP_DATA?.trim();
const CONFIG_DIR_OVERRIDE = process.env.DISCOGENIUS_CONFIG_DIR?.trim();
const DB_PATH_OVERRIDE = process.env.DB_PATH?.trim();

export const APP_DATA_DIR = APP_DATA_DIR_OVERRIDE
  ? resolveOverridePath(APP_DATA_DIR_OVERRIDE)
  : (CONFIG_DIR_OVERRIDE ? resolveOverridePath(CONFIG_DIR_OVERRIDE) : DEFAULT_APP_DATA_DIR);

// Maintain CONFIG_DIR as an alias to APP_DATA_DIR for backward compatibility with paths
export const CONFIG_DIR = APP_DATA_DIR;

export const DB_PATH = DB_PATH_OVERRIDE
  ? resolveOverridePath(DB_PATH_OVERRIDE)
  : path.join(APP_DATA_DIR, "discogenius.db");
