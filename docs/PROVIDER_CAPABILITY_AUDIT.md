# Streaming provider capability audit (metadata/catalog APIs)

Scope: the **catalog/metadata** APIs only (the seven Robert linked). Downloading
tools (tiddl, etc.) are deliberately out of scope here. Goal: keep Discogenius
**provider-neutral** so *any* one of these could be the sole provider, and
identify where we are currently TIDAL-centric.

> Confidence: capabilities below reflect the established public API models. Exact
> field names should be re-verified against each provider's live reference when
> its adapter is implemented — the doc SPAs don't extract cleanly and the shapes
> drift. Treat this as the design matrix, not a copy of the current schema.

## What our matcher/curation actually needs (from the atoms in the design doc)

| Need | Used for |
|---|---|
| Artist → full discography (albums/singles/EPs/comps) | build the discography set |
| Album → ordered tracklist | coverage / composite assembly |
| Track **ISRC** | recording identity (exact match) |
| Album **UPC/barcode** | release identity (exact match) |
| Track duration, position | fuzzy fallback when no ISRC |
| **Explicit** flag | explicit vs clean filtering |
| Release **type** (album/single/EP/compilation/live/…) | canonicalness + type filters |
| Release date | canonicalness (first appearance) |
| Quality tiers (lossy/lossless/hi-res/spatial) | quality profile selection |
| Music videos | video slot |
| Artwork URL | covers/pictures |

## Capability matrix

| | Discography | Tracklist | ISRC | UPC | Explicit | Rel. type | Rel. date | Videos | Spatial | Auth / gating |
|---|---|---|---|---|---|---|---|---|---|---|
| **TIDAL** (OpenAPI v2) | ✅ | ✅ | ✅ | ✅ (barcodeId) | ✅ | ✅ | ✅ | ✅ (Atmos) | OAuth2; app approval |
| **Apple Music** (MusicKit / Apple Music API) | ✅ | ✅ | ✅ | ✅ | ✅ (contentRating) | ✅ (isSingle/isCompilation) | ✅ | ✅ (videos catalog) | ✅ (Atmos) | JWT dev token + user token |
| **Spotify** (Web API) | ✅ (`/artists/{id}/albums` incl. groups) | ✅ | ✅ (`external_ids.isrc`) | ✅ (album `external_ids.upc`) | ✅ (`explicit`) | ✅ (`album_type`) | ✅ (`release_date`) | ❌ | ❌ | OAuth2 client-credentials for catalog; rolling rate limit |
| **Deezer** (public API) | ✅ | ✅ | ✅ (`isrc`) | ✅ (`upc`) | ✅ (`explicit_lyrics`) | ✅ (`record_type`) | ✅ | ❌ | ❌ | mostly keyless catalog, but access **being restricted/deprecated** |
| **Amazon Music** | ⚠️ limited | ⚠️ | ⚠️ unlikely public | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ❌ | ✅ (Atmos, playback-side) | Gated dev program, Alexa/playback-oriented — **not a general catalog API** |
| **YouTube Music** (ytmusicapi, unofficial) | ✅ | ✅ | ❌ | ❌ | ✅ (isExplicit) | ~ (album/single/EP) | ~ (year) | ✅ (is video-native) | ❌ | none/unofficial; scraping — ToS + fragility risk |
| **YouTube Data API v3** | ~ (channel uploads/search) | n/a | ❌ | ❌ | ❌ | ❌ | ~ (publishedAt) | ✅ (it *is* video) | ❌ | API key/OAuth; strict quota |

Legend: ✅ yes · ⚠️ gated/uncertain · ❌ no · ~ partial/approximate.

## The one structural conclusion

Providers split cleanly into two classes, and **our matcher must support both
first-class** (the design doc already assumes this):

1. **Identity-grade** (TIDAL, Apple, Spotify, Deezer): expose **ISRC + UPC** →
   exact recording/release matching. These can each be the sole provider with
   full curation accuracy.
2. **Fuzzy-only** (YouTube Music, YouTube Data; Amazon in practice): **no
   ISRC/UPC** → matching degrades to title + duration + version. Same fallback we
   already need for Servarr mode. Curation still works but with lower confidence;
   dedup leans on titles.

So "no ISRC" is not a blocker — it's the fuzzy path the recording-centric design
already requires. But it means **ISRC/UPC must be optional inputs, never assumed
present**, everywhere in the pipeline.

## Where we are TIDAL-centric today (things to neutralize)

- **Artwork URLs are TIDAL-shaped.** `resources.tidal.com/images/{uuid}/…` is
  built in a few places (e.g. the queue-cover helper I added, tidal-auth). Each
  provider has its own image URL scheme (Apple `artwork.url` template with
  `{w}x{h}`, Spotify `images[]`, Deezer `cover_*`). → the provider adapter should
  return a **ready artwork URL (or a size-templating function)**; nothing outside
  the adapter should know a provider's image host.
- **Quality strings are TIDAL enums.** `LOSSLESS`, `HI_RES_LOSSLESS`,
  `MP4_1080P`, `DOLBY_ATMOS` leak into services. → normalize to the neutral
  quality/format model the capability descriptor already hints at
  (`losslessStereo`/`hiResStereo`/`spatialAudio` + a canonical tier enum), and let
  each adapter map its native strings in.
- **ISRC/UPC assumed on the offer.** Matching should treat them as optional and
  fall through to the fuzzy scorer when absent (fine after the design-doc refactor).
- **Videos assumed available.** Guard every video path behind
  `capabilities.musicVideos`; Spotify/Deezer/Amazon have none.
- **`version` as a separate field.** TIDAL exposes track `version`; others bake it
  into the title. Normalize at ingest (design doc §5) so downstream sees one shape.
- **Spatial = Atmos.** TIDAL/Apple have Atmos; encode spatial as a capability +
  format list (already partly done via `spatialFormats`), not a hardcoded slot.

## Adapter contract (what each provider must map into)

The existing `StreamingProvider` interface + `capabilities` descriptor is already
a good neutral base. To be fully provider-agnostic, each adapter should return the
neutral shapes and set capability flags honestly:

- `ProviderTrack`: `{ id, title, version?, isrc?, durationSec, trackNumber,
  volumeNumber, explicit?, artistNames[] }` — ISRC/version optional.
- `ProviderAlbum`: `{ id, title, upc?, type (album|single|ep|compilation|live|…),
  releaseDate?, trackCount, volumeCount, artworkUrl(size), qualityTiers[] }`.
- `getArtistDiscography(id) → ProviderAlbum[]` covering all release types the
  provider can enumerate; `getAlbumTracks(id) → ProviderTrack[]`.
- `capabilities`: `providerIds` (⇒ ISRC/UPC present), `musicVideos`,
  `spatialAudio`, `hiResStereo`, `losslessStereo`, `artwork`, `catalogSearch`,
  `artistCatalog`.

Matching/curation reads **only** the neutral shapes + capability flags — no
provider name checks.

## Practical recommendations

1. **Reference adapters:** TIDAL (have) as identity-grade #1; add **Spotify** next
   as the cleanest public identity-grade API to prove neutrality (OAuth
   client-credentials, ISRC/UPC/type/explicit all present). Apple Music is the
   richest but heaviest auth (JWT + user token).
2. **Treat YouTube Music as the fuzzy-path reference** to force the no-ISRC path
   to be first-class, not an afterthought — mirrors Servarr mode.
3. **Deprioritize Amazon** until a real catalog entitlement is confirmed; its
   program is playback/Alexa-shaped, not a discography API.
4. Do a **live per-adapter field verification** at implementation time (the SPA
   docs don't extract; shapes drift). This audit is the design matrix.
5. Keep **downloading concerns entirely separate** (per Robert) — a provider can
   be metadata-only (match/curate) even if we can't yet download from it; the
   `audioDownloads`/`videoDownloads` capability flags already model that split.
