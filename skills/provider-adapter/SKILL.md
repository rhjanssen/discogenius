# Streaming Provider Adapters

Use this skill when adding a new streaming provider (TIDAL, Apple Music, Amazon,
Spotify, YouTube/YT Music, Deezer, SoundCloud, …) or changing an existing one.

Read `docs/STREAMING_PROVIDER_PLUGIN_CONTRACT.md` first — it is the contract.
The north star (`docs/TASKS.md` → "Provider plugin modularity"): **a streaming
service is a swappable module.** Core Discogenius — MusicBrainz catalog, library,
command queue, curation, import — must keep working if any one provider blocks
third-party access. Disabling or swapping a provider is a registration/config
change, never a core rewrite.

## The contract

- Implement `StreamingProvider` (`api/src/services/providers/streaming-provider.ts`;
  public types re-exported from `api/src/providers/types.ts`). A provider exposes
  catalog **availability**, quality mapping, import sources, and download
  acquisition behind one shared interface — plus a `ProviderManifest`.
- Register it in `api/src/providers/registry.ts` (compile-time). Registration
  order is the factory-default preference.
- Register a download backend in the `downloadBackendRegistry`
  (`api/src/services/download/download-backend.ts`); the provider adapter calls
  into it. **Apple Music** (`apple-music-provider.ts` + `apple-music-backend.ts`)
  is the fullest reference implementation — auth handshake, config sync, backend.

## Hard boundaries (do not cross)

1. **MusicBrainz is canonical identity; providers are availability + download
   only.** Never seed a parallel catalog table from provider data. Provider
   UPC/barcode and ISRC are matching **evidence** → `ProviderItems` /
   `ProviderItemMatches`, never `Albums`/`AlbumReleases`/`Recordings`.
2. **Do not preserve provider-only catalog features** (similar artists, top
   tracks, provider "discography") unless the catalog can drive them. Drop the
   section rather than adding provider catalog tables.
3. **Provider tooling stays inside the provider folder.** CLIs/bridges (tiddl,
   streamrip, yt-dlp, the Apple downloader) and their auth/config live under
   `api/src/services/providers/<id>/` and `config/providers/<id>/`. Core must not
   `import` provider-private modules — core→provider goes through the registry +
   shared DTOs + backend-id-keyed diagnostics. (Replacing the remaining
   tidal-shaped `health.ts` import is tracked boundary debt.)
4. **Steering = config (global) + args (per-job).** e.g. tiddl config is global;
   per-job paths/quality are CLI args. Don't hardcode per-job values into global
   config.

## Quality & format gotchas (carry these forward)

- **Atmos vs stereo:** TIDAL Atmos is a *separate* stream from stereo. An
  Atmos-only release filling the stereo slot is downloaded **as** Atmos m4a and
  organized into `stereo-music`.
- **Hi-Res needs ffmpeg:** TIDAL ships hi-res as FLAC-in-MP4; extraction is via
  ffmpeg.
- **Capability matrix is optional-input:** ISRC/UPC exist on
  TIDAL/Apple/Spotify/Deezer, are absent on YouTube Music, gated on Amazon —
  always treat them as optional, never assumed present.
- Surface readiness through **provider diagnostics** before a download starts;
  don't fail deep in a job for a missing prerequisite you could report up front.

## Auth patterns

- Prefer transient credential handoff over persisting secrets. Example: the Apple
  wrapper login writes credentials to a shared file the sidecar consumes and
  deletes; Discogenius never persists the Apple ID/password.
- Token-paste providers (Deezer `arl`, YTM headers, SoundCloud oauth) store the
  token under `config/providers/<id>/`, synced into the tool's own config.
- Mark not-yet-live providers **Soon** in the manifest so the UI blocks credential
  entry.

## Adding a provider — checklist

1. New folder `api/src/services/providers/<id>/`: adapter (`<id>-provider.ts`),
   catalog/search, quality mapping, auth, and a download backend.
2. Implement `StreamingProvider` + `ProviderManifest`; map quality to the neutral
   model; wire import sources.
3. Register the download backend; report prerequisites via diagnostics.
4. Register the provider in `registry.ts`.
5. Keep all provider-private tooling inside the folder; expose nothing to core
   beyond the contract.
6. Validate: Auth page lists it, download backend registers, a real download on a
   test artist succeeds, and **no new `import` from `commands/`/`music/` into
   provider-private modules** (`yarn ci` + a grep).

## Reference conventions

- **Lidarr** (`.ref_lidarr`): `ThingiProvider` + `Indexers/` + `Download/Clients/`
  are compiled-in providers behind a factory with a thin `Plugins/` surface —
  the model for "compile-time modules, swappable by registration." Also
  `.ref_tidarr` (a TypeScript streaming-arr) for TS-shaped provider layout.
- **Jellyfin** (`.ref_jellyfin` → `MediaBrowser.Providers`): metadata providers
  implement a narrow interface and are orchestrated by a manager; identity comes
  from external ids (MBID/IMVDb), **not** a provider-owned catalog — the same
  canonical-identity-vs-provider split we enforce.
- Tool-boundary refs: `.ref_tiddl`, `.ref_yt-dlp`, `.ref_apple-music-downloader`.
