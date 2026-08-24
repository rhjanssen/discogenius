# Streaming provider adapters

Use this skill when adding or changing a streaming provider (TIDAL, Apple Music, Amazon Music, Spotify, YouTube / YouTube Music, Deezer, SoundCloud, …).

Read `docs/STREAMING_PROVIDER_PLUGIN_CONTRACT.md` first. Core Discogenius (MusicBrainz catalog, libraries, command queue, curation, import) must keep working if one streamer blocks third-party access. Disable or swap a provider by registration/config, not a core rewrite.

## Contract

- Implement `StreamingProvider` (`api/src/services/providers/streaming-provider.ts`; public types from `api/src/providers/types.ts`) plus a `ProviderManifest`. Availability, quality mapping, import sources, download, behind one interface.
- Register in `api/src/providers/registry.ts` (compile-time). Order is the default preference.
- Register a download backend; the adapter calls it. Apple Music is the fullest handshake+backend reference. TIDAL/`tiddl` is the most exercised download path and stays under `api/src/services/providers/tidal/`.

## Hard boundaries

1. **MusicBrainz is identity. Providers are availability + download.** Never seed a parallel catalog table. Provider UPC/ISRC are matching evidence on `ProviderItems`. Typed matches (`ProviderArtistMatches`, `ProviderEditionMatches`, `ProviderTrackMatches`, `ProviderVideoMatches`) are the only provider→canonical link. Never write those onto `Albums` / `AlbumEditions` / `Recordings` / `ArtistMetadata`. There is no `ProviderItemMatches` and no `AlbumReleases`.
2. **Do not keep provider-only catalog features** (similar artists, top tracks, provider discography) unless the catalog can drive them. Drop the section.
3. **Tooling stays in the provider folder.** `tiddl`, Streamrip, yt-dlp, the Apple downloader, and their auth/config live under `api/src/services/providers/<id>/` and `config/providers/<id>/`. Core does not import provider-private modules. Core→provider is registry + shared DTOs + backend-id diagnostics. (Tidal-shaped `health.ts` import is leftover debt.)
4. **Steering = config (global) + args (per-job).** tiddl config is global; per-job path/quality are CLI args.

A provider match never creates `LibraryArtists`. Catalog search hits `ArtistMetadata`. Add-to-library writes membership. Credits are `*ArtistCredits`, not a library row.

Acquisition plans are mono-provider. Provider priority compares complete plans; it never combines TIDAL, Deezer, Apple Music, or another provider inside one plan.

## Quality

- **Atmos vs stereo:** TIDAL Atmos is a separate stream. Spatial-only media never fills stereo. A spatial source may satisfy stereo only through an explicit conversion policy that produces a verified stereo file. No such policy exists today. Organize Atmos into the spatial library root.
- **Hi-Res needs ffmpeg:** TIDAL hi-res is FLAC-in-MP4; tiddl extracts via ffmpeg.
- ISRC/UPC are optional. Present on TIDAL/Apple/Spotify/Deezer, absent on YouTube Music, gated on Amazon.
- Report readiness through provider diagnostics before a download starts.

## Auth

- Prefer transient credential handoff. Apple wrapper login is the pattern: sidecar consumes and deletes; Discogenius does not store the Apple ID/password.
- Token-paste providers (Deezer `arl`, YTM headers, SoundCloud token) store under `config/providers/<id>/`.
- Not-yet-live providers are **Soon** in the manifest (Amazon, Spotify) so the UI blocks credential entry.

## Add a provider

1. Folder `api/src/services/providers/<id>/`: adapter, catalog/search, quality map, auth, download backend.
2. `StreamingProvider` + `ProviderManifest`; wire import sources.
3. Register the backend; expose diagnostics.
4. Register in `registry.ts`.
5. Nothing provider-private leaks into `commands/` or catalog services.
6. Auth page lists it, a real download on Bastille or Bakermat works, `yarn ci` is green, grep shows no new core→private imports.

## References

- Lidarr (`.ref_lidarr`): compiled-in `Indexers/` + `Download/Clients/` behind a factory. Compile-time modules, swappable by registration. Also `.ref_tidarr` for a TS streaming-arr layout.
- Jellyfin (`.ref_jellyfin` → `MediaBrowser.Providers`): identity from external ids (MBID), not a provider-owned catalog.
- Tool refs: `.ref_tiddl`, `.ref_yt-dlp`, `.ref_apple-music-downloader`.
