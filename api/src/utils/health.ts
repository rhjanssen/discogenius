import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

export type HealthCheckStatus = "ok" | "warning" | "error";
export type HealthOverallStatus = "healthy" | "degraded" | "unhealthy";

export interface HealthCheckResult {
  scope: string;
  status: HealthCheckStatus;
  message: string;
  details?: Record<string, unknown>;
}

export interface BackendCapabilitySnapshot {
  name: "orpheus" | "tidal-dl-ng";
  status: HealthOverallStatus;
  available: boolean;
  ready: boolean;
  capabilities: {
    audio: boolean;
    video: boolean;
    atmos: boolean;
    highResAudio: boolean;
    playlists: boolean;
  };
  checks: HealthCheckResult[];
  notes: string[];
}

function resolveExistingAncestor(targetPath: string): string | null {
  let current = path.resolve(targetPath);

  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }

  return current;
}

export function rollupHealthStatus(checks: Iterable<{ status: HealthCheckStatus }>): HealthOverallStatus {
  let sawWarning = false;

  for (const check of checks) {
    if (check.status === "error") {
      return "unhealthy";
    }
    if (check.status === "warning") {
      sawWarning = true;
    }
  }

  return sawWarning ? "degraded" : "healthy";
}

export function resolveCommandPath(command: string): string | null {
  const candidate = command.trim();
  if (!candidate) {
    return null;
  }

  if (path.isAbsolute(candidate) || candidate.includes(path.sep) || candidate.includes("/")) {
    return fs.existsSync(candidate) ? candidate : null;
  }

  const runner = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(runner, [candidate], { encoding: "utf-8" });
  if (result.status !== 0) {
    return null;
  }

  const lines = `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return lines[0] || null;
}

export function checkCommandAvailability(
  scope: string,
  command: string,
  displayName: string = command,
): HealthCheckResult {
  const resolved = resolveCommandPath(command);
  if (resolved) {
    return {
      scope,
      status: "ok",
      message: `${displayName} is available`,
      details: { command, resolvedPath: resolved },
    };
  }

  return {
    scope,
    status: "error",
    message: `${displayName} is not available on PATH`,
    details: { command },
  };
}

export function checkWritablePath(
  scope: string,
  targetPath: string,
  options: { kind?: "file" | "dir"; displayName?: string } = {},
): HealthCheckResult {
  const kind = options.kind || "dir";
  const displayName = options.displayName || targetPath;
  const resolvedPath = path.resolve(targetPath);
  const exists = fs.existsSync(resolvedPath);

  if (exists) {
    const stat = fs.statSync(resolvedPath);

    if (kind === "dir" && !stat.isDirectory()) {
      return {
        scope,
        status: "error",
        message: `${displayName} exists but is not a directory`,
        details: { path: resolvedPath, kind },
      };
    }

    if (kind === "file" && !stat.isFile()) {
      return {
        scope,
        status: "error",
        message: `${displayName} exists but is not a file`,
        details: { path: resolvedPath, kind },
      };
    }

    try {
      fs.accessSync(resolvedPath, fs.constants.W_OK);
      return {
        scope,
        status: "ok",
        message: `${displayName} is writable`,
        details: { path: resolvedPath, kind },
      };
    } catch {
      return {
        scope,
        status: "error",
        message: `${displayName} exists but is not writable`,
        details: { path: resolvedPath, kind },
      };
    }
  }

  const parentPath = kind === "file" ? path.dirname(resolvedPath) : path.dirname(resolvedPath);
  const existingAncestor = resolveExistingAncestor(parentPath);
  if (!existingAncestor) {
    return {
      scope,
      status: "error",
      message: `${displayName} does not exist and no writable ancestor could be found`,
      details: { path: resolvedPath, kind },
    };
  }

  try {
    fs.accessSync(existingAncestor, fs.constants.W_OK);
    return {
      scope,
      status: "warning",
      message: `${displayName} does not exist yet, but it can be created`,
      details: { path: resolvedPath, kind, parentPath: existingAncestor },
    };
  } catch {
    return {
      scope,
      status: "error",
      message: `${displayName} does not exist and parent path is not writable`,
      details: { path: resolvedPath, kind, parentPath: existingAncestor },
    };
  }
}
