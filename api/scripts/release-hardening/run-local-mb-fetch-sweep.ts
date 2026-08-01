import fs from "node:fs";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import pLimit from "p-limit";
import {
  PostgresMusicBrainzCatalogProvider,
} from "../../src/services/catalog/postgres-musicbrainz-catalog-provider.js";
import {
  buildMbPostgresDsn,
  buildMbSearchWebUrl,
  normalizeMbHost,
} from "../../src/services/catalog/mb-connection.js";
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
  minimumReleaseGroups: number;
};

const FIXTURES: Fixture[] = [
  { name: "Bastille", mbid: "7808accb-6395-4b25-858c-678bbb73896b", minimumReleaseGroups: 90 },
  { name: "Bakermat", mbid: "df60a241-e8df-4917-82db-1f1a8ecd7cc3", minimumReleaseGroups: 40 },
  { name: "Marshmello", mbid: "301b45a4-b8b9-410e-8344-4b4eaf96691a", minimumReleaseGroups: 100 },
  { name: "Lost Frequencies", mbid: "ea7260de-e1b1-43f1-bb11-f78274a36308", minimumReleaseGroups: 40 },
  { name: "Klingande", mbid: "1faebb11-9c72-4a6f-8886-351efcab991e", minimumReleaseGroups: 20 },
  { name: "Felix Jaehn", mbid: "930448f9-a67a-402f-bc73-2bf6b279afaa", minimumReleaseGroups: 60 },
  { name: "Ella Eyre", mbid: "f7602b15-66cc-4b31-b3b6-ed3c0a29eea3", minimumReleaseGroups: 30 },
  { name: "Craig David", mbid: "89e39f67-65cc-4f90-b145-b1b56c209f8a", minimumReleaseGroups: 60 },
  { name: "Alessia Cara", mbid: "97e69730-3791-423b-9770-287261588854", minimumReleaseGroups: 50 },
  { name: "Rag’n’Bone Man", mbid: "37993cdf-f61a-488f-8cca-07e03b8aaa02", minimumReleaseGroups: 40 },
];

type ParsedOptions = {
  host: string;
  runId: string;
  outputRoot: string;
  concurrencyValues: number[];
  poolSizes: number[];
  selectedConcurrency: number;
  statementTimeoutMs: number;
  warmup: boolean;
};

function parseIntegerList(value: string, minimum: number, maximum: number): number[] {
  const values = value
    .split(",")
    .map((entry) => Number(entry.trim()))
    .filter((entry) => Number.isInteger(entry) && entry >= minimum && entry <= maximum);
  return Array.from(new Set(values));
}

function parseArgs(argv: string[]): ParsedOptions {
  const apiRoot = path.resolve(process.cwd());
  const repoRoot = path.resolve(apiRoot, "..");
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument: ${token}`);
    }
    if (token === "--no-warmup") {
      flags.add(token);
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${token}`);
    }
    values.set(token, value);
    index += 1;
  }

  const host = normalizeMbHost(values.get("--host") ?? "192.168.1.100");
  if (!host) throw new Error("A local MusicBrainz host is required");
  const concurrencyValues = parseIntegerList(
    values.get("--concurrencies") ?? "1,2,3,4,5,6,8",
    1,
    8,
  );
  const poolSizes = parseIntegerList(values.get("--pool-sizes") ?? "3,4,6,8", 1, 16);
  if (concurrencyValues.length === 0 || poolSizes.length === 0) {
    throw new Error("Concurrency and pool-size sweeps must each contain at least one value");
  }

  const selectedConcurrency = Number(values.get("--selected-concurrency") ?? "4");
  if (!Number.isInteger(selectedConcurrency) || selectedConcurrency < 1 || selectedConcurrency > 8) {
    throw new Error("--selected-concurrency must be an integer from 1 to 8");
  }
  const statementTimeoutMs = Number(values.get("--statement-timeout-ms") ?? "60000");
  if (!Number.isInteger(statementTimeoutMs) || statementTimeoutMs < 1_000 || statementTimeoutMs > 300_000) {
    throw new Error("--statement-timeout-ms must be between 1000 and 300000");
  }

  const outputRoot = assertSafeOutputRoot(
    values.get("--output-root")
      ?? path.join(repoRoot, "test-results", "release-hardening"),
    repoRoot,
  );
  const runId = validateRunId(
    values.get("--run-id") ?? `local-mb-fetch-${defaultRunId(2800)}`,
  );
  return {
    host,
    runId,
    outputRoot,
    concurrencyValues,
    poolSizes,
    selectedConcurrency,
    statementTimeoutMs,
    warmup: !flags.has("--no-warmup"),
  };
}

function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.min(
    ordered.length - 1,
    Math.max(0, Math.ceil(ordered.length * fraction) - 1),
  );
  return Number(ordered[index].toFixed(3));
}

function summarize(values: number[]) {
  return {
    minimumMs: percentile(values, 0),
    medianMs: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    maximumMs: percentile(values, 1),
  };
}

async function probeSearchWeb(searchWebUrl: string): Promise<Record<string, unknown>[]> {
  const results: Record<string, unknown>[] = [];
  for (const fixture of FIXTURES.slice(0, 2)) {
    const startedAt = performance.now();
    const response = await fetch(
      `${searchWebUrl}/artist/${fixture.mbid}?fmt=json&inc=aliases`,
      {
        headers: {
          Accept: "application/json",
          "User-Agent": "Discogenius/2.8.0 local-MB release-hardening sweep",
        },
        signal: AbortSignal.timeout(10_000),
      },
    );
    const payload = await response.json() as Record<string, unknown>;
    results.push({
      fixture: fixture.name,
      status: response.status,
      latencyMs: Number((performance.now() - startedAt).toFixed(3)),
      returnedMbid: payload.id ?? null,
      returnedName: payload.name ?? null,
      aliases: Array.isArray(payload.aliases) ? payload.aliases.length : null,
    });
  }
  return results;
}

type ArtistMeasurement = {
  name: string;
  mbid: string;
  releaseGroups: number;
  editions: number;
  tracks: number;
  videoTracks: number;
  queueWaitMs: number;
  artistFetchMs: number;
  detailBatchMs: number;
  serviceMs: number;
  queueToCompletionMs: number;
};

async function measureConfiguration(options: {
  connectionString: string;
  searchWebUrl: string;
  concurrency: number;
  poolSize: number;
  statementTimeoutMs: number;
  label: string;
}): Promise<Record<string, unknown>> {
  const provider = new PostgresMusicBrainzCatalogProvider({
    connectionString: options.connectionString,
    searchWebUrl: options.searchWebUrl,
    poolSize: options.poolSize,
    statementTimeoutMs: options.statementTimeoutMs,
  });
  const limiter = pLimit(options.concurrency);
  const loopDelay = monitorEventLoopDelay({ resolution: 20 });
  loopDelay.enable();
  const cpuStart = process.cpuUsage();
  const runStartedAt = performance.now();
  let peakRssBytes = process.memoryUsage().rss;
  const memorySampler = setInterval(() => {
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  }, 25);
  memorySampler.unref();

  try {
    const measurements = await Promise.all(FIXTURES.map((fixture) => limiter(async () => {
      const serviceStartedAt = performance.now();
      const artist = await provider.getArtist(fixture.mbid);
      const artistFetchedAt = performance.now();
      if (artist.artistname !== fixture.name) {
        throw new Error(
          `Fixture identity mismatch for ${fixture.mbid}: expected ${fixture.name}, got ${artist.artistname}`,
        );
      }
      if (artist.Albums.length < fixture.minimumReleaseGroups) {
        throw new Error(
          `${fixture.name} returned only ${artist.Albums.length} release groups; expected at least ${fixture.minimumReleaseGroups}`,
        );
      }

      const details = await provider.getReleaseGroupDetails(
        artist.Albums.map((album) => album.Id),
      );
      const completedAt = performance.now();
      let editions = 0;
      let tracks = 0;
      let videoTracks = 0;
      for (const entry of details) {
        for (const release of entry.detail.Releases ?? []) {
          editions += 1;
          tracks += release.Tracks?.length ?? 0;
          videoTracks += (release.Tracks ?? []).filter((track) => track.IsVideo).length;
        }
      }

      return {
        name: fixture.name,
        mbid: fixture.mbid,
        releaseGroups: details.length,
        editions,
        tracks,
        videoTracks,
        queueWaitMs: Number((serviceStartedAt - runStartedAt).toFixed(3)),
        artistFetchMs: Number((artistFetchedAt - serviceStartedAt).toFixed(3)),
        detailBatchMs: Number((completedAt - artistFetchedAt).toFixed(3)),
        serviceMs: Number((completedAt - serviceStartedAt).toFixed(3)),
        queueToCompletionMs: Number((completedAt - runStartedAt).toFixed(3)),
      } satisfies ArtistMeasurement;
    })));

    const durationMs = performance.now() - runStartedAt;
    const cpu = process.cpuUsage(cpuStart);
    const cpuMicros = cpu.user + cpu.system;
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
    return {
      label: options.label,
      concurrency: options.concurrency,
      poolSize: options.poolSize,
      durationMs: Number(durationMs.toFixed(3)),
      artistsCompleted: measurements.length,
      artistsPerHour: Number(((measurements.length * 3_600_000) / durationMs).toFixed(3)),
      timeToFirstArtistMs: Number(Math.min(
        ...measurements.map((measurement) => measurement.queueToCompletionMs),
      ).toFixed(3)),
      queueToCompletion: summarize(measurements.map((measurement) => measurement.queueToCompletionMs)),
      serviceDuration: summarize(measurements.map((measurement) => measurement.serviceMs)),
      artistHeaderFetch: summarize(measurements.map((measurement) => measurement.artistFetchMs)),
      releaseDetailBatch: summarize(measurements.map((measurement) => measurement.detailBatchMs)),
      cpu: {
        userMicros: cpu.user,
        systemMicros: cpu.system,
        percentOfOneCore: Number(((cpuMicros / 1_000) / durationMs * 100).toFixed(3)),
      },
      eventLoop: {
        meanMs: Number((loopDelay.mean / 1_000_000).toFixed(3)),
        p95Ms: Number((loopDelay.percentile(95) / 1_000_000).toFixed(3)),
        p99Ms: Number((loopDelay.percentile(99) / 1_000_000).toFixed(3)),
        maxMs: Number((loopDelay.max / 1_000_000).toFixed(3)),
      },
      memory: {
        peakRssBytes,
        finalHeapUsedBytes: process.memoryUsage().heapUsed,
      },
      totals: {
        releaseGroups: measurements.reduce((sum, measurement) => sum + measurement.releaseGroups, 0),
        editions: measurements.reduce((sum, measurement) => sum + measurement.editions, 0),
        tracks: measurements.reduce((sum, measurement) => sum + measurement.tracks, 0),
        videoTracks: measurements.reduce((sum, measurement) => sum + measurement.videoTracks, 0),
      },
      artists: measurements,
    };
  } finally {
    clearInterval(memorySampler);
    loopDelay.disable();
    await provider.dispose();
  }
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

  const connectionString = buildMbPostgresDsn(options.host);
  const searchWebUrl = buildMbSearchWebUrl(options.host);
  if (!searchWebUrl) {
    throw new Error(`Could not derive the local MusicBrainz /ws/2 URL from ${options.host}`);
  }
  const startedAt = new Date().toISOString();
  writeJson(path.join(runRoot, ".discogenius-release-hardening-run.json"), {
    format: "discogenius-local-mb-fetch-sweep/v1",
    disposable: true,
    runRoot,
    createdAt: startedAt,
  });

  const searchWeb = await probeSearchWeb(searchWebUrl);
  let warmup: Record<string, unknown> | null = null;
  if (options.warmup) {
    warmup = await measureConfiguration({
      connectionString,
      searchWebUrl,
      concurrency: 1,
      poolSize: 3,
      statementTimeoutMs: options.statementTimeoutMs,
      label: "unscored-cache-warmup",
    });
  }

  const concurrencySweep: Record<string, unknown>[] = [];
  for (const concurrency of options.concurrencyValues) {
    concurrencySweep.push(await measureConfiguration({
      connectionString,
      searchWebUrl,
      concurrency,
      poolSize: 8,
      statementTimeoutMs: options.statementTimeoutMs,
      label: `fetch-concurrency-${concurrency}-pool-8`,
    }));
  }

  const poolSweep: Record<string, unknown>[] = [];
  for (const poolSize of options.poolSizes) {
    poolSweep.push(await measureConfiguration({
      connectionString,
      searchWebUrl,
      concurrency: options.selectedConcurrency,
      poolSize,
      statementTimeoutMs: options.statementTimeoutMs,
      label: `fetch-concurrency-${options.selectedConcurrency}-pool-${poolSize}`,
    }));
  }

  const result = {
    format: "discogenius-local-mb-fetch-sweep/v1",
    status: "passed",
    gitSha: getGitSha(repoRoot),
    startTime: startedAt,
    endTime: new Date().toISOString(),
    source: {
      mode: "musicbrainz-local",
      host: options.host,
      postgres: {
        transport: "direct PostgreSQL",
        port: Number(options.host.split(":")[1] ?? 5432),
        database: "musicbrainz_db",
        schema: "musicbrainz,public",
      },
      search: {
        transport: "local /ws/2 HTTP",
        url: searchWebUrl,
      },
    },
    dataset: {
      fixtures: FIXTURES,
      artistCount: FIXTURES.length,
      shape: "full release-group detail for every release group returned by getArtist",
    },
    configuration: {
      concurrencyValues: options.concurrencyValues,
      poolSizes: options.poolSizes,
      selectedConcurrency: options.selectedConcurrency,
      statementTimeoutMs: options.statementTimeoutMs,
      warmup: options.warmup,
    },
    searchWeb,
    warmup,
    concurrencySweep,
    poolSweep,
    notMeasured: {
      sqliteCommitConcurrency: "This fetch sweep is read-only against MusicBrainz PostgreSQL.",
      providerMatching: "No streaming provider requests were made.",
      apiLatency: "No Discogenius HTTP server was launched by this layer.",
      sseDelay: "No SSE connection was launched by this layer.",
      commandClaims: "Production command execution is a separate Docker functional gate.",
      wal: "No Discogenius SQLite database was opened by this layer.",
    },
  };
  const resultPath = path.join(runRoot, "final.json");
  writeJson(resultPath, result);
  console.log(JSON.stringify({
    status: result.status,
    runId: options.runId,
    resultPath,
    gitSha: result.gitSha,
    configurations: concurrencySweep.length + poolSweep.length,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
