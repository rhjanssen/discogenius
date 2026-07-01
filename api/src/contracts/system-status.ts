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
  issues: HealthCheckResultContract[];
}
