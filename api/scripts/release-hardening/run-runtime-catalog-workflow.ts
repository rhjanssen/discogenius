import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  assertSafeOutputRoot,
  defaultRunId,
  getGitSha,
  validateRunId,
  writeJson,
} from "./synthetic-load-common.js";

type Fixture = {
  name: string;
  mbid: string;
};

const FIXTURES: Fixture[] = [
  { name: "Bastille", mbid: "7808accb-6395-4b25-858c-678bbb73896b" },
  { name: "Bakermat", mbid: "df60a241-e8df-4917-82db-1f1a8ecd7cc3" },
];

const REQUIRED_WORKFLOW_STAGES = [
  "RefreshArtist",
  "MatchArtistProviders",
  "RescanFolders",
  "CurateArtist",
  "DownloadMissing",
] as const;

type Options = {
  baseUrl: string;
  runId: string;
  outputRoot: string;
  catalogMode: "musicbrainz-local" | "servarr-metadata";
  catalogHost: string | null;
  refreshConcurrency: number;
  workerPoolSize: number;
  timeoutMs: number;
  pollMs: number;
  containerName: string | null;
};

type RequestMeasurement = {
  method: string;
  path: string;
  status: number | null;
  durationMs: number;
  at: string;
  error?: string;
};

type CommandSnapshot = {
  id: number;
  type: string;
  description?: string | null;
  progress?: number;
  startTime?: number | null;
  endTime?: number | null;
  status: string;
  error?: string | null;
};

function parseArgs(argv: string[]): Options {
  const apiRoot = path.resolve(process.cwd());
  const repoRoot = path.resolve(apiRoot, "..");
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${token}`);
    values.set(token, value);
    index += 1;
  }

  const catalogMode = values.get("--catalog-mode") ?? "musicbrainz-local";
  if (catalogMode !== "musicbrainz-local" && catalogMode !== "servarr-metadata") {
    throw new Error("--catalog-mode must be musicbrainz-local or servarr-metadata");
  }
  const baseUrl = String(values.get("--base-url") ?? "http://127.0.0.1:3737")
    .replace(/\/+$/, "");
  const refreshConcurrency = Number(values.get("--refresh-concurrency") ?? "4");
  const workerPoolSize = Number(values.get("--worker-pool-size") ?? "4");
  const timeoutMs = Number(values.get("--timeout-ms") ?? "1200000");
  const pollMs = Number(values.get("--poll-ms") ?? "5000");
  if (!Number.isInteger(refreshConcurrency) || refreshConcurrency < 1 || refreshConcurrency > 8) {
    throw new Error("--refresh-concurrency must be an integer from 1 to 8");
  }
  if (!Number.isInteger(workerPoolSize) || workerPoolSize < 1 || workerPoolSize > 16) {
    throw new Error("--worker-pool-size must be an integer from 1 to 16");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 3_600_000) {
    throw new Error("--timeout-ms must be from 10000 to 3600000");
  }
  if (!Number.isInteger(pollMs) || pollMs < 250 || pollMs > 60_000) {
    throw new Error("--poll-ms must be from 250 to 60000");
  }

  return {
    baseUrl,
    catalogMode,
    catalogHost: values.get("--catalog-host") ?? null,
    refreshConcurrency,
    workerPoolSize,
    timeoutMs,
    pollMs,
    containerName: values.get("--container") ?? null,
    outputRoot: assertSafeOutputRoot(
      values.get("--output-root")
        ?? path.join(repoRoot, "test-results", "release-hardening"),
      repoRoot,
    ),
    runId: validateRunId(
      values.get("--run-id") ?? `runtime-catalog-${defaultRunId(2800)}`,
    ),
  };
}

function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.min(
    ordered.length - 1,
    Math.max(0, Math.ceil(ordered.length * fraction) - 1),
  );
  return Number((ordered[index] ?? 0).toFixed(3));
}

function summarize(values: number[]) {
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    samples: values.length,
    minimumMs: percentile(values, 0),
    meanMs: values.length > 0 ? Number((total / values.length).toFixed(3)) : null,
    medianMs: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    p99Ms: percentile(values, 0.99),
    maximumMs: percentile(values, 1),
  };
}

function inspectContainer(containerName: string | null): Record<string, unknown> | null {
  if (!containerName) return null;
  try {
    const raw = execFileSync(
      "docker",
      ["inspect", containerName, "--format", "{{json .}}"],
      { encoding: "utf8", timeout: 15_000 },
    );
    const inspected = JSON.parse(raw) as Record<string, any>;
    return {
      id: inspected.Id ?? null,
      imageId: inspected.Image ?? null,
      name: inspected.Name ?? null,
      state: inspected.State ?? null,
      mounts: Array.isArray(inspected.Mounts)
        ? inspected.Mounts.map((mount: Record<string, unknown>) => ({
            type: mount.Type,
            source: mount.Source,
            destination: mount.Destination,
            readOnly: mount.RW === false,
          }))
        : [],
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function collectContainerStats(containerName: string | null): Record<string, unknown> | null {
  if (!containerName) return null;
  try {
    const raw = execFileSync(
      "docker",
      [
        "stats",
        "--no-stream",
        "--format",
        "{{json .}}",
        containerName,
      ],
      { encoding: "utf8", timeout: 15_000 },
    );
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function fixtureForCommand(command: CommandSnapshot): Fixture | null {
  const description = String(command.description ?? "").toLocaleLowerCase();
  return FIXTURES.find((fixture) =>
    description.includes(fixture.name.toLocaleLowerCase()),
  ) ?? null;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const apiRoot = path.resolve(process.cwd());
  const repoRoot = path.resolve(apiRoot, "..");
  const runRoot = path.join(options.outputRoot, options.runId);
  if (fs.existsSync(runRoot)) {
    throw new Error(`Run directory already exists; choose a new --run-id: ${runRoot}`);
  }
  fs.mkdirSync(runRoot, { recursive: true });

  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();
  const requestMeasurements: RequestMeasurement[] = [];
  const sseEvents: Array<Record<string, unknown>> = [];
  const sseDelaysMs: number[] = [];
  const commandsById = new Map<number, CommandSnapshot>();
  const assertionFailures: string[] = [];
  const metricsPath = path.join(runRoot, "metrics.ndjson");
  const eventsPath = path.join(runRoot, "events.ndjson");
  const gitSha = getGitSha(repoRoot);
  const sourceDirty = execFileSync("git", ["status", "--porcelain"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim().length > 0;

  writeJson(path.join(runRoot, ".discogenius-release-hardening-run.json"), {
    format: "discogenius-runtime-catalog-workflow/v1",
    disposable: true,
    runRoot,
    createdAt: startedAt,
  });
  writeJson(path.join(runRoot, "start.json"), {
    format: "discogenius-runtime-catalog-workflow/v1",
    gitSha,
    sourceDirty,
    startTime: startedAt,
    options,
    fixtures: FIXTURES,
    container: inspectContainer(options.containerName),
  });

  async function requestJson<T>(
    requestPath: string,
    init: RequestInit = {},
  ): Promise<T> {
    const method = String(init.method ?? "GET").toUpperCase();
    const requestStartedAt = performance.now();
    let measurementRecorded = false;
    try {
      const response = await fetch(`${options.baseUrl}${requestPath}`, {
        ...init,
        headers: {
          Accept: "application/json",
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          ...(init.headers ?? {}),
        },
        signal: init.signal ?? AbortSignal.timeout(30_000),
      });
      const durationMs = performance.now() - requestStartedAt;
      requestMeasurements.push({
        method,
        path: requestPath.split("?", 1)[0] ?? requestPath,
        status: response.status,
        durationMs,
        at: new Date().toISOString(),
      });
      measurementRecorded = true;
      const payload = await response.json() as T;
      if (!response.ok) {
        throw new Error(`${method} ${requestPath} returned ${response.status}: ${JSON.stringify(payload)}`);
      }
      return payload;
    } catch (error) {
      if (!measurementRecorded) {
        requestMeasurements.push({
          method,
          path: requestPath.split("?", 1)[0] ?? requestPath,
          status: null,
          durationMs: performance.now() - requestStartedAt,
          at: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }
  }

  const sseAbort = new AbortController();
  const sseResponse = await fetch(`${options.baseUrl}/api/v1/events`, {
    headers: { Accept: "text/event-stream" },
    signal: sseAbort.signal,
  });
  if (!sseResponse.ok || !sseResponse.body) {
    throw new Error(`SSE connection returned ${sseResponse.status}`);
  }
  const sseOpenedAt = new Date().toISOString();
  const sseReader = sseResponse.body.getReader();
  const sseReadPromise = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { value, done } = await sseReader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        for (;;) {
          const boundary = buffer.indexOf("\n\n");
          if (boundary < 0) break;
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          let eventType = "message";
          const dataLines: string[] = [];
          for (const line of block.split("\n")) {
            if (line.startsWith("event:")) eventType = line.slice(6).trim();
            if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
          }
          if (dataLines.length === 0) continue;
          const receivedAt = new Date().toISOString();
          let data: Record<string, unknown>;
          try {
            data = JSON.parse(dataLines.join("\n")) as Record<string, unknown>;
          } catch {
            data = { raw: dataLines.join("\n") };
          }
          const emittedAtMs = Date.parse(String(data.sseEmittedAt ?? ""));
          const delayMs = Number.isFinite(emittedAtMs)
            ? Math.max(0, Date.now() - emittedAtMs)
            : null;
          if (delayMs != null) sseDelaysMs.push(delayMs);
          const event = {
            event: eventType,
            receivedAt,
            delayMs,
            data,
          };
          sseEvents.push(event);
          fs.appendFileSync(eventsPath, `${JSON.stringify(event)}\n`);
        }
      }
    } catch (error) {
      if (!sseAbort.signal.aborted) {
        assertionFailures.push(
          `SSE reader failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  })();

  let finalHealth: Record<string, any> | null = null;
  let finalStats: Record<string, unknown> | null = null;
  let finalArtists: Record<string, unknown> | null = null;
  let terminalReason = "completed";
  try {
    finalHealth = await requestJson<Record<string, any>>("/api/v1/system/status");
    finalStats = await requestJson<Record<string, unknown>>("/api/v1/stats");

    for (const fixture of FIXTURES) {
      const lookup = await requestJson<Record<string, any>>(
        `/api/v1/artist/lookup?term=${encodeURIComponent(fixture.name)}&limit=10`,
      );
      const artists = Array.isArray(lookup?.results?.artists)
        ? lookup.results.artists
        : [];
      const exact = artists.find((artist: Record<string, unknown>) =>
        String(artist.mbid ?? artist.id) === fixture.mbid
      );
      if (!exact) {
        assertionFailures.push(
          `${fixture.name} lookup did not return canonical MBID ${fixture.mbid}`,
        );
      }
    }

    for (const fixture of FIXTURES) {
      const added = await requestJson<Record<string, unknown>>("/api/v1/artist", {
        method: "POST",
        body: JSON.stringify({
          mbid: fixture.mbid,
          name: fixture.name,
        }),
      });
      if (added.queued !== true) {
        assertionFailures.push(`${fixture.name} intake was not queued`);
      }
    }

    let quietPolls = 0;
    let poll = 0;
    while (Date.now() - startedAtMs < options.timeoutMs) {
      poll += 1;
      const [commands, health, stats, artists] = await Promise.all([
        requestJson<CommandSnapshot[]>("/api/v1/command?limit=500"),
        requestJson<Record<string, any>>("/api/v1/system/status"),
        requestJson<Record<string, unknown>>("/api/v1/stats"),
        requestJson<Record<string, unknown>>(
          "/api/v1/artist?limit=100&includeDownloadStats=true&includeCounts=true",
        ),
      ]);
      finalHealth = health;
      finalStats = stats;
      finalArtists = artists;
      for (const command of commands) commandsById.set(command.id, command);
      const active = commands.filter((command) =>
        command.status === "queued" || command.status === "started"
      );
      quietPolls = active.length === 0 ? quietPolls + 1 : 0;

      const heartbeat = {
        runId: options.runId,
        poll,
        at: new Date().toISOString(),
        elapsedMs: Date.now() - startedAtMs,
        commands: {
          observed: commandsById.size,
          active: active.length,
          queued: active.filter((command) => command.status === "queued").length,
          started: active.filter((command) => command.status === "started").length,
          failed: [...commandsById.values()].filter((command) => command.status === "failed").length,
        },
        runtime: health.runtime ?? null,
        queue: health.subsystems?.commandQueue ?? null,
        database: health.subsystems?.database ?? null,
        stats,
        container: collectContainerStats(options.containerName),
      };
      fs.appendFileSync(metricsPath, `${JSON.stringify(heartbeat)}\n`);

      const sawWorkflow = FIXTURES.every((fixture) =>
        [...commandsById.values()].some((command) =>
          fixtureForCommand(command)?.mbid === fixture.mbid
          && command.type === "RefreshArtist"
        )
      );
      if (quietPolls >= 3 && sawWorkflow) break;
      await new Promise((resolve) => setTimeout(resolve, options.pollMs));
    }
    if (Date.now() - startedAtMs >= options.timeoutMs) {
      terminalReason = "timeout";
      assertionFailures.push(`Runtime workflow exceeded ${options.timeoutMs}ms`);
    }

    for (const fixture of FIXTURES) {
      const fixtureCommands = [...commandsById.values()]
        .filter((command) => fixtureForCommand(command)?.mbid === fixture.mbid);
      for (const stage of REQUIRED_WORKFLOW_STAGES) {
        const completed = fixtureCommands.some((command) =>
          command.type === stage && command.status === "completed"
        );
        if (!completed) {
          assertionFailures.push(`${fixture.name} did not complete ${stage}`);
        }
      }
      for (const command of fixtureCommands.filter((candidate) => candidate.status === "failed")) {
        assertionFailures.push(
          `${fixture.name} ${command.type} failed: ${command.error ?? "unknown error"}`,
        );
      }
      try {
        await requestJson(
          `/api/v1/artist/${encodeURIComponent(fixture.mbid)}/page?section=summary`,
        );
      } catch (error) {
        assertionFailures.push(
          `${fixture.name} summary page API failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  } catch (error) {
    terminalReason = "exception";
    assertionFailures.push(error instanceof Error ? error.message : String(error));
  } finally {
    sseAbort.abort();
    try {
      await sseReadPromise;
    } catch {
      // The explicit AbortController closes the reader at the end of the run.
    }
  }

  const commands = [...commandsById.values()].sort((left, right) => left.id - right.id);
  const perFixture = Object.fromEntries(FIXTURES.map((fixture) => {
    const fixtureCommands = commands.filter((command) =>
      fixtureForCommand(command)?.mbid === fixture.mbid
    );
    const stages = Object.fromEntries(REQUIRED_WORKFLOW_STAGES.map((stage) => {
      const candidates = fixtureCommands.filter((command) => command.type === stage);
      return [
        stage,
        candidates.map((command) => ({
          id: command.id,
          status: command.status,
          startTime: command.startTime ?? null,
          endTime: command.endTime ?? null,
          durationMs: command.startTime && command.endTime
            ? Math.max(0, command.endTime - command.startTime)
            : null,
          error: command.error ?? null,
        })),
      ];
    }));
    return [fixture.name, { mbid: fixture.mbid, stages }];
  }));
  const endpointLatency = Object.fromEntries(
    [...new Set(requestMeasurements.map((entry) => `${entry.method} ${entry.path}`))]
      .map((key) => [
        key,
        summarize(
          requestMeasurements
            .filter((entry) => `${entry.method} ${entry.path}` === key)
            .map((entry) => entry.durationMs),
        ),
      ]),
  );

  const result = {
    format: "discogenius-runtime-catalog-workflow/v1",
    status: assertionFailures.length === 0 ? "passed" : "failed",
    terminalReason,
    gitSha,
    sourceDirty,
    startTime: startedAt,
    endTime: new Date().toISOString(),
    durationMs: Date.now() - startedAtMs,
    configuration: {
      baseUrl: options.baseUrl,
      catalogMode: options.catalogMode,
      catalogHost: options.catalogHost,
      refreshConcurrency: options.refreshConcurrency,
      workerPoolSize: options.workerPoolSize,
      timeoutMs: options.timeoutMs,
      pollMs: options.pollMs,
    },
    container: inspectContainer(options.containerName),
    schemaVersion: finalHealth?.subsystems?.database?.schema?.details?.userVersion ?? null,
    health: finalHealth,
    statistics: finalStats,
    artists: finalArtists,
    workflow: perFixture,
    commands,
    apiLatency: {
      all: summarize(requestMeasurements.map((entry) => entry.durationMs)),
      byEndpoint: endpointLatency,
      serverSnapshot: finalHealth?.runtime?.requestLatency ?? null,
      requests: requestMeasurements,
    },
    sse: {
      openedAt: sseOpenedAt,
      eventCount: sseEvents.length,
      eventTypes: Object.fromEntries(
        [...new Set(sseEvents.map((event) => String(event.event)))]
          .map((eventType) => [
            eventType,
            sseEvents.filter((event) => event.event === eventType).length,
          ]),
      ),
      delay: summarize(sseDelaysMs),
      missingServerTimestamp: sseEvents.length - sseDelaysMs.length,
    },
    assertionFailures,
    evidence: {
      metricsPath,
      eventsPath,
    },
    notMeasured: {
      providerDownloads: "Downloads were disabled for this catalog/workflow gate.",
      fileImportBytes: "File lifecycle is covered by a separate isolated gate.",
      longSoak: "This is a bounded functional integration run, not a soak.",
    },
  };
  const resultPath = path.join(runRoot, "final.json");
  writeJson(resultPath, result);
  console.log(JSON.stringify({
    status: result.status,
    runId: options.runId,
    resultPath,
    gitSha,
    durationMs: result.durationMs,
    failures: assertionFailures,
  }, null, 2));
  if (result.status !== "passed") process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
