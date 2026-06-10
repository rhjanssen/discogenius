import path from "path";
import { Config, CONFIG_DIR, DB_PATH } from "./config.js";
import { getRuntimeDiagnosticsSnapshot } from "./runtime-diagnostics.js";
import {
  checkCommandAvailability,
  checkWritablePath,
  rollupHealthStatus,
  type BackendCapabilitySnapshot,
  type HealthCheckResult,
  type HealthOverallStatus,
} from "../utils/health.js";
import { getOrpheusCapabilitySnapshot, ORPHEUS_RUNTIME_DIR, ORPHEUS_SETTINGS_FILE } from "./orpheus.js";
import {
  getTiddlCapabilitySnapshot,
  TIDDL_CONFIG_DIR,
} from "./providers/tidal/tiddl-backend.js";

export interface HealthDiagnosticsSnapshot {
  checkedAt: string;
  status: HealthOverallStatus;
  runtime: ReturnType<typeof getRuntimeDiagnosticsSnapshot>;
  paths: {
    config: HealthCheckResult;
    database: HealthCheckResult;
    download: HealthCheckResult;
    library: {
      music: HealthCheckResult;
      spatial: HealthCheckResult;
      video: HealthCheckResult;
    };
    runtime: {
      orpheus: HealthCheckResult;
      orpheusState: HealthCheckResult;
      tiddl: HealthCheckResult;
    };
  };
  tools: {
    git: HealthCheckResult;
    python: HealthCheckResult;
    ffmpeg: HealthCheckResult;
    tiddl: HealthCheckResult;
  };
  backends: {
    orpheus: BackendCapabilitySnapshot;
    tiddl: BackendCapabilitySnapshot;
  };
  issues: HealthCheckResult[];
}

function flattenChecks(...groups: Array<HealthCheckResult[] | undefined>): HealthCheckResult[] {
  return groups.reduce<HealthCheckResult[]>((acc, group) => {
    if (group) {
      acc.push(...group);
    }
    return acc;
  }, []).filter((check) => check.status !== "ok");
}

function disabledDownloadCheck(scope: string, displayName: string, details: Record<string, unknown> = {}): HealthCheckResult {
  return {
    scope,
    status: "ok",
    message: `${displayName} is not required because downloads are disabled`,
    details: { ...details, disabledBy: "DISCOGENIUS_DISABLE_DOWNLOADS=1" },
  };
}

function markBackendDisabled(snapshot: BackendCapabilitySnapshot): BackendCapabilitySnapshot {
  return {
    ...snapshot,
    status: "healthy",
    available: false,
    ready: false,
    checks: snapshot.checks.map((check) => disabledDownloadCheck(check.scope, check.scope, check.details)),
    notes: ["Download processor is disabled for this runtime."],
  };
}

export function collectHealthDiagnosticsSnapshot(): HealthDiagnosticsSnapshot {
  const downloadsDisabled = process.env.DISCOGENIUS_DISABLE_DOWNLOADS === "1";
  const configPathCheck = checkWritablePath("paths.config", CONFIG_DIR, {
    kind: "dir",
    displayName: "Config directory",
  });
  const databasePathCheck = checkWritablePath("paths.database", DB_PATH, {
    kind: "file",
    displayName: "Database file",
  });
  const downloadPathCheck = checkWritablePath("paths.download", Config.getDownloadPath(), {
    kind: "dir",
    displayName: "Download directory",
  });
  const musicPathCheck = checkWritablePath("paths.library.music", Config.getMusicPath(), {
    kind: "dir",
    displayName: "Music library directory",
  });
  const spatialPathCheck = checkWritablePath("paths.library.spatial", Config.getSpatialPath(), {
    kind: "dir",
    displayName: "Spatial library directory",
  });
  const videoPathCheck = checkWritablePath("paths.library.video", Config.getVideoPath(), {
    kind: "dir",
    displayName: "Video library directory",
  });
  const IS_DOCKER = process.env.DOCKER === "true";
  const orpheusRuntimeCheck = downloadsDisabled
    ? disabledDownloadCheck("paths.runtime.orpheus", "Orpheus runtime", { path: ORPHEUS_RUNTIME_DIR })
    : IS_DOCKER
    ? {
      scope: "paths.runtime.orpheus",
      status: "ok" as const,
      message: "Orpheus runtime baked into Docker image",
      details: { path: ORPHEUS_RUNTIME_DIR },
    }
    : checkWritablePath("paths.runtime.orpheus", ORPHEUS_RUNTIME_DIR, {
      kind: "dir",
      displayName: "Orpheus runtime directory",
    });
  const orpheusStateCheck = downloadsDisabled
    ? disabledDownloadCheck("paths.runtime.orpheusState", "Orpheus state directory", { path: path.dirname(ORPHEUS_SETTINGS_FILE) })
    : checkWritablePath("paths.runtime.orpheusState", path.dirname(ORPHEUS_SETTINGS_FILE), {
      kind: "dir",
      displayName: "Orpheus state directory",
    });
  const tiddlConfigCheck = downloadsDisabled
    ? disabledDownloadCheck("paths.runtime.tiddl", "tiddl config directory", { path: TIDDL_CONFIG_DIR })
    : checkWritablePath("paths.runtime.tiddl", TIDDL_CONFIG_DIR, {
      kind: "dir",
      displayName: "tiddl config directory",
    });

  const gitCheck = checkCommandAvailability("tools.git", "git", "Git");
  const pythonCheck = checkCommandAvailability(
    "tools.python",
    process.platform === "win32" ? "python" : "python3",
    "Python",
  );
  const ffmpegCheck = downloadsDisabled
    ? disabledDownloadCheck("tools.ffmpeg", "FFmpeg", { command: "ffmpeg" })
    : checkCommandAvailability("tools.ffmpeg", "ffmpeg", "FFmpeg");
  const tiddlCommandCheck = downloadsDisabled
    ? disabledDownloadCheck("tools.tiddl", "tiddl", { command: process.env.TIDDL_BIN || "tiddl" })
    : checkCommandAvailability(
      "tools.tiddl",
      process.env.TIDDL_BIN || "tiddl",
      "tiddl",
    );

  const rawOrpheus = getOrpheusCapabilitySnapshot();
  const rawTiddl = getTiddlCapabilitySnapshot();
  const orpheus = downloadsDisabled ? markBackendDisabled(rawOrpheus) : rawOrpheus;
  const tiddl = downloadsDisabled ? markBackendDisabled(rawTiddl) : rawTiddl;
  const issues = flattenChecks(
    [
      configPathCheck,
      databasePathCheck,
      downloadPathCheck,
      musicPathCheck,
      spatialPathCheck,
      videoPathCheck,
      orpheusRuntimeCheck,
      orpheusStateCheck,
      tiddlConfigCheck,
      gitCheck,
      pythonCheck,
      ffmpegCheck,
      tiddlCommandCheck,
    ],
    orpheus.checks,
    tiddl.checks,
  );

  return {
    checkedAt: new Date().toISOString(),
    status: rollupHealthStatus(issues),
    runtime: getRuntimeDiagnosticsSnapshot(),
    paths: {
      config: configPathCheck,
      database: databasePathCheck,
      download: downloadPathCheck,
      library: {
        music: musicPathCheck,
        spatial: spatialPathCheck,
        video: videoPathCheck,
      },
      runtime: {
        orpheus: orpheusRuntimeCheck,
        orpheusState: orpheusStateCheck,
        tiddl: tiddlConfigCheck,
      },
    },
    tools: {
      git: gitCheck,
      python: pythonCheck,
      ffmpeg: ffmpegCheck,
      tiddl: tiddlCommandCheck,
    },
    backends: {
      orpheus,
      tiddl,
    },
    issues,
  };
}
