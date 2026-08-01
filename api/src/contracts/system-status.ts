// Types only — mirrors HealthDiagnosticsSnapshot (api/src/services/commands/health.ts)
// and its building blocks (api/src/utils/health.ts). No runtime parser: this is an
// internal, read-only diagnostics view, consistent with the untyped-passthrough
// precedent used for the streaming-provider status endpoint.

export type HealthCheckStatusContract = "ok" | "warning" | "error";
export type HealthOverallStatusContract = "healthy" | "degraded" | "unhealthy";

export interface HealthCheckResultContract {
  scope: string;
  status: HealthCheckStatusContract;
  message: string;
  details?: Record<string, unknown>;
}

export interface BackendCapabilitySnapshotContract {
  name: "tiddl";
  status: HealthOverallStatusContract;
  available: boolean;
  ready: boolean;
  capabilities: {
    audio: boolean;
    video: boolean;
    spatialAudio: boolean;
    highResAudio: boolean;
  };
  checks: HealthCheckResultContract[];
  notes: string[];
}

export interface UnmatchedImportArtistContract {
  provider: string;
  providerId: string;
  name: string;
  status: string;
  method: string;
  updatedAt: string | null;
}

export interface ManualMatchCandidateContract {
  mbid: string;
  name: string;
  disambiguation: string | null;
  type: string | null;
  releaseCount: number;
  sharedAlbums: string[];
  nameMatched: boolean;
}

export interface ManualMatchCandidatesContract {
  provider: string;
  providerId: string;
  artistName: string;
  providerAlbumTitles: string[];
  candidates: ManualMatchCandidateContract[];
}

export interface ManualMatchResultContract {
  localArtistId: string;
  artistName: string;
  mbid: string;
  monitored: true;
  intakeQueued: boolean;
}

export interface DeepDatabaseHealthResultContract {
  checkedAt: string;
  durationMs: number;
  status: HealthOverallStatusContract;
  quickCheck: {
    status: "ok" | "error";
    message: string;
    results: string[];
  };
  foreignKeys: {
    status: "ok" | "error";
    violationCount: number;
    sample: Array<Record<string, unknown>>;
  };
  executedOffMainThread: boolean;
  persisted: boolean;
  error?: string;
  persistenceError?: string;
}

export interface SystemStatusContract {
  checkedAt: string;
  status: HealthOverallStatusContract;
  paths: {
    config: HealthCheckResultContract;
    database: HealthCheckResultContract;
    download: HealthCheckResultContract;
    library: {
      music: HealthCheckResultContract;
      spatial: HealthCheckResultContract;
      video: HealthCheckResultContract;
    };
    runtime: {
      tiddl: HealthCheckResultContract;
    };
  };
  tools: {
    ffmpeg: HealthCheckResultContract;
    tiddl: HealthCheckResultContract;
  };
  backends: {
    tiddl: BackendCapabilitySnapshotContract;
  };
  controls: {
    downloadQueue: {
      isPaused: boolean;
      persisted: boolean;
      updatedAt: string | null;
    };
  };
  subsystems: {
    database: {
      schema: HealthCheckResultContract;
      wal: HealthCheckResultContract;
      storage: HealthCheckResultContract;
      deep: HealthCheckResultContract;
      lastDeepResult: DeepDatabaseHealthResultContract | null;
    };
    commandQueue: HealthCheckResultContract;
    scheduledTasks: HealthCheckResultContract;
    imports: HealthCheckResultContract;
    statistics: HealthCheckResultContract;
    catalog: HealthCheckResultContract;
  };
  issues: HealthCheckResultContract[];
  /** Added by the /system/status route (not part of the /health probe snapshot). */
  imports: {
    unmatchedArtists: UnmatchedImportArtistContract[];
  };
}
