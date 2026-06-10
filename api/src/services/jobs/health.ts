import { Config, CONFIG_DIR, DB_PATH } from "../config/config.js";
import { getRuntimeDiagnosticsSnapshot } from "./runtime-diagnostics.js";
import {
  checkCommandAvailability,
  checkWritablePath,
  rollupHealthStatus,
  type BackendCapabilitySnapshot,
  type HealthCheckResult,
  type HealthOverallStatus,
} from "../../utils/health.js";
import {
  getTiddlCapabilitySnapshot,
  getTiddlBinary,
  TIDDL_CONFIG_DIR,
} from "../providers/tidal/tiddl.js";

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
      tiddl: HealthCheckResult;
    };
  };
  tools: {
    ffmpeg: HealthCheckResult;
    tiddl: HealthCheckResult;
  };
  backends: {
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
  const tiddlConfigCheck = downloadsDisabled
    ? disabledDownloadCheck("paths.runtime.tiddl", "tiddl config directory", { path: TIDDL_CONFIG_DIR })
    : checkWritablePath("paths.runtime.tiddl", TIDDL_CONFIG_DIR, {
      kind: "dir",
      displayName: "tiddl config directory",
    });

  const ffmpegCheck = downloadsDisabled
    ? disabledDownloadCheck("tools.ffmpeg", "FFmpeg", { command: "ffmpeg" })
    : checkCommandAvailability("tools.ffmpeg", "ffmpeg", "FFmpeg");
  const tiddlCommandCheck = downloadsDisabled
    ? disabledDownloadCheck("tools.tiddl", "tiddl", { command: getTiddlBinary() })
    : checkCommandAvailability("tools.tiddl", getTiddlBinary(), "tiddl");

  const rawTiddl = getTiddlCapabilitySnapshot();
  const tiddl = downloadsDisabled ? markBackendDisabled(rawTiddl) : rawTiddl;
  const issues = flattenChecks(
    [
      configPathCheck,
      databasePathCheck,
      downloadPathCheck,
      musicPathCheck,
      spatialPathCheck,
      videoPathCheck,
      tiddlConfigCheck,
      ffmpegCheck,
      tiddlCommandCheck,
    ],
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
        tiddl: tiddlConfigCheck,
      },
    },
    tools: {
      ffmpeg: ffmpegCheck,
      tiddl: tiddlCommandCheck,
    },
    backends: {
      tiddl,
    },
    issues,
  };
}
