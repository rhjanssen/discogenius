# RFC: Provider and Download Backend Abstraction

Last updated: 2026-03-19
Status: Approved direction for phased implementation

## Why This RFC Exists

Discogenius currently hardcodes backend selection around the TIDAL-specific split in `api/src/services/download-routing.ts`:

- music (`album`, `track`, `playlist`) -> Orpheus
- `video` -> tidal-dl-ng

That works for the current production path, but it does not scale to:

- backend switching or fallback
- experimental backends such as `tiddl`
- provider expansion such as Apple Music
- capability-based routing such as "Atmos via backend A, stereo via backend B"

Tidarr gets more leverage from `tiddl` because it wraps downloader behavior more cleanly. Discogenius needs its own stable abstraction instead of adding more CLI-specific branches in core services.

## Goals

1. Separate provider concerns from downloader concerns.
2. Route downloads by capabilities, not by `video` vs `non-video`.
3. Keep current TIDAL behavior representable without regressions.
4. Make `tiddl` and future Apple-related adapters pluggable without reshaping the app again.
5. Preserve Lidarr-style workflow boundaries: queueing, orchestration, scan/import, and organization remain separate from backend adapters.

## Non-Goals

- Replacing Orpheus or tidal-dl-ng immediately.
- Rewriting queue payloads to internal UUIDs in this RFC.
- Implementing Apple Music downloading in this RFC.
- Making CLI stdout/stderr scraping the long-term backend contract.

## Current Problems

### Backend selection is hardcoded

`download-routing.ts` currently decides the backend from media type only. That blocks decisions such as:

- stereo vs Atmos
- backend health/fallback
- provider-specific backend support
- experimental opt-in backends

### Queue payloads are still provider-shaped

Job payloads still assume `tidalId` as the main external identity. That makes provider-neutral routing difficult even when the underlying schema already has `provider_ids`.

### Progress is coupled to CLI parsing

Progress handling is currently backend-adapter specific and line-oriented. That is acceptable as a temporary adapter implementation, but it should not be the public contract between Discogenius core and download backends.

## Proposed Core Concepts

### ProviderRef

All new backend-facing work should identify remote media with a provider-neutral reference:

```ts
export interface ProviderRef {
  provider: string; // "tidal", "apple-music", ...
  mediaType: "artist" | "album" | "track" | "video" | "playlist";
  externalId: string;
}
```

This is additive first. Existing queue payloads can keep `tidalId` until the provider-neutral ID migration RFC lands.

### MediaTraits

Routing decisions need normalized facts about the media, not provider marketing labels:

```ts
export interface MediaTraits {
  mediaType: "track" | "album" | "video" | "playlist";
  audioMode?: "stereo" | "spatial";
  codec?: string | null;
  container?: string | null;
  bitDepth?: number | null;
  sampleRate?: number | null;
  channels?: number | null;
  width?: number | null;
  height?: number | null;
  fps?: number | null;
}
```

`MediaTraits` is the normalized routing input. TIDAL labels such as `DOLBY_ATMOS` or `HI_RES_LOSSLESS` are provider-specific source data, not the app's truth model.

### BackendCapability

Each backend declares what it can do:

```ts
export interface DownloadBackendCapability {
  providers: string[];
  mediaTypes: Array<"track" | "album" | "video" | "playlist">;
  audioModes?: Array<"stereo" | "spatial">;
  supportsHiRes?: boolean;
  supportsVideo?: boolean;
  supportsStructuredProgress: boolean;
  supportsFallbackRetry: boolean;
  priority: number;
}
```

This is the basis for selection and fallback.

## Proposed Interfaces

### AuthProvider

Owns provider login/token lifecycle only.

```ts
export interface AuthProvider {
  id: string;
  getStatus(): Promise<ProviderAuthStatus>;
  startInteractiveLogin?(): Promise<ProviderAuthStartResult>;
  refreshIfNeeded(): Promise<void>;
}
```

### MetadataProvider

Owns provider catalog/library metadata and trait resolution.

```ts
export interface MetadataProvider {
  id: string;
  canResolve(ref: ProviderRef): boolean;
  getMediaTraits(ref: ProviderRef): Promise<MediaTraits>;
  buildBrowseUrl(ref: ProviderRef): string;
}
```

### DownloadBackend

Owns download execution and artifact reporting.

```ts
export interface DownloadBackend {
  id: string;
  getCapability(): DownloadBackendCapability;
  checkHealth(): Promise<BackendHealthStatus>;
  download(request: DownloadRequest): AsyncIterable<DownloadEvent>;
}
```

### PlaybackProvider

Owns shell-level playback attachment for provider-hosted media when needed.

```ts
export interface PlaybackProvider {
  id: string;
  canPlay(ref: ProviderRef): boolean;
  buildPlaybackUrl(ref: ProviderRef): string;
}
```

## Download Request and Event Contract

The backend contract should be structured and Discogenius-owned:

```ts
export interface DownloadRequest {
  ref: ProviderRef;
  traits: MediaTraits;
  workspacePath: string;
  qualityProfile?: string;
  correlationId: string;
}

export type DownloadEvent =
  | { type: "started"; title?: string; artist?: string; cover?: string | null }
  | { type: "progress"; progress: number; currentTrack?: string; speed?: string; eta?: string }
  | { type: "artifact"; path: string; fileType: "track" | "video" | "cover" | "lyrics" | "review" | "bio" }
  | { type: "log"; level: "info" | "warn" | "error"; message: string }
  | { type: "complete" }
  | { type: "error"; message: string; retryable?: boolean };
```

The backend can still shell out to a CLI internally, but Discogenius core should consume structured events, not Rich/ANSI output as a primary API.

## Registry and Routing Model

### Provider Registry

Discogenius should maintain a provider registry:

- auth providers
- metadata providers
- playback providers

Example initial entries:

- `tidal`

Future entries:

- `apple-music`

### Backend Registry

Discogenius should maintain a download backend registry:

- `orpheus`
- `tidal-dl-ng`
- `tiddl` (experimental, off by default)

### Capability-Based Resolver

Core resolution flow:

1. Build a `ProviderRef`.
2. Ask the matching metadata provider for `MediaTraits`.
3. Gather registered backends whose capabilities match:
   - provider
   - media type
   - stereo vs spatial
   - video support
4. Filter out unhealthy backends.
5. Sort by explicit priority plus optional policy overrides.
6. Return a plan with:
   - selected backend
   - ordered fallback candidates
   - reason summary for logs/history/UI

This replaces the current `video ? tidal-dl-ng : orpheus` branching model.

## Current Backend Mapping Under This RFC

### Orpheus

- provider support: `tidal`
- media support: `track`, `album`, `playlist`
- audio modes: `stereo`, `spatial`
- structured progress: not natively; adapter required
- current production role: primary music backend

### tidal-dl-ng

- provider support: `tidal`
- media support: `video`
- structured progress: weak; adapter/parser cleanup required
- current production role: primary video backend

### tiddl

- provider support: `tidal`
- media support: potentially `track`, `album`, `video`
- structured progress: possible with deeper wrapping, not from raw piped CLI output alone
- current production role: none
- future role: experimental stereo backend only until Atmos and artifact reliability are proven

### Apple-related adapters

These should fit the same model:

- Apple auth provider
- Apple metadata provider
- Apple downloader adapter(s)

No Apple implementation should be allowed to reshape core routing assumptions again.

## Migration Plan

### Phase 1: No-Behavior-Change Extraction

1. Introduce the provider/backend interfaces and registry types.
2. Wrap current TIDAL helpers behind provider-facing interfaces.
3. Wrap Orpheus and tidal-dl-ng behind backend adapters.
4. Keep actual routing behavior identical to today.

### Phase 2: Capability Resolver

1. Replace `getDownloadBackendForMediaType()` with a resolver.
2. Feed the resolver normalized `MediaTraits`.
3. Add backend health checks and fallback ordering.

### Phase 3: Structured Progress Boundary

1. Move backend adapters to emit structured progress/log/artifact events.
2. Keep CLI parsing inside the adapter only.
3. Update queue/download processor code to consume backend events rather than backend-specific text parsing paths.

### Phase 4: Experimental Backends

1. Add `tiddl` as an opt-in TIDAL backend.
2. Restrict it to supported capability lanes.
3. Record backend selection reasons in history/activity surfaces.

### Phase 5: Multi-Provider Expansion

1. Land provider-neutral internal IDs and `ProviderRef` usage broadly.
2. Add Apple metadata provider first.
3. Add Apple downloader adapter only after the same contracts are already proven.

## Testing Strategy

### Resolver tests

Use fake backends with explicit capability declarations to validate:

- video chooses the video-capable backend
- spatial audio excludes stereo-only backends
- unhealthy backends are skipped
- fallback order is deterministic

### Adapter tests

Each backend adapter should have tests for:

- request construction
- parsed/structured progress events
- artifact discovery
- terminal failure mapping

### Contract tests

Ensure current production TIDAL flows can be represented through:

- `ProviderRef`
- `MediaTraits`
- `DownloadRequest`
- `DownloadEvent`

without losing existing behavior.

## Comparative Notes

### Lidarr

Lidarr benefits from separating metadata, decision logic, and download clients. Discogenius should mirror that separation even though the provider/downloader stack is different.

### Tidarr

Tidarr gets cleaner leverage from `tiddl` because downloader behavior is wrapped more tightly. Discogenius should adopt the same principle, but with a Discogenius-owned interface so the app is not shaped by one downloader.

## Decision

Discogenius should:

- keep Orpheus and tidal-dl-ng as the current production backends
- stop growing core code around media-type-specific backend branches
- introduce provider/backend interfaces and a capability-based resolver before integrating `tiddl` or Apple support

This RFC is the approval point for that direction.
