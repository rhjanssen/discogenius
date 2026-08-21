# Release-hardening synthetic load harness

The release-hardening harness creates a deterministic, disposable active-schema
Discogenius environment and drives mixed Artist workflow load through real
SQLite WAL connections. It exists to test queue liveness and final-state truth
without making thousands of provider or MusicBrainz requests.

It has two deliberately separate phases:

1. `generate-synthetic-load.ts` creates the active production schema, isolated
   media roots, a deterministic catalogue/provider/curation/file fixture, and
   the initial command queue.
2. `run-synthetic-load.ts` drains only commands whose `ref_id` belongs to that
   guarded run. Worker threads claim and update rows in the real `commands`
   table, heartbeat execution leases, persist phase progress, enqueue
   per-Artist handoffs, recover injected worker death/hangs, and write durable
   evidence.

The deterministic workers do **not** invoke production metadata, provider,
download, or import handlers. That boundary is intentional: this layer can
create 500+ Artist load without external timing or credentials, while Docker,
local-MusicBrainz, Servarr, provider, media-lifecycle, and browser layers remain
separate release gates. A pass here is not a release-readiness verdict by
itself.

## Safety

The generator never deletes an output directory and refuses to create runs at:

- a filesystem root;
- the user home directory;
- the repository root;
- the repository's `config`, `library`, or `downloads` roots.

An output root must either be under the ignored
`test-results/release-hardening` directory or contain a
`discogenius-release-hardening` path segment. Every run receives a marker file.
The runner refuses a directory without a matching marker and refuses to
overwrite an existing `final.json`.

All generated Stereo, Spatial, Video, download, and unmapped roots are children
of the run directory. Synthetic media payloads are small deterministic
placeholder bytes, not decodable media and never suitable for import/ffmpeg
validation.

## Typical runs

From the repository root:

```powershell
yarn --cwd api tsx scripts/release-hardening/generate-synthetic-load.ts `
  --seed 2800 `
  --primary-artists 500 `
  --credited-artists 2000 `
  --history-rows 100000 `
  --concurrency 4 `
  --run-id rc-seed-2800-c4

yarn --cwd api tsx scripts/release-hardening/run-synthetic-load.ts `
  --run-root ..\test-results\release-hardening\rc-seed-2800-c4 `
  --concurrency 4 `
  --lease-ms 1500 `
  --heartbeat-ms 100 `
  --metrics-ms 1000 `
  --timeout-ms 1800000
```

The generator defaults are 500 monitored primary Artists, 2,000 first-degree
credited Artists, and 100,000 historical commands. `--credited-artists`
supports at least 10,000. Use a new run id for every concurrency/configuration
point; never reuse a completed fixture.

For a repeated deterministic stress run, add `--cycles N` to the runner. Each
additional cycle queues a fresh primary-Artist workflow after the preceding
global reconciliation completes. Credited hydration remains first-degree and
is performed once.

## Dataset shapes

The seeded active-schema data includes:

- large and small discographies;
- one, deluxe, and anniversary Editions with overlapping Recordings;
- direct canonical video Tracks and exact audio↔video Recording relations;
- exact, source-subset, source-superset, overlap, and missing provider matches;
- complete single-source, incomplete, provider-local composite, stale, and
  unavailable Acquisition Plans;
- explicit, clean, and unknown explicitness evidence;
- lossless and TIDAL Spatial source capabilities;
- Stereo, Spatial, and Video Library curation;
- automatic/manual Album and Edition choices, additive Editions, and Album
  locks;
- one regular and one lyric inline video winner plus unselected alternatives;
- exact provider-item/variant identity on a subset of existing files;
- isolated existing audio, Spatial, video, and unmapped placeholder files;
- pending downloads and a configurable large command history.

Credited edges are persisted in `credited-edges.ndjson`. The coordinator admits
them in bounded batches only after their introducing primary Artist refreshes.
Primary workflow handoffs have higher priority. A small deterministic fairness
promotion keeps credited work moving without allowing the entire credited set
to flood the queue.

The primary pipeline is:

```text
RefreshArtist
→ MatchArtistProviders
→ RescanFolders
→ CurateArtist
→ Artist-scoped DownloadMissing
```

Only after every primary Artist is terminal and credited hydration is terminal
does the runner enqueue the global `DownloadMissing` reconciliation. A poisoned
Artist fails visibly after bounded attempts; it does not stop unrelated work.

## Deterministic failures

Artist index schedules are stable across seeds so configuration comparisons see
the same liveness pressure:

- slow external phase;
- one transient provider-matching failure;
- poisoned curation command with bounded terminal failure;
- worker process death;
- worker hang with an expired lease.

The worker pool restores capacity. Owned `started` rows are conditionally
requeued using their worker token, attempts remain durable, and exhausted work
fails. `--no-failure-injection` keeps the same fixture but disables execution
failures for pure throughput comparison.

These are harness-level recovery mechanics. They validate the test and evidence
pipeline and produce realistic WAL contention; production
`CommandExecutor`/worker-pool recovery must still pass its own integration and
Docker restart tests.

## Durable evidence

Each run directory contains:

- `.discogenius-release-hardening-run.json` — destructive-scope guard marker;
- `manifest.json` — run id, Git SHA, schema, seed, configuration, and roots;
- `expected.json` — exact expected canonical/provider/curation/file counts;
- `credited-edges.ndjson` — deterministic first-degree credit work;
- `events.ndjson` — transitions, injected failures, recovery, and completion;
- `metrics.ndjson` — periodic machine-readable snapshots;
- `heartbeat.json` — latest status for coarse observation;
- `final.json` — complete assertions, integrity, performance summary,
  limitations, and blockers;
- `config/discogenius.db` — isolated schema-42 database;
- `media/` — isolated fixture roots.

Metrics include completed/failed Artists, active commands, queue depth, oldest
eligible command age, oldest heartbeat age, database/WAL size, database read
latency, event-loop delay, process CPU/memory, worker utilization, claim
latency, busy retries, recovery counts, and the last progress transition.

`apiLatency` and `sseDelay` are explicitly `null` with a reason. The harness
does not fabricate measurements for services it did not launch.

## Assertions

`final.json` fails the run when any blocking assertion disagrees:

- schema 42, `PRAGMA quick_check`, and `foreign_key_check`;
- exact canonical, provider match, plan, Library, video, file, and history
  counts versus `expected.json`;
- all file records stay under the disposable media root and exist;
- no synthetic command remains queued or started;
- poison failures are visible and exactly bounded;
- every non-poison primary Artist reaches Artist-scoped Download Missing;
- credited hydration completes;
- global reconciliation completes for every cycle;
- the first Artist reaches download-ready before the whole primary set;
- credited work progresses before the last primary Artist on meaningful runs;
- injected worker death/hang is recovered;
- recoverable failures complete on a later durable attempt.

## Long-running observation

Launch a long run once and retain its run directory. `heartbeat.json` is the
coarse status surface; `metrics.ndjson` and `events.ndjson` preserve the full
timeline. A monitor does not need minute-by-minute polling.

For a multi-hour run, use a larger `--cycles` and set `--metrics-ms` to a
reasonable interval such as 60,000. Inspect the heartbeat at major milestones
or on an external failure signal, then inspect `final.json` after completion.
A running heartbeat is not a pass; only a completed `final.json` is.

