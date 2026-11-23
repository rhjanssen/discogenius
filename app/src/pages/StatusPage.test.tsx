import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HealthCheckResultContract, SystemStatusContract } from "@contracts/system-status";
import { api } from "@/services/api";
import StatusPage, { CheckList } from "./StatusPage";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function check(scope: string, status: HealthCheckResultContract["status"], message: string): HealthCheckResultContract {
  return { scope, status, message } as HealthCheckResultContract;
}

describe("Status page health checks", () => {
  it("leads with the problems and folds the passing checks away", () => {
    render(
      <FluentProvider theme={webLightTheme}>
        <CheckList
          checks={[
            check("paths.config", "ok", "Config directory is writable"),
            check("paths.database", "ok", "Database file is writable"),
            check("tools.tiddl", "error", "tiddl is not available on PATH"),
          ]}
        />
      </FluentProvider>,
    );

    expect(screen.getByText("tiddl is not available on PATH")).toBeTruthy();
    expect(screen.queryByText("Config directory is writable")).toBeNull();

    const disclosure = screen.getByRole("button", { name: "2 checks passed" });
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(disclosure);
    expect(screen.getByText("Config directory is writable")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Hide passing checks" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("renders app version, providerAuth, extra issues like files.recovery, and SQLite write-lock hold", async () => {
    const okCheck = (scope: string, message = `${scope} ok`) => check(scope, "ok", message);
    const providerAuthWarning = check("providers.auth", "warning", "Provider action required (deezer: ARL expired)");
    const recoveryError = check("files.recovery", "error", "1 file mutation(s) need recovery; library file jobs are blocked");
    const statusPayload: SystemStatusContract = {
      version: "2.27.0",
      checkedAt: "2026-11-23T00:00:00.000Z",
      status: "unhealthy",
      runtime: {
        uptimeMs: 60_000,
        commands: {
          sqliteWriteLock: {
            held: false,
            heldForMs: 0,
            queueDepth: 0,
            maxWaitMs: 320,
            longestHoldMs: 4_200,
            heldByLabel: null,
            longestHoldLabel: "curation:audio-library",
          },
        },
      },
      paths: {
        config: okCheck("paths.config"),
        database: okCheck("paths.database"),
        download: okCheck("paths.download"),
        library: {
          music: okCheck("paths.library.music"),
          spatial: okCheck("paths.library.spatial"),
          video: okCheck("paths.library.video"),
        },
        runtime: {
          tiddl: okCheck("paths.runtime.tiddl"),
        },
      },
      tools: {
        ffmpeg: okCheck("tools.ffmpeg"),
        tiddl: okCheck("tools.tiddl"),
      },
      backends: {
        tiddl: {
          name: "tiddl",
          status: "healthy",
          available: true,
          ready: true,
          capabilities: { audio: true, video: true, spatialAudio: true, highResAudio: true },
          checks: [],
          notes: [],
        },
      },
      controls: {
        downloadQueue: { isPaused: false, persisted: false, updatedAt: null },
      },
      subsystems: {
        database: {
          schema: okCheck("database.schema"),
          wal: okCheck("database.wal"),
          storage: okCheck("database.storage"),
          deep: okCheck("database.deep"),
          lastDeepResult: null,
        },
        commandQueue: okCheck("commands.queue"),
        scheduledTasks: okCheck("scheduler.tasks"),
        imports: okCheck("imports.health"),
        statistics: okCheck("statistics.freshness"),
        catalog: okCheck("catalog.configuration"),
        providerAuth: providerAuthWarning,
      },
      providerAuth: [],
      issues: [providerAuthWarning, recoveryError],
      imports: { unmatchedArtists: [], unmatchedArtistTotal: 0 },
    };

    vi.spyOn(api, "getSystemStatus").mockResolvedValue(statusPayload);
    vi.spyOn(api, "getStreamingProviders").mockResolvedValue({
      providers: [],
      defaultProviderId: "tidal",
      providerPriority: [],
    });
    vi.spyOn(api, "getStatusOverview").mockResolvedValue({
      stats: { artists: { total: 0, monitored: 0 }, albums: { total: 0, monitored: 0 }, tracks: { total: 0, downloaded: 0 } },
      queue: { isPaused: false, processing: false, activeCount: 0, pendingCount: 0 },
      rateLimitMetrics: null,
    } as never);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <FluentProvider theme={webLightTheme}>
          <StatusPage />
        </FluentProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText("v2.27.0")).toBeTruthy();
    });
    expect(screen.getByText("Problems found")).toBeTruthy();
    expect(screen.getByText("Provider action required (deezer: ARL expired)")).toBeTruthy();
    expect(screen.getByText("1 file mutation(s) need recovery; library file jobs are blocked")).toBeTruthy();
    expect(screen.getByText(/Longest hold: 4\.2 s \(curation:audio-library\)/)).toBeTruthy();
  });
});
