# Streaming Provider Plugin Contract

Discogenius core must not change schema or workflow logic for each streaming
service. Providers expose catalog availability, quality mapping, import sources,
and download acquisition through one shared contract; MusicBrainz remains the
canonical catalog identity.

External provider tooling follows `docs/EXTERNAL_DEPENDENCIES.md`: small
direct-spawn binaries may be bundled as pinned artifacts, while sidecars stay
optional and stateful catalog stacks stay external. Per-provider download-backend
choices are recorded in `docs/PROVIDER_DOWNLOADER_DECISION.md`.

## Core-Owned Language

Every provider adapter must expose:

- A stable provider id, display name, config root, auth shape, integration mode,
  and diagnostics in `ProviderManifest`.
- Provider-neutral resources: artist, album, track, video, playlist/list.
- Stable provider resource ids for `ProviderItems.provider_id`.
- Album tracklists with provider track ids whenever the provider can fetch them.
  Imports depend on staged files named by provider item id.
- A neutral quality mapping:
  - stereo audio: `lossy`, `lossless`, `hires-lossless`
  - spatial audio: `atmos`, `spatial-360`
  - video: currently `sd`, `hd`, `fhd`
- Import sources from the shared source categories:
  `library-artists`, `followed-artists`, `favorite-tracks`, `playlist`, `mix`.
- One or more download backends registered through `DownloadBackendRegistry`.

Provider-specific tokens, cookie formats, storefronts, wrapper processes,
download command flags, and raw API vocabularies stay inside the provider
adapter/backend. Core curation, queueing, import, and database code should only
see the shared DTOs above.

## ProviderItems Contract

`ProviderItems` is the provider offer/evidence cache, not a provider catalog
shadow. Provider rows may store provider ids, availability, quality, URL/artwork
supplements, UPC/ISRC matching evidence, selected-offer snapshots, and canonical
MBID links once matched. They must not create canonical artists, releases,
tracks, or recordings by themselves.

Track materialization is the critical acquisition contract:

1. Match a provider album offer to a MusicBrainz release.
2. Fetch the provider album tracklist when needed.
3. Persist provider track rows keyed by provider track id and mapped to MB track
   by selected-release medium/position.
4. Download backend stages files with provider ids in filenames/directories.
5. Import resolves staged provider ids through `ProviderItems`, not title
   guessing.

## Current Provider Shapes

| Provider | Catalog/API source | Downloader candidate | Quality shape | Import-source shape |
| --- | --- | --- | --- | --- |
| TIDAL | TIDAL web/API adapter; official developer docs exist but the working runtime uses the current token-backed API adapter | `tiddl` native CLI | lossless/hi-res stereo, Dolby Atmos, music videos | followed artists, playlists, favorite tracks, mixes |
| Apple Music | Apple Music web/API adapter using the required `media-user-token`; Discogenius auto-resolves the public MusicKit bearer token like the downloader unless an override is configured | `zhaarey/apple-music-downloader` native Go CLI, gated by external decryption wrapper | AAC/lossless/hi-res ALAC, Dolby Atmos, music videos | library artists and playlists first |
| Deezer | Deezer public catalog API + ARL session for Streamrip | Streamrip | MP3/FLAC | followed artists, playlists, favorite tracks |
| SoundCloud | Unofficial `api-v2` client with browser `oauth_token` + public `client_id` (experimental; official OAuth 2.1 deferred) | Native progressive MP3 when entitlement allows; `yt-dlp` fallback with OAuth header/cookies | lossy only | favorite tracks, playlists |
| YouTube Music | Unofficial YouTube Music web API via `ytmusicapi`-style clients | `yubal` as a self-hosted downloader/reference, ultimately wrapping `yt-dlp` | lossy audio (`opus`/mp3/m4a), potentially stronger video resolution than audio fidelity | library/subscriptions/playlists/liked music, depending on cookies/auth |

## Research Notes

- Apple Music API/web endpoints are the correct catalog/personalization source.
  Apple documents catalog search for songs, albums, artists, playlists, music
  videos, stations, ratings, charts, recommendations, and user-authorized
  library/personalized features. The downloader auto-resolves the public web
  bearer token from music.apple.com; Discogenius mirrors that and only requires
  the user's `media-user-token`, with an optional bearer/developer-token
  override for advanced setups.
- `zhaarey/apple-music-downloader` is the practical Apple downloader candidate.
  It supports ALAC, Atmos/EC3, AAC variants, and music-video downloads, but
  requires MP4Box and a separate decryption wrapper. Its runtime reads
  `config.yaml` from the working directory and uses configured save folders and
  templates, so Discogenius writes job-specific config instead of passing
  nonexistent generic output flags. The Docker image packages the upstream
  static `apple-music-dl` CLI; diagnostics still treat MP4Box and the wrapper
  ports as separate live-download readiness checks. Compose includes the
  `apple-music-wrapper` service in the same file (commented so operators can
  delete it if unused), sharing Discogenius' network namespace so the
  downloader's `127.0.0.1:10020/20020` config resolves to the wrapper.
- YouTube Music has no official Apple/TIDAL-like catalog API for this use case.
  `ytmusicapi` is the best-known catalog automation layer and emulates the web
  client with cookie/OAuth data. `yubal` is a useful reference because it combines
  YouTube Music URLs, `yt-dlp`, real-time job progress, scheduled sync, lyrics,
  and organized outputs. For Discogenius, YouTube Music should validate the
  contract's lossy-audio/video axis rather than drive new schema.

## 2.6 modularity target (planning)

Honest status: we have a **shared adapter contract** and per-provider folders,
not installable plugins. Registration is compile-time.

**Phase 1 (landed):** public surface at `api/src/providers/` — `streamingProviderManager`
registry + shared types. Concrete adapters remain under
`api/src/services/providers/<id>/`; `services/providers/index.ts` re-exports the
public barrel for compatibility. Some core modules still import provider-private
helpers (notably TIDAL/`tiddl` health).

Goal for 2.6 (see `docs/TASKS.md` and `docs/STRUCTURE_AUDIT_2.6.md`): make each
streaming service a separable module — logic **and** file tree — so core
catalog/library/queue work without a given streamer. Prefer incremental moves
toward `api/src/providers/<id>/` (or `plugins/<id>/`) with a single public entry
(manifest + `StreamingProvider` + download-backend registration + diagnostics).
Core may depend on the registry and shared DTOs only. Dynamic package loading
is optional later; clear boundaries and zero core→private imports are the
high-value bar.

Lidarr parallel: `ThingiProvider` + per-implementation folders under
`Indexers/` and `Download/Clients/` (still compiled in). Their `Plugins/`
surface is a thinner install/version story — useful inspiration, not a
requirement to copy .NET plugin hosts into Node for 2.6.

References:

- https://developer.apple.com/documentation/applemusicapi/
- https://developer.apple.com/musickit/
- https://developer.apple.com/documentation/applemusicapi/generating-developer-tokens
- https://github.com/zhaarey/apple-music-downloader
- https://github.com/sigma67/ytmusicapi
- https://github.com/guillevc/yubal
- https://developer.tidal.com/documentation/api-sdk/api-sdk-overview
- https://tidal-music.github.io/tidal-api-reference/
