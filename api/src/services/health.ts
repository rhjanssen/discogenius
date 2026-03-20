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
    getTidalDlNgCapabilitySnapshot,
    TIDAL_DL_NG_CONFIG_DIR,
    getTidalDlNgCommand,
} from "./tidal-dl-ng.js";

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
      atmos: HealthCheckResult;
      video: HealthCheckResult;
    };
    runtime: {
      orpheus: HealthCheckResult;
      orpheusState: HealthCheckResult;
      tidalDlNg: HealthCheckResult;
    };
  };
  tools: {
    git: HealthCheckResult;
    python: HealthCheckResult;
    ffmpeg: HealthCheckResult;
    tidalDlNg: HealthCheckResult;
  };
  backends: {
    orpheus: BackendCapabilitySnapshot;
    tidalDlNg: BackendCapabilitySnapshot;
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

export function collectHealthDiagnosticsSnapshot(): HealthDiagnosticsSnapshot {
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
  const atmosPathCheck = checkWritablePath("paths.library.atmos", Config.getAtmosPath(), {
    kind: "dir",
    displayName: "Atmos library directory",
  });
  const videoPathCheck = checkWritablePath("paths.library.video", Config.getVideoPath(), {
    kind: "dir",
    displayName: "Video library directory",
  });
  const orpheusRuntimeCheck = checkWritablePath("paths.runtime.orpheus", ORPHEUS_RUNTIME_DIR, {
    kind: "dir",
    displayName: "Orpheus runtime directory",
  });
  const orpheusStateCheck = checkWritablePath("paths.runtime.orpheusState", path.dirname(ORPHEUS_SETTINGS_FILE), {
    kind: "dir",
    displayName: "Orpheus state directory",
  });
  const tidalDlNgConfigCheck = checkWritablePath("paths.runtime.tidalDlNg", TIDAL_DL_NG_CONFIG_DIR, {
    kind: "dir",
    displayName: "tidal-dl-ng config directory",
  });

  const gitCheck = checkCommandAvailability("tools.git", "git", "Git");
  const pythonCheck = checkCommandAvailability(
    "tools.python",
    process.platform === "win32" ? "python" : "python3",
    "Python",
  );
  const ffmpegCheck = checkCommandAvailability("tools.ffmpeg", "ffmpeg", "FFmpeg");
  const tidalDlNgCommandCheck = checkCommandAvailability(
    "tools.tidalDlNg",
    getTidalDlNgCommand().command,
    "tidal-dl-ng",
  );

  const orpheus = getOrpheusCapabilitySnapshot();
  const tidalDlNg = getTidalDlNgCapabilitySnapshot();
  const issues = flattenChecks(
    [
      configPathCheck,
      databasePathCheck,
      downloadPathCheck,
      musicPathCheck,
      atmosPathCheck,
      videoPathCheck,
      orpheusRuntimeCheck,
      orpheusStateCheck,
      tidalDlNgConfigCheck,
      gitCheck,
      pythonCheck,
      ffmpegCheck,
      tidalDlNgCommandCheck,
    ],
    orpheus.checks,
    tidalDlNg.checks,
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
        atmos: atmosPathCheck,
        video: videoPathCheck,
      },
      runtime: {
        orpheus: orpheusRuntimeCheck,
        orpheusState: orpheusStateCheck,
        tidalDlNg: tidalDlNgConfigCheck,
      },
    },
    tools: {
      git: gitCheck,
      python: pythonCheck,
      ffmpeg: ffmpegCheck,
      tidalDlNg: tidalDlNgCommandCheck,
    },
    backends: {
      orpheus,
      tidalDlNg,
    },
    issues,
  };
}
