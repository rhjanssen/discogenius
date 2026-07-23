# Semi-official YouTube sources (VEVO / MTV) — feasibility (2026-07-23)

**Verdict: DEFER WITH GUARDRAILS.** Do not harvest MTV / network
channels (or similar) as automatic artist video sources. Keep today’s
paths: YouTube Music artist catalog + MusicBrainz free-streaming URLs +
existing metadata matching. Optional later: channel *preference* scoring
only, never unsupervised third-party channel crawl.

## User examples (Bastille MTV Unplugged)

| URL | oEmbed title | Channel |
| --- | --- | --- |
| `sGbSMpTEWbc` | Bastille Performs 'Pompeii' \| MTV Unplugged | MTV |
| `OvGUehbl5rw` | Bastille - Happier (MTV Unplugged) \| MTV Music | MTV UK |
| `57JtVpEYDX4` | Bastille - Blame (MTV Unplugged) \| MTV Music | MTV UK |
| `Qm89H8w-ydY` | Bastille - No Bad Days (MTV Unplugged) \| MTV Music | MTV UK |

These are **branded live performances**, not studio OMVs. MusicBrainz already
has Bastille *MTV Unplugged – Live in London* (live Album) plus Unplugged
singles. Discogenius already classifies `mtv unplugged` as `live`
(`video-variant.ts`).

## What Discogenius already does

- **YouTube is a core video catalog** (`isCoreVideoCatalogProvider`): artist
  refresh pulls YTM `getArtistVideos`, filtered to OMV /
  `OFFICIAL_SOURCE_MUSIC` (drops ATV / UGC).
- **ATV→OMV counterparts** pin album-scoped video offers to audio recordings.
- **MusicBrainz free-streaming / streaming URL relations** become
  `youtube-music` `ProviderItems` pinned to the owning video recording
  (`musicbrainz-recording-url`) — **channel-agnostic** and the safest way an
  MTV/VEVO watch URL enters the catalog.
- **Identity matching** is metadata-only (`video-match.ts`): cleaned title +
  duration (±2s soft / ±3s hard) + date + ISRC; `video_variant` blocks
  live↔studio merges. Content fingerprinting for twins is separately deferred
  (`VIDEO_CONTENT_MATCHING_FEASIBILITY.md`).
- **No channel allowlist / uploader field** on `ProviderVideo` today. Discovery
  is artist-scoped YTM + MB URLs + other providers — not “search MTV’s channel”.

## External practice (brief)

- **Lidarr-YouTube-Downloader** / **LidaClips**: treat VEVO / Topic / Official /
  artist-channel as **score boosts** when picking among YouTube *search*
  candidates for a known track — not as a license to ingest whole network
  channels.
- MusicBrainz: YouTube watch URLs on video recordings use free-streaming (+
  video attribute); music-video recording ↔ audio recording is a separate
  relation. Channel brand is not a first-class MB identity signal.

## Answers

### 1. Can we connect these to the right songs / albums?

**Sometimes, not reliably from channel crawl alone.**

- **VEVO / artist-channel OMVs** that already appear in YTM artist videos or as
  ATV counterparts: usually yes (existing pipeline).
- **MB free-streaming URLs** pointing at MTV/VEVO: yes — MB recording is
  identity; we already ingest those.
- **MTV network titles** like `Performs 'Pompeii' | MTV Unplugged`: weak for
  fuzzy match. `cleanVideoGroupTitle` strips `(MTV Unplugged)` parentheticals
  but not `Performs '…'`, `| MTV Music`, or leading artist prefixes. Wrong
  link risk: studio *Pompeii* OMV / Bad Blood vs Unplugged live RG. Live
  variant + venue-aware audio matching help when titles cooperate; they do
  not fix unsupervised MTV discovery.

### 2. Can we avoid duplication (artist + MTV + VEVO, slightly different titles)?

**Same YouTube id:** yes (`ProviderItems` unique on provider + id).

**Different ids, same performance:** only via metadata twinning (title +
duration + variant). MTV marketing titles often diverge enough to miss the
twin or, worse, pair with the wrong cut. Cross-encode / bumper differences
are why content fingerprinting was deferred — do not expect channel allowlists
to solve multi-upload twins.

### 3. Too risky — should we not do it at all?

**Reject automatic MTV / network-channel harvest.** Those channels mix many
artists, interviews, promos, and playlist packaging; artist attribution is
title-parsed, not catalog-owned. **Do not reject** VEVO/MTV URLs that MusicBrainz
(or YTM artist catalog) already surfaces.

### 4. If yes with guardrails — what rules?

Only if revisited after metadata gates are exhausted:

| Layer | Rule |
| --- | --- |
| Discovery | **Allow:** YTM artist videos, MB URL relations, explicit user paste. **Deny:** crawl of MTV / MTV UK / generic network channels / playlists as artist sources. |
| Preference (optional) | Soft score boost for channel name / id hints: `VEVO`, ` - Topic`, `Official`, verified artist channel — **ranking only**, never sole acceptance. |
| Matching evidence | Existing: cleaned title, duration gates, date, ISRC, `video_variant`, MB `music_video_for` / URL ownership. Live/Unplugged must stay live; do not prefer studio album membership for live variants. |
| Dedupe keys | Primary: YouTube video id. Secondary: `artist_mbid` + cleaned group title + duration bucket + `video_variant` (+ ISRC when present). Never channel-alone. |
| Playlists | Manual / confirmed import only; do not auto-expand network “MTV Music” playlists into the artist catalog. |

## Recommendation

1. **No implementation now** — not a small safe change.
2. Document this verdict; TASKS points here (post-2.6.6 optional preference
   scoring only).
3. Near-term coverage for Unplugged-style clips: improve MB video URL coverage /
   title cleaning for `| MTV` / `Performs` forms if live data still fails — not
   a new MTV channel indexer.
