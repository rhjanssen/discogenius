<!-- markdownlint-disable MD013 -->
# MB-local mode — catalog provider notes

Status: **scaffolding, not wired into runtime.** This documents the
`CatalogProvider` abstraction and the plan for serving the canonical
catalog directly from a local MusicBrainz-docker instance instead of the
Servarr Metadata Server/Lidarr replica. It is the implementation companion to
`docs/DATA_MODEL_TARGET.md` §3.

No live behavior changed: the app still uses the Servarr Metadata Server flow
(`api/src/services/metadata/servarr-metadata-proxy.ts`) exactly as before. Everything here
is additive and behind interfaces/stubs.

## The abstraction

`api/src/services/catalog/`:

| File | Role |
| --- | --- |
| `catalog-provider.ts` | The `CatalogProvider` interface (symmetric to `StreamingProvider`). DTOs are the existing Servarr Metadata Server/Lidarr shapes (`LidarrArtist`, `LidarrReleaseGroupDetail`, `LidarrRelease`, `LidarrTrack`) — no parallel DTO hierarchy. |
| `servarr-metadata-catalog-provider.ts` | `ServarrMetadataCatalogProvider` — thin adapter over today's `ServarrMetadataProxy`. Documents current behavior as one implementation; changes nothing. |
| `local-musicbrainz-catalog-provider.ts` | `LocalMusicBrainzCatalogProvider` — **stub**, reads the MB-docker `:5000` web-service mirror. Not registered as active. |
| `musicbrainz-ws-mapping.ts` | Pure mappers: MB `/ws/2` JSON → Servarr Metadata Server/Lidarr DTOs. Network-free, fixture-tested. |
| `index.ts` | Barrel + a `catalogProviderRegistry` mirroring `streamingProviderManager`. Active source id = `servarr-metadata`. |

### Methods

`getArtist`, `getArtistReleaseGroups`, `getReleaseGroup`, `getReleaseWithTracks`,
`getRecording?`, `lookupByUPC?`, `lookupByISRC?`, `search`.

The last three are optional because **Servarr Metadata Server can't serve them** (no standalone
recording endpoint, no UPC index, no ISRC index). Per §3, until MB-local is
connected, matching falls back to title / track-count / date / duration /
position and accepts slightly weaker matches. The MB-local provider implements
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

## Backend: `:5000` web-service mirror (ships first)

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

> Direct-Postgres access (`:5432`) against the MB schema is a possible future
> performance optimization for high-volume matching, but it is deferred and not
> implemented yet. The `:5000` mirror is the path that ships first.

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
   `http://musicbrainz:5000/ws/2`. From the host, `http://localhost:5000/ws/2`.

The overlay sets (read by the future wiring unit, ignored today):

- `DISCOGENIUS_CATALOG_SOURCE` — `servarr-metadata` (default) | `musicbrainz-local`
- `MB_LOCAL_WS_URL` — default `http://musicbrainz:5000/ws/2`

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
- `ServarrMetadataCatalogProvider`: delegating-adapter tests with a spy proxy.
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
  needs — and the blocker on dropping the `data` blob. The Servarr proxy only
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

The Servarr write path (`servarr-metadata-proxy.ts`) populates the curated JSON
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
