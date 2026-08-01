<!-- markdownlint-disable MD013 -->
# MB-local mode — catalog provider notes

Status: **runtime-wired for 2.2.0.** Discogenius can use either the hosted
Servarr Metadata Server or a local MusicBrainz-docker mirror as the selected
catalog source. Local MusicBrainz mode reads Postgres directly for catalog
identity, release/track shape, UPC/barcode, and ISRC evidence; it uses the
co-located `/ws/2` service only when available for Solr-ranked search.

MusicBrainz-docker is intentionally treated as external infrastructure, not a
provider-plugin dependency. See `docs/EXTERNAL_DEPENDENCIES.md` for the
packaging policy: Discogenius joins the MB network and derives connection
settings, but does not clone or build the MusicBrainz stack inside its image.

## The abstraction

`api/src/services/catalog/`:

| File | Role |
| --- | --- |
| `catalog-provider.ts` | The `CatalogProvider` interface (symmetric to `StreamingProvider`). DTOs are the existing Servarr Metadata Server/Lidarr shapes (`LidarrArtist`, `LidarrReleaseGroupDetail`, `LidarrRelease`, `LidarrTrack`) — no parallel DTO hierarchy. |
| `servarr-metadata-catalog-provider.ts` | `ServarrMetadataCatalogProvider` — thin adapter over today's `ServarrMetadataService`. |
| `postgres-musicbrainz-catalog-provider.ts` | `PostgresMusicBrainzCatalogProvider` — primary local-MB runtime implementation. Reads MusicBrainz Postgres directly and optionally uses `/ws/2` for Solr search. |
| `local-musicbrainz-catalog-provider.ts` | Legacy `/ws/2` fixture provider retained for tests/reference. |
| `musicbrainz-ws-mapping.ts` | Pure mappers: MB `/ws/2` JSON → Servarr Metadata Server/Lidarr DTOs. Network-free, fixture-tested. |
| `mb-connection.ts` | Host-only MusicBrainz-docker connection derivation (`host` → Postgres DSN + optional `/ws/2` URL). |
| `index.ts` | Barrel + a `catalogProviderRegistry` mirroring `streamingProviderManager`. Active source resolves from config. |

### Methods

`getArtist`, `getArtistReleaseGroups`, `getReleaseGroup`, `getReleaseWithTracks`,
`getRecording?`, `lookupByUPC?`, `lookupByISRC?`, `search`.

The last three are optional because **Servarr Metadata Server can't serve them**
(no standalone recording endpoint, no UPC index, no ISRC index). Until MB-local
is connected, matching falls back to title / track-count / date / duration /
position and accepts slightly weaker matches. The Postgres MB provider implements
all of them.

## Supplemental Servarr metadata in local mode

Local MusicBrainz is the authority for MusicBrainz identity, release grouping,
release/track/recording shape, UPC/barcode, ISRC, and URL-relation matching.
It does not need to replace every convenience field currently returned by the
Servarr Metadata Server.

When MB-local mode is active, Discogenius may still query the Servarr Metadata
Server as a supplemental source for fields that improve UI/library management
but do not define identity:

- cached or normalized artwork URLs and image proxy hints
- metadata-server ratings/popularity where available
- other Servarr convenience fields that can be safely treated as display/cache
  supplements

Those supplemental reads must be optional, failure-tolerant, and visibly
separate from the selected catalog source health. A Servarr outage in MB-local
mode must not block artist search, release refresh, matching, or imports.

## Backend: direct Postgres plus optional `/ws/2` search

The primary local-MB provider reads the MusicBrainz Postgres schema directly.
This avoids the `/ws/2` release-group N+1 fan-out because one SQL query can
return release group → releases → media → tracks → recordings → ISRCs. Search
uses the MusicBrainz web/Solr endpoint at `host:5000/ws/2` when it is reachable;
otherwise it falls back to Postgres `pg_trgm`/`ILIKE`.

The legacy `/ws/2` provider remains useful as a mapping fixture/reference, but
it is not the runtime path.

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
3. Inside the shared network Discogenius reaches Postgres at `db:5432`. If a
   full MusicBrainz web/search service is also reachable at the configured host
   on `:5000`, Discogenius uses it for Solr-backed search; otherwise it falls
   back to Postgres search.

The overlay sets:

- `DISCOGENIUS_CATALOG_SOURCE` — `servarr-metadata` (factory default when unset)
  | `musicbrainz-local`. **This env var overrides Settings and survives wiping
  `config/` / the SQLite DB**, so a reset that keeps `.env` still forces local-MB
  if the var is set. Omit it for online Servarr on fresh installs.
- `MB_LOCAL_HOST` — MusicBrainz-docker host or service name, default `db`
- `DISCOGENIUS_LOCAL_MB_REFRESH_CONCURRENCY` — bounded `RefreshArtist`
  concurrency used by local-MB mode only (default `2`, supported sweep range
  `1`–`8`). Servarr remains fixed at one concurrent Artist refresh.

The Settings page uses the same host-only value. Enter `localhost`,
`musicbrainz.mydomain.com`, `db`, or `host:postgresPort` for non-standard
Postgres ports; Discogenius derives the Postgres DSN and `/ws/2` probe URL.

## Mode switching

**What shipped:** both Servarr and MB-local hydrate the same Discogenius SQLite
catalog on refresh. Switching `catalog.source` only swaps the active
`CatalogProvider`; the next artist/album refresh reads from the new source.
There is no catalog-table flush on toggle.

**Evidence differences:** Servarr typically omits ISRC/UPC; MB-local fills
`Recordings.isrcs` and `AlbumReleases.barcode`. ISRCs are usually preserved
across a later Servarr re-hydrate (`COALESCE`); barcodes can be cleared when
Servarr rewrites the release. Switching back to MB-local and refreshing fills
those holes again. Matching, slot selection, curation, and (with
`remove_unmonitored_files`) library prune/replace can then change — not at the
moment of the Settings toggle, but after refresh → rematch → curate → download.

**Not the plan:** the older “MB-local = flush SQLite and live-query Postgres
only” design. Treat that as obsolete unless we deliberately revisit architecture.
Remaining UX work is optional “refresh monitored artists now” after a switch
(see `docs/TASKS.md`).

## Testing

- `musicbrainz-ws-mapping` + `LocalMusicBrainzCatalogProvider`: fixture unit
  tests against recorded `/ws/2` responses with an injected fetcher (no live
  network).
- `ServarrMetadataCatalogProvider`: delegating-adapter tests with a spy service.
- `mb-connection`: host-only normalization plus derived Postgres DSN and
  co-located `/ws/2` search URL tests.
- **Live container e2e is skipped** — no MB-docker container is provisioned in
  CI; the behavior is covered by the fixture unit tests above.

## Catalog source ↔ schema parity

The curated schema is source-agnostic: both Servarr and MB-local converge on the
Lidarr DTOs → the same write path → the same curated columns. The differences are
in the mapping layer and a few fields MB cannot serve.

**MB serves natively** (with the right `inc`), and is strictly richer than the
Servarr replica for two things:

- Per-recording artist-credit (`inc=artist-credits`) at recording AND track
  level — the queryable recording↔artist-credit relation the recording-centric
  song-set work needs (Servarr exposes only a single primary artist per track).
- ISRCs per recording (`inc=isrcs`, plus `/isrc/{isrc}`) and UPC/barcode via
  `barcode:` search. Servarr/Skyhook strips these — the whole reason for MB-local.

Also native: url-rels/external links, genres, aliases, ratings, labels, media/disc
structure, country, status, and life-span dates.
`PostgresMusicBrainzCatalogProvider` maps these into the curated columns
(`Recordings` ISRCs/video flags, `AlbumReleases.label`/external URLs, `Albums`
genres/links/aliases/rating).

**Still supplemental in MB-local mode** (come from Servarr/CAA/fanart, never
overriding MB identity):

- Cover art bytes (album art from CAA directly; artist images from fanart via
  Servarr — not in CAA).
- Overview / bio / album review (MB has none; Servarr enriches from
  Wikipedia/Wikidata).
- Normalized 0–100 popularity (MB has only a raw rating).
