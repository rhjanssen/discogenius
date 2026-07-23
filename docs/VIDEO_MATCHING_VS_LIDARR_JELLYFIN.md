# Music-video ↔ audio matching vs Lidarr / Jellyfin

Research note (2026-07-23; updated 2026-07-23 for 2.6.7 live-marker cleanup).
Compares Discogenius video↔album/track/recording linking to `.ref_lidarr` and
`.ref_jellyfin`. Not a rewrite plan.

## Verdict (for Robert)

**Not lost in the woods on architecture.** The durable spine — MusicBrainz
`music_video_for`, inferred `provider_video_for`, provider/recording IDs,
duration gates, and a small `video_variant` class — is the right shape for a
catalog-primary MV manager. Lidarr and Jellyfin do **not** solve this problem
the way we do; there is no mature open-source “copy their MV↔track matcher.”

**2.6.7 cleanup:** live/performance detection is centralized in
`live-performance-markers.ts` (TS + SQL fragment builders). Generic tokens only
(`live`, `performance`, `unplugged`). Bastille-shaped TV/show deny phrases
(`jools holland`, `hootenanny`, `porchester`, `mercury prize`, `pete mitchell`)
were **removed**, not frozen-for-growth — session cuts without the word “live”
are handled by **live-album-only** membership (appears on a Live / live-titled
RG and on no non-live album).

**Next validation:** larger artist stress-test; fix failures with structure
(RG Live secondary, venue signatures, MB relations), not more show-name `LIKE`s.

---

## 1. What Discogenius does today

### Durable identity / link path

| Layer | Mechanism | Role |
| --- | --- | --- |
| MB relations | `RecordingRelations.music_video_for` from MusicBrainz | Canonical video→audio when MB has it |
| Provider inference | `provider_video_for` (title/duration/ISRC + studio preference) | Fill the hole when MB has no link |
| Video↔video merges | `video-match.ts` weighted title + duration + date (+ ISRC) | Cross-provider twin offers |
| Album placement | Related **audio**’s tracklist + `video-album-association` ranks | Appears On / inline; not stamped provider album ids |
| Organize naming | `video_variant` → Plex-style `-video` / `-lyrics` / `-live` / … | Export for media servers |

Key modules: `video-variant.ts`, `video-match.ts`, `live-performance-markers.ts`,
`refresh-video-support.ts` (`findRelatedAudioRecordingForVideo`),
`refresh-video-service.ts`, `video-query-service.ts`, `video-album-association.ts`,
`musicbrainz-video-service.ts`, `video-folder-layout.ts` / `video-naming.ts`.

### Phrase / pattern surface (inventory)

**A. Generic marketing / cut class (keep — industry-shaped, small)**

In `video-variant.ts`:

- Classify: `audio`, `lyric(s)`, `visualizer` / `moving artwork`, `live` /
  `performance` / `unplugged`, `official` / `music video`
- Strip for match identity: same tokens in parens / trailing dash
- Display: strip only default OMV wrappers (`Official Music Video`, etc.)
- Filename extras: `-lyrics`, `-live`, `-video`; title fallbacks
  `-behindthescenes`, `-interview`, `-concert`

This mirrors **fixed extras vocabularies** (Plex/Jellyfin), not an unbounded
deny list.

**B. Live↔studio gate (centralized — `live-performance-markers.ts`)**

Shared API:

- `isLivePerformanceTitle(title)` — word-bounded `live` | `performance` | `unplugged`
- `isLivePerformanceAudio({ trackTitle, albumTitle, albumSecondaryTypes })`
- `livePerformanceTitleSql(column)` / `relatedAudioIsLiveSql(...)` /
  `mainVideoMayFollowAudioRelationSql(...)` — one SQL vocabulary for
  Appears On, inline placement, and library path selection

Rules:

1. **Live-marked video** must not associate to studio-only audio (no live
   marker on track title, and not live-album-only).
2. **Studio / main OMV** must not prefer live-marked audio (title or
   live-album-only) when studio preference is on; Appears On / inline use the
   same predicate so query sites cannot drift.
3. Audio side is live when **track title** has a marker, **or** the recording
   only appears on live-marked albums (RG Live secondary or live-marked album
   title). Studio recordings that also sit on a live compilation stay non-live
   for matching (album ranking still prefers studio > compilation > live).

**Removed (do not re-add):** `jools holland`, `hootenanny`, `porchester`,
`mercury prize`, `pete mitchell`, `later…jools`.

Also: `extractLiveVenueSignatures` / Unit-24-style parentheticals — venue
overlap for live↔live twins (Abbey Road vs Unit 24), separate from the
live↔studio gate.

**C. Scoring / gates (durable heuristics, Lidarr-like)**

- Soft duration ±2s (video↔video); hard reject ±3s
- Wider ±20s OMV→studio audio when preferring studio album membership
- Studio > other non-live > compilation > live for album association
- **Live↔studio title/membership gate applies even when duration (or ISRC) is
  close** — duration gates do not override the live mismatch
- Live↔main merge exceptions only for named venue/TV twins or bare cross-provider
  `(Live)` twins under tight gates (`video-match.ts`)

---

## 2. Lidarr (`.ref_lidarr`)

**Audio-centric. No music-video ↔ album/track product.**

- Track identification: `DistanceCalculator` — title string distance, length
  ratio (~10s slack then 30s scale), optional artist, track index, **recording
  MBID**, AcoustID hits, album title/year/country priority.
- `Extras/` = NFO, artwork, “other” sidecar files — not OMVs linked to
  recordings.
- NFO detector mentions `<musicvideo>` as an XBMC tag shape; Lidarr does not
  manage a music-video library or infer video→audio relations.

**What we correctly borrow:** multi-signal distance (title + length + ids), not
an extras phrase engine for catalog matching. `video-match.ts` already states
this.

---

## 3. Jellyfin (`.ref_jellyfin`)

**Separate Music Video library type + fixed extras tokens. No Discogenius-style
catalog matching.**

- `MusicVideo` entity: artists list + optional `Album` **string**; year from
  name/folder. Lookup via NFO / providers (IMVDb external id), not MB
  `music_video_for` → recording FK.
- Extras: `NamingOptions.VideoExtraRules` — **closed list** of directory names
  (`trailers`, `behind the scenes`, `interviews`, …) and suffixes
  (`-trailer`, `-interview`, `-behindthescenes`, `-clip`, …). Parent attach is
  **path/filename prefix**, not ISRC/duration scoring.
- No `-video` / `-lyrics` / `-live` / `-concert` in Jellyfin’s extras enum —
  those are closer to **Plex music-library extras** (filename stem match +
  `-video`). Discogenius uses them for *export layout*, which is fine; do not
  confuse that with Jellyfin’s matching model.

Jellyfin grows a **stable, documented token table** for classification, then
relies on folder layout + user/NFO/provider IDs. It does not accumulate TV-show
title deny-lists to decide “this MV belongs on *Bad Blood*.”

---

## 4. Industry pattern

Mature tools do **not** win identity by endlessly growing allow/deny phrase
lists for song matching. They prefer:

1. **IDs** (MBID, provider ids, AcoustID for audio)
2. **Folder / filename contracts** (Plex `-video` next to the track; Jellyfin
   extras dirs)
3. **User / sidecar metadata** (NFO, locked fields)
4. **Small fixed vocabularies** for *type* (trailer vs interview vs OMV)

Phrase lists appear as **classification** (extras type, clean “Official Video”
noise) and stay bounded. Lidarr’s various-artists / preferred-country lists are
tiny and stable — not per-artist TV show names.

Discogenius is unusual (and ahead) in treating MVs as first-class catalog
recordings with relations. That gap is product scope, not a sign we should copy
Jellyfin’s indifference to track linkage.

---

## 5. Keep / simplify / stop

| Keep | Simplify | Stop |
| --- | --- | --- |
| MB `music_video_for` + provider ids / URLs | ✅ One shared live-title helper + SQL builders | Adding named TV/session shows to deny lists |
| `provider_video_for` via title+duration/ISRC | ✅ Generic `live`/`performance`/`unplugged` + live-album-only | Treating Bastille/Bakermat alone as proof of generality |
| `video_variant` + marketing strip (small regex set) | Studio vs live ranking aligned with the gate | Refresh-time content sampling (see `VIDEO_CONTENT_MATCHING_FEASIBILITY.md`) |
| Studio vs live/compilation ranking | Optional later: import-only Chromaprint as *extra* evidence | Assuming Lidarr/Jellyfin “already solved” MV↔album |

---

## 6. Is “500 artists” the right next test?

**Yes, as validation — with guardrails.**

1. ~~Freeze the Bastille TV-show deny list~~ → **removed**; use live-album-only.
2. Refresh a diverse set (studio-heavy, live-heavy, sparse-MB, multi-provider).
3. Score failures: wrong Appears On, live↔studio merge, missing `music_video_for`
   fallback, inline placement.
4. Fix with structure (MB relation coverage, RG types, duration/variant, venue
   signatures) — **not** one new `LIKE` per bad title.
5. Bastille/Bakermat remain fine smoke artists; they are not the corpus.

Related: `VIDEO_CONTENT_MATCHING_FEASIBILITY.md` (defer content matching),
`YOUTUBE_SEMI_OFFICIAL_SOURCES.md` (channel harvest still deferred).
