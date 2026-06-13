<!-- markdownlint-disable MD013 MD024 -->
# Discogenius Release Plan — 2.0.2 and 2.1.0

_Last updated: 2026-06-12 · Owner doc for forward release planning. Current-state architecture lives in [ARCHITECTURE.md](ARCHITECTURE.md); curation internals in [CURATION_DEDUPLICATION.md](CURATION_DEDUPLICATION.md)._

This plan is **evidence-based**. Every claim below was checked against the live
TIDAL API, the tiddl source, the Lidarr/Skyhook metadata API, the raw
MusicBrainz API, and the running app — not assumed. Where a previously-proposed
fix was found to be wrong, that is called out so we don't repeat it.

## How releases are scoped here

- **2.0.x** — bug fixes, correctness, and UI polish. No schema migrations that
  change the core data model, no new providers, no new heavy dependencies.
- **2.1.0** — additive features behind the existing `StreamingProvider`
  interface and optional metadata backends. New dependencies allowed.
- **2.2 / 3.0** — architectural pivots (custom libraries / quality profiles).

---

## Verified findings (the basis for 2.0.2)

These were reproduced directly during 2.0.1 testing. IDs/numbers are real.

### F1 — The read-service track matcher is stale and disagrees with curation _(real bug)_

`musicbrainz-release-group-read-service.ts → scoreProviderTrackMatch()` (drives
the **album-page UI**) still uses a hard `0.72` string-similarity cutoff with
**no** fallback. The 2.0.1 slot-service matcher
(`release-group-slot-service.ts → scoreTrackMatch()`) was given a base-title +
position/duration fallback but the read service was never updated. Result: the
backend counts an album as fully covered (→ "matched" badge) while the UI scores
the same tracks as **missing**. This is the root cause of:

- **Bad Blood X** (`bf37b1a0…`): "confirmed match" badge but missing tracks.
- **VS. (Other People's Heartache, Pt. III)**: 8/9 tracks shown missing because
  TIDAL titles them `… (Bastille Vs. …)`, which fails string similarity.

Two divergent implementations of the same logic is the defect. **Fix: unify.**

### F2 — Title-expansion confidence is capped for "… EP" / "… X" editions _(real bug)_

`provider-release-group-matcher.ts`: `titleExpansionMatched` requires
`bestTitle.titleScore === 1`, which is impossible when the provider title is an
**expansion** of the MB title ("Goosebumps EP" vs "Goosebumps" scores 0.9). So a
fully-track-covered EP is stuck at **"probable"** instead of "verified".

### F3 — Skyhook strips ISRC and barcode/UPC _(confirmed; constrains the fix)_

Verified by direct API diff:

| Source | Barcode/UPC | Track ISRC |
| --- | --- | --- |
| Raw MusicBrainz `ws/2` | **present** (e.g. `00602537894758`) | present |
| Lidarr Skyhook `api.lidarr.audio/v0.4` | **absent** (no field) | **absent** (no field) |

Skyhook **does** return `RecordingId` (MB recording MBID), `TrackNumber`,
`MediumNumber`, and `DurationMs` per track. So an exact ISRC/UPC match is
impossible with the default backend, but a **recording-MBID + position +
duration** match is fully available. This is why the Lidarr-style structural
fallback is the right default, and why a "local MusicBrainz" mode (2.1.0) is
the path to exact-identifier matching.

### F4 — Spatial-only albums cannot supply a stereo download _(corrects a wrong fix)_

**A previously-proposed fix — "let a Dolby Atmos album ID also fill the stereo
slot" — does not work and must not be shipped.** Verified empirically with
tiddl against Bakermat's "Grace Note" (TIDAL album `396126620`):

```
tiddl download -q max  --dolby-atmos none url .../album/396126620  → Total downloads: 0
tiddl download -q high --dolby-atmos none url .../album/396126620  → Total downloads: 0
```

Every track is skipped "due to Dolby Atmos filter none" because those track IDs
return `audioMode = DOLBY_ATMOS` at the stream level. tiddl's downloader
(`download/downloader.py`) explicitly skips Atmos streams when `atmos_filter ==
"none"`. A direct TIDAL album search confirms there is **no separate stereo
"Grace Note" album** — only the Atmos one (tagged `LOSSLESS, DOLBY_ATMOS`), plus
"Grace Note (Continued/Extended/Remixed)". TIDAL's web player downmixes to
stereo client-side; that path is not exposed to download tooling.

➡️ Correct behavior: **detect spatial-only availability and surface it**
("Only Dolby Atmos available on TIDAL"), rather than pretending a stereo slot
exists. Putting the Atmos ID in the stereo slot would create a perpetually-empty
"download" that never produces a file.

### F5 — The unified matcher must adapt field shapes per caller _(implementation hazard)_

Production builds slot-candidate tracks as snake_case
(`refresh-artist-service.ts:428` → `track_number: track.trackNumber`), while the
read service consumes camelCase `ProviderTrack` (`trackNumber`). A WIP that
renamed the slot `ProviderTrackDetail` type to camelCase and only updated the
**tests** would silently break slot-service position matching in production
while tests pass (the exact camel/snake trap from the `MEMORY` notes). The
shared matcher must take a **normalized** shape and each call site maps its own
fields in.

### F6 — UI badge spacing/alignment is inconsistent _(real polish bug)_

`AlbumPage.tsx`:

- `metadataBadges` uses `columnGap: spacingHorizontalXXS` (**2px**) while the
  parent `metadata` row uses `spacingHorizontalS` (**8px**) — inconsistent and
  too tight.
- `alignItems: flex-start` with mixed badge heights (text badge 20px vs the
  Atmos badge 27px) → vertical misalignment.
- Fluent v9 `Badge` has no built-in max-width and the default `flex-shrink`
  lets it compress in tight rows, so long labels overflow the pill (Robert's
  "text sticks outside the badge"). Fluent guidance: badges need explicit
  width/overflow handling and should be `flex-shrink: 0`.

### F7 — Single-track embedded `trackNumber: 1` causes an organizer collision _(real bug, from Gemini)_

When a track was also released as a standalone single, TIDAL embeds
`trackNumber: 1` in the track payload. `organizer.ts` could trust that over the
album position and map e.g. track 13 onto position 1, colliding with the real
track 1. The fix (also require a title match before overriding position) is
sound; it just needs a clean, tested implementation rather than a one-liner.

---

## 2.0.2 — correctness & polish

### 2.0.2-A · Unify track matching (F1, F2, F5)

- Add a single `provider-track-matcher.ts` exporting `scoreTrackMatch(target,
  providerTrack)` over a **normalized** track shape
  (`{ recordingMbid, isrcs, title, trackNumber, volumeNumber, durationSec }`).
  Scoring order:
  1. recording-MBID or ISRC exact → `1.0`.
  2. position + volume aligned **and** duration within ~8s → `0.92` (Lidarr's
     window is 10s for messy local files; provider metadata is exact so 8s is
     safe and avoids matching genuinely different same-position tracks). Keep a
     base-title sanity check so two unrelated tracks at the same index with
     coincidentally-close durations don't false-match on a **combined** release.
  3. else string similarity (with the existing base-title-suffix tolerance) as
     the final fallback.
- Replace the duplicated scorers in **both** the slot service and the read
  service with adapters that normalize their own field shapes into this util.
- Tests: VS.-style suffix tracks, Bad Blood X 33/33, and explicitly a
  **single + album combine** case to prove no false coverage (guards F5/2.b).
- Reference: Lidarr `DistanceCalculator.cs` (already mirrored in
  `identification-service.ts` for local-file import) uses position + 10s
  duration + title distance; we already match that for imports, so unifying the
  provider matcher to the same shape is consistent, not novel.

### 2.0.2-B · Verified status for full-coverage expansions (F2)

- In `provider-release-group-matcher.ts`, treat a provider title that **starts
  with** the MB base title (expansion) with a high title score as
  `titleExpansionMatched`, and grant **verified** when `trackCountMatched &&
  titleExpansionMatched` (gated on track-count so it can't over-promote a wrong
  album). Add a "Goosebumps EP" regression test.

### 2.0.2-C · Spatial-only availability, done correctly (F4)

- Do **not** route Atmos IDs into the stereo slot.
- When a release group has a spatial offer but no stereo-capable offer, mark the
  stereo slot `unavailable` with reason `spatial_only` and surface it in the UI
  ("Dolby Atmos only on TIDAL"). The album should read as *correctly* spatial-
  only, not as a broken/missing stereo match.
- (Investigate, possibly defer to 2.1) an **opt-in** ffmpeg Atmos→stereo
  downmix to populate a stereo file when no native stereo exists — off by
  default, clearly labeled as derived (audiophiles will not want a downmix in a
  "lossless stereo" library).

### 2.0.2-D · Remix-monitored-but-original-not (`90c3f3ac…`)

- Reproduce on real data (could not reproduce locally — my DB lacked the
  offers). Hypothesis: the standalone-single provider release for the original
  recording is either not ingested by `getArtistAlbums`, or is being filtered
  by a redundancy/representative-release rule that keeps the remix RG but drops
  the single RG. Trace `selectReleaseGroupSlotAlbums` + the curation redundancy
  filter for this RG and fix the asymmetry. **Needs Robert's test-deployment DB
  or a fresh Bakermat/relevant-artist scan to confirm.**

### 2.0.2-E · Organizer single-track collision (F7)

- Rewrite the embedded-`trackNumber` override so it only applies when the
  candidate's title also matches; add a regression test using the "Grace Note /
  Divine Stuff" shape.

### 2.0.2-F · Badge & "can you see what's going on" UI pass (F6)

Concrete fixes:

- `metadataBadges`: `columnGap`/`rowGap` → `spacingHorizontalS`/`spacingVerticalXS`
  (match the row); `alignItems: center`.
- `QualityBadge`: give all variants a consistent height and `flexShrink: 0`;
  stop clipping (let the pill size to content with min-height, not fixed
  height); align the Atmos pill height to the text pills.
- General sweep for squished/clipped chips across album, artist, track, and
  queue rows.

**Proposed redesign — "provider availability chip" (needs Robert's visual
sign-off before building):** replace the loose quality badges **and** the
separate "matched" tooltip badge with one composite chip per slot:

```
┌───────────────────────────────────────┐
│  [TIDAL]  24-BIT · ATMOS      ✓ matched │   ← border/tint encodes match status
└───────────────────────────────────────┘
        ▲ provider icon   ▲ quality sub-badges   ▲ status (tooltip = details)
```

- Provider icon anchors the chip; quality sub-badges (16-BIT / 24-BIT / ATMOS)
  sit inside; match status is conveyed by the chip's treatment (verified =
  solid/checkmark, probable = subtle, ambiguous = warning) with the existing
  tooltip detail (provider release + selected MB edition).
- This makes "what do we have, in what quality, how confident" legible at a
  glance and removes the standalone match badge Robert flagged as redundant.
- Build a static mockup first (Storybook-style or a screenshot) and confirm the
  direction with Robert; he said "need to see it to know if it's a good idea."

### 2.0.2-G · Provider plugin file & token consolidation (Robert's questions)

Current layout:

```
config/.tiddl/{auth.json, config.toml, api_cache.sqlite, latest.log}   ← tiddl's dir
config/providers/tidal/token.json                                       ← our richer token
```

- **Co-locate** all TIDAL plugin files under `config/providers/tidal/` — point
  `TIDDL_PATH` at `config/providers/tidal/.tiddl` (one constant in `tiddl.ts` +
  the Docker `ENV`, plus a one-time migration that moves an existing
  `config/.tiddl`). Keeps the provider folder self-contained and ready for the
  Apple Music plugin to sit beside it.
- **Two token files → one source of truth.** `token.json` is our device-login
  output (rich: user, expiry, refresh); `auth.json` is the tiddl-shaped sync
  target. They can't be byte-identical (different schemas), but we should pick a
  **single refresher** to avoid our app and `tiddl auth refresh` fighting over
  the token. Recommended end state: our app owns refresh and writes both the
  canonical `token.json` and the derived `auth.json`; document `auth.json` as a
  generated artifact. (Eliminating `token.json` entirely and reading the
  `[account]` cache + `auth.json` is possible but loses the clean device-login
  contract — investigate, but the "single refresher + co-located + documented
  derived file" option is the low-risk win for 2.0.2.)

### 2.0.2-H · Album artwork source unification

Robert saw an album show **provider art on the artist card** but **canonical
(MusicBrainz/CAA) art on the album page** — "why isn't this a unified method?"

What's actually going on (verified):

- The resolution logic is already shared: both the sync `chooseCachedAlbumArtwork`
  (artist list) and the async `resolveAlbumArtwork` (album page) try
  Albums.images canonical → skyhook `data.images` → provider fallback, in the
  same order.
- The divergence was an **input** gap, not a logic gap: the artist-list call
  sites omitted `albumMbid`, so they skipped the Albums.images canonical lookup
  and fell straight to provider art whenever the cached `data` blob lacked a CAA
  image. Album pages persist canonical art into Albums.images when viewed, so the
  two paths disagreed for any release group that had been viewed (cached) but
  whose `data` blob had no image. **Fixed in 2.0.2** by passing `albumMbid` at
  both sites — the read paths now agree for any RG whose canonical art is cached.
- Residual gap (deferred): release groups that have **never been individually
  synced** carry no canonical art in any store (only ~6/94 Bastille RGs were
  cached), so they still show provider art until first viewed. Closing this
  needs a refresh-time backfill that resolves Cover Art Archive front covers for
  every RG and persists them to Albums.images. That means rate-limited CAA/skyhook
  lookups (≈1 req/s) fanned across an artist's full discography, so it belongs in
  its own change with proper throttling + a background job — **tracked for 2.0.3**,
  not bolted onto a refresh synchronously.

### 2.0.2 acceptance

- Bad Blood X and VS. show all tracks matched in the UI (no false "missing").
- Goosebumps EP reads "verified".
- Grace Note reads "Dolby Atmos only" (not a broken stereo slot); no empty
  stereo download is ever queued for it.
- Badges are aligned, consistently spaced, never clip their text.
- Provider + quality read as one chip per slot (provider mark fused with its
  quality badge); match confidence/edition live in the hover tooltip.
- Artist cards and album pages show the same canonical-first cover for any
  cached release group.
- `yarn ci` green; container re-verified.

---

## 2.1.0 — providers, exact matching, video metadata

### 2.1.0-A · Apple Music provider plugin

- Implement `AppleMusicProvider implements StreamingProvider`, mirroring the
  TIDAL plugin's structure (provider + backend + auth modules under
  `config/providers/apple-music/`).
- **Auth like the TIDAL plugin**: no paid Apple Developer account. The
  open-source downloaders (`glomatico/gamdl`, `bascurtiz/orpheusdl-applemusic`)
  authenticate with a logged-in web session's `media-user-token` cookie (plus a
  developer token scraped from the web player). We extract/accept that token the
  same way we ride tiddl's auth for TIDAL, then call
  `api.music.apple.com/v1/catalog/{storefront}` ourselves.
- **Downloads** via a gamdl-style CLI backend (Widevine/decrypt handled by the
  tool), analogous to `TiddlBackend`.
- **Matching is easier here**: Apple Music's API supports `filter[upc]` and
  `filter[isrc]` natively, so when we have those identifiers (local-MB mode
  below) we get exact snaps; otherwise fall back to the same unified
  position+duration matcher from 2.0.2.
- Provider/quality note: Apple delivers ALAC lossless and Atmos; confirm format
  handling in the chosen downloader during implementation.

### 2.1.0-B · Local MusicBrainz / exact-identifier mode (optional)

- Skyhook strips ISRC/UPC (F3). To get exact matching, let advanced users point
  the app at a **local MusicBrainz mirror** or the **raw MB API**:
  - Settings: metadata source = `skyhook` (default) | `musicbrainz-api` |
    `musicbrainz-local <url>`.
  - New `musicbrainz-proxy.ts` adapter that transforms raw MB `ws/2` payloads
    into our existing schema, **populating `AlbumReleases.barcode` and
    `Recordings.isrcs`** (the columns already exist and are unused with Skyhook).
  - **Dual-mode matcher**: when ISRC/UPC are present, snap exactly; otherwise
    use the 2.0.2 structural fallback. No matcher rewrite needed — just richer
    inputs.
- Feasibility notes from research: a full `metabrainz/musicbrainz-docker`
  mirror is **~350 GB** with indexed search (or ~100 GB without), 16 threads /
  16 GB RAM — clearly a power-user/NAS feature, **opt-in, never bundled**. A
  lighter middle path is the **direct MB API** at 1 req/s with our existing
  queue + cache; acceptable for personal libraries refreshed occasionally.
  Offer both; default stays Skyhook.

### 2.1.0-C · Music-video metadata via IMVDb

- The 2.0.1 title-keyword classifier (`-video/-lyrics/-live/…`) works for
  clearly-labeled titles but fails when a lyric/live video is titled plainly
  (e.g. "Pompeii"). The Internet Music Video Database (IMVDb) has a real API
  (versions, official-vs-alt, directors, behind-the-scenes; 1000 calls/min, free
  key for non-commercial; licensing forbids rebuilding a competing DB, so use it
  for typing/enrichment only — mirrors the Plex/Kodi `metadata.musicvideos.imvdb`
  agents).
- Use IMVDb to: classify the true video type/version (drives the Plex suffix
  accurately), pick the canonical "official" version, and improve per-song
  dedup. This supersedes the heuristic, not replaces the dedup pipeline.
- Robert's call: if the heuristic proves "good enough" in his testing this can
  slip to a later point release; default plan keeps it in 2.1.0 because it needs
  a new API key + integration.

### 2.1.0-D · Universal "Add provider" flow + retire legacy tables

- Make the Settings provider section enumerate provider **types** (configurable
  vs configured instances) with a real per-provider add/connect/remove flow
  (groundwork already shipped in 2.0.1's empty-state).
- Retire the legacy `ProviderMedia`/`ProviderAlbums` compatibility tables and
  the lyric-service reads that still depend on them, now that canonical
  `Recordings`/`ProviderItems` carry everything.

---

## 2.2 / 3.0 backlog — custom libraries & quality profiles

Robert's "add a library, choose type (lossy/lossless/surround/video) + quality
+ path, allow shared paths, allow later relocation" idea. Combines Lidarr's
quality-profiles + root-folders with our multi-version slot model. Feasible but
a major refactor: replace the hardcoded `stereo|spatial|video` slots with a
`CustomLibraries` table and dynamic partitioning in
`release-group-slot-service.ts` + path resolution in `audio-library-path.ts`.
Confirmed during research that TIDAL Atmos is delivered as **E-AC-3 (JOC) in
MP4** (our own Atmos downloads come out `eac3`), not AC-4 — so a surround-type
"format" sub-choice is mostly cosmetic for TIDAL today. Park as 2.2/3.0.

---

## Decisions that need Robert

1. **Provider availability chip redesign (2.0.2-F)** — approve the composite
   chip direction (provider icon + quality sub-badges + status) before we build
   it, or keep separate badges and just fix spacing/alignment?
2. **Atmos→stereo downmix (2.0.2-C)** — want an opt-in derived-stereo feature,
   or is "Dolby Atmos only" labeling enough?
3. **Token consolidation (2.0.2-G)** — OK to make our app the single refresher
   and document `auth.json` as a generated file, keeping `token.json` canonical?
4. **Reproduction data (2.0.2-D)** — the remix-vs-original asymmetry needs your
   test-deployment DB (or which artist to re-scan) since it didn't reproduce on
   my local data.
