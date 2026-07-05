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

The last three are optional because **Servarr Metadata Server can't serve them** (no standalone
recording endpoint, no UPC index, no ISRC index). Per §3, until MB-local is
connected, matching falls back to title / track-count / date / duration /
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

- `DISCOGENIUS_CATALOG_SOURCE` — `servarr-metadata` (default) | `musicbrainz-local`
- `MB_LOCAL_HOST` — MusicBrainz-docker host or service name, default `db`

The Settings page uses the same host-only value. Enter `192.168.1.100`,
`musicbrainz.mydomain.com`, `db`, or `host:postgresPort` for non-standard
Postgres ports; Discogenius derives the Postgres DSN and `/ws/2` probe URL.

## Mode switching (per §3)

Because Layers C/D and the file inventory key on **MBID**, Layer A (the canonical
catalog tables) is a pure cache. So:

- **MB-local → Servarr Metadata Server:** trigger an on-demand catalog build for the monitored
  set.
- **Servarr Metadata Server → MB-local:** stop replicating and lazily empty Layer A *after a
  delay*, so an accidental toggle doesn't force a rebuild.

This switch is future work; the current implementation only lays the provider
seam.

## Testing

- `musicbrainz-ws-mapping` + `LocalMusicBrainzCatalogProvider`: fixture unit
  tests against recorded `/ws/2` responses with an injected fetcher (no live
  network).
- `ServarrMetadataCatalogProvider`: delegating-adapter tests with a spy service.
- `mb-connection`: host-only normalization plus derived Postgres DSN and
  co-located `/ws/2` search URL tests.
- **Live container e2e is skipped** — no MB-docker container is provisioned in
  CI; the behavior is covered by the fixture unit tests above.

## Curated-column parity: catalog source ↔ schema (verified 2026-06-24)

Verified the live MB-docker `:5000` `/ws/2` shapes against both the Servarr
Metadata Server shape and the curated catalog columns (schema 33). Conclusion:
**the schema itself is source-agnostic** — both sources converge on the Lidarr
DTOs → the same write path → the same curated columns. The gaps are in the
mapping/DTO layer, and a few fields MB genuinely cannot serve.

### What MB serves natively (use the right `inc`)

The MB DB is a SUPERSET of identity/relational data, and for two things it's
strictly richer than the Servarr replica:

- **Per-recording artist-credit** (`inc=artist-credits`) at recording AND track
  level: `[{name, joinphrase, artist:{id,name,sort-name}}]`. This is exactly the
  queryable recording↔artist-credit relation the recording-centric song-set item
  needs — and the blocker on dropping the `data` blob. The Servarr metadata service only
  exposes a single primary `ArtistId` per track.
- **ISRCs per recording** (`inc=isrcs`) and a dedicated `/isrc/{isrc}` endpoint;
  **UPC/barcode** via `barcode:` release search. (Skyhook strips these — the
  whole reason for MB-local.)

Also native: relations/external links (`inc=url-rels` → `relations[].url.resource`
+ `.type`), genres (`inc=genres`), aliases (`inc=aliases`), rating
(`inc=ratings` → `{votes-count, value}`), labels (`inc=labels`), media/disc
structure (`media[]` with inline `tracks[].recording`), country, status,
life-span dates.

### What MB does NOT serve → still needs Servarr Metadata Server (or CAA/fanart)

The user's intuition is correct — even in MB-local mode these are supplemental:

- **Cover art.** MB only carries a `cover-art-archive: {artwork, count, front}`
  FLAG that art exists; the bytes live at coverartarchive.org (release/RG only,
  public — fetchable directly) and **artist images are not in CAA at all**
  (fanart.tv / Wikimedia, which the Servarr server aggregates). So album art can
  come from CAA directly; artist art needs Servarr/fanart.
- **Overview / bio / album review.** MB has none (Servarr enriches from
  Wikipedia/Wikidata). Our `ArtistMetadata.overview` / `Albums.overview` columns
  would stay empty in pure MB-local mode.
- **Normalized popularity.** MB has only the raw `rating`; Servarr derives the
  0–100 popularity we store.

This matches the existing 3.0 "supplemental Servarr lookups" task: artwork URLs,
ratings/popularity, overview. Identity/credits/ISRC/UPC must always come from MB
and never be overridden by the supplement.

### The mapping gap to close BEFORE MB-local goes live

The Servarr write path (`servarr-metadata.ts`) populates the curated JSON
columns by reading the RAW Servarr payload (`raw.links`, `raw.genres`,
`raw.rating`, `raw.artistaliases`, `raw.oldids`). The Lidarr DTO interfaces do
NOT carry those fields, so `musicbrainz-ws-mapping.ts` produces clean DTOs
WITHOUT them — meaning an MB-sourced row would leave `links/genres/ratings/
aliases` empty (and the matching-evidence reader, which now reads
`Albums.links`, would be empty in MB-local mode). To reach parity when wiring
MB-local:

1. Add typed `links/genres/ratings/aliases/overview/images` fields to the shared
   catalog DTOs and have BOTH mappers populate them (Servarr from its raw shape,
   MB from `relations`/`genres`/`aliases`/`rating`). The write path then reads
   the typed DTO instead of `raw.*`.
2. **Normalize `links` to one canonical shape at WRITE time** (e.g.
   `[{type, url}]`) in both mappers, so `extractLinkUrls` /
   `getLinkedProviderArtistId` work uniformly. Servarr uses `{type, target}`; MB
   uses `{type, url:{resource}}` (nested) — today's `extractLinkUrls` only reads
   top-level strings and would miss MB's nested URL.
3. Extend the MB provider's `inc` params: `getArtist` currently fetches only
   `inc=release-groups`; add `url-rels+genres+aliases+ratings` to feed the
   curated columns.
4. Persist artist-credit + ISRCs to columns (the recording↔artist-credit relation
   + `Recordings.isrcs`) in the write path — needed for both the blob-drop AND to
   capture MB's richer credit data.

None of this BREAKS today (MB-local isn't wired); it's the parity checklist so
the curated columns fill correctly from either source when 3.0 lands.
