<!-- markdownlint-disable MD013 -->
# MB-local mode — catalog provider notes (U3 scaffolding)

Status: **scaffolding, not wired into runtime.** This documents the
`CatalogProvider` abstraction added in U3 and the plan for serving the canonical
catalog directly from a local MusicBrainz-docker instance instead of the
SkyHook/Lidarr replica. It is the implementation companion to
`docs/DATA_MODEL_TARGET.md` §3.

No live behavior changed: the app still uses the SkyHook flow
(`api/src/services/metadata/skyhook-proxy.ts`) exactly as before. Everything here
is additive and behind interfaces/stubs.

## The abstraction

`api/src/services/catalog/`:

| File | Role |
| --- | --- |
| `catalog-provider.ts` | The `CatalogProvider` interface (symmetric to `StreamingProvider`). DTOs are the existing SkyHook/Lidarr shapes (`LidarrArtist`, `LidarrReleaseGroupDetail`, `LidarrRelease`, `LidarrTrack`) — no parallel DTO hierarchy. |
| `skyhook-catalog-provider.ts` | `SkyhookCatalogProvider` — thin adapter over today's `SkyHookProxy`. Documents current behavior as one implementation; changes nothing. |
| `local-musicbrainz-catalog-provider.ts` | `LocalMusicBrainzCatalogProvider` — **stub**, reads the MB-docker `:5000` web-service mirror. Not registered as active. |
| `musicbrainz-ws-mapping.ts` | Pure mappers: MB `/ws/2` JSON → SkyHook/Lidarr DTOs. Network-free, fixture-tested. |
| `musicbrainz-postgres-queries.ts` | Pure SQL builders for the direct-Postgres path (performance follow-up). No I/O, no `pg` dependency. |
| `musicbrainz-postgres-client.ts` | Optional read-only `pg` client scaffold, behind a structural `PgPool` type (no `pg` import). |
| `index.ts` | Barrel + a `catalogProviderRegistry` mirroring `streamingProviderManager`. Active source = `skyhook`. |

### Methods

`getArtist`, `getArtistReleaseGroups`, `getReleaseGroup`, `getReleaseWithTracks`,
`getRecording?`, `lookupByUPC?`, `lookupByISRC?`, `search`.

The last three are optional because **SkyHook can't serve them** (no standalone
recording endpoint, no UPC index, no ISRC index). Per §3, until MB-local is
connected, matching falls back to title / track-count / date / duration /
position and accepts slightly weaker matches. The MB-local provider implements
all of them.

## Two backends, adopt cheapest first

### 1. `:5000` web-service mirror (ships first)

The MB-docker `musicbrainz` service exposes the same `/ws/2` JSON as
musicbrainz.org — which existing MB-shaped code already consumes (see
`musicbrainz-video-service.ts`) — but **without the 1-req/s public limit** on
your own instance. So `LocalMusicBrainzCatalogProvider` simply fetches `/ws/2`
endpoints and runs them through `musicbrainz-ws-mapping.ts`.

Endpoints used:

- `GET /ws/2/artist/{gid}?inc=release-groups&fmt=json`
- `GET /ws/2/release-group/{gid}?inc=releases+artist-credits&fmt=json`
- `GET /ws/2/release/{gid}?inc=recordings+artist-credits+isrcs+labels&fmt=json`
- `GET /ws/2/recording/{gid}?inc=artist-credits+isrcs&fmt=json`
- `GET /ws/2/release?query=barcode:{upc}&fmt=json` (UPC lookup)
- `GET /ws/2/isrc/{isrc}?inc=artist-credits&fmt=json` (ISRC lookup)
- `GET /ws/2/artist?query={q}&limit={n}&fmt=json` (search)

### 2. Direct Postgres (`:5432`, performance follow-up)

For high-volume matching, skip HTTP and query the MB Postgres schema directly.
That schema is heavily normalized and **does not match our SQLite shape**, so the
adapter must translate:

- **MBIDs are UUID `gid` columns** (the integer `id` is internal only).
- **Artist credits are a join chain:** `artist_credit` →
  `artist_credit_name` (ordered by `position`, carries `join_phrase`) →
  `artist`. `artistCreditJsonSql()` aggregates this into a JSON array, and
  `flattenCreditJson()` collapses it to a display string.
- **Dates are split** into `*_year` / `*_month` / `*_day` integer columns (e.g.
  `release_group_meta.first_release_date_*`). `splitDateSql()` reconstructs an
  ISO `YYYY`, `YYYY-MM`, or `YYYY-MM-DD` string, preserving partial dates.
- **Lengths are milliseconds** (`track.length`, `recording.length`) — same unit
  as Lidarr `DurationMs`, so no conversion.

The query builders in `musicbrainz-postgres-queries.ts` cover artist,
release_group (+ split first-release-date), release (+ barcode/status/country),
medium/track/recording (+ ISRC aggregation), recording-by-gid, and the
UPC/ISRC lookups. Each returns a parameterized `{ text, values }` with `$1` =
`gid`/identifier. They are read-only (asserted by the string-builder test).

Enabling Postgres mode (a later unit): add `pg` + `@types/pg` to
`api/package.json`, `import { Pool } from "pg"`, and pass `new Pool({...})` into
`MusicBrainzPostgresCatalogReader`. Until then nothing imports `pg`.

## Dev environment wiring

`.ref_musicbrainz-docker/` runs the MB stack (Postgres `:5432`, web API `:5000`,
Solr). To exercise MB-local mode locally, run Discogenius on the same Docker
network. See `docker-compose.mb-local.example.yml` at the repo root for the exact
snippet and steps; in short:

1. Bring up `.ref_musicbrainz-docker` per its README (build images, load a data
   dump, `docker compose up -d`). This creates a network (default
   `musicbrainz-docker_default`).
2. Start Discogenius with the overlay:
   `docker compose -f docker-compose.yml -f docker-compose.mb-local.example.yml up -d`.
3. Inside the shared network Discogenius reaches the mirror at
   `http://musicbrainz:5000/ws/2` and Postgres at `db:5432`. From the host,
   `http://localhost:5000/ws/2`.

The overlay sets (read by the future wiring unit, ignored today):

- `DISCOGENIUS_CATALOG_SOURCE` — `skyhook` (default) | `musicbrainz-local`
- `MB_LOCAL_WS_URL` — default `http://musicbrainz:5000/ws/2`
- `MB_LOCAL_PG_URL` — unset until the Postgres path is enabled

## Mode switching (per §3)

Because Layers C/D and the file inventory key on **MBID**, Layer A (the canonical
catalog tables) is a pure cache. So:

- **MB-local → SkyHook:** trigger an on-demand catalog build for the monitored
  set.
- **SkyHook → MB-local:** stop replicating and lazily empty Layer A *after a
  delay*, so an accidental toggle doesn't force a rebuild.

This switch is a future unit; U3 only lays the provider seam.

## Testing

- `musicbrainz-ws-mapping` + `LocalMusicBrainzCatalogProvider`: fixture unit
  tests against recorded `/ws/2` responses with an injected fetcher (no live
  network).
- `SkyhookCatalogProvider`: delegating-adapter tests with a spy proxy.
- `musicbrainz-postgres-queries`: string-builder tests (parameterization,
  balanced parens, read-only).
- **Live container e2e is skipped** — no MB-docker container is provisioned in
  CI; the behavior is covered by the fixture unit tests above.
