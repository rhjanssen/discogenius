# Partial video-stream matching — feasibility (2026-07-23)

**Verdict: defer.** Do not put stream sampling into artist refresh for 2.6.6.
Worth a later **import-only** Chromaprint spike if metadata gates still leave
cross-provider OMV twins split. Reject default refresh-time content sampling.

## What we already do

Video identity is metadata-only (`video-match.ts` / `refresh-video-support.ts`):

- Weighted title + duration + release date; soft duration gate **±2s**, hard
  reject **±3s**; shared ISRC as a strong twin signal.
- `video_variant` (official / lyric / live / …) blocks live↔studio merges and
  allows limited lyric↔main merges when duration agrees.
- MB video recordings + provider offers; video→audio “Appears On” via
  title/duration/ISRC (wider gate for OMV→studio audio).
- Downloaded files: ffprobe quality/codec on `TrackFiles`; Chromaprint /
  AcoustID exists for **audio** unknown imports (`fingerprint.ts`), not for
  video grouping. `TrackFiles.fingerprint` can store a value but is not a
  video-identity pipeline today.

Lidarr/Sonarr do not content-match music videos. No widely used MV manager
exposes a reusable “sample then group” path we should copy. Provider Content
IDs (YouTube Content ID, etc.) are not usefully exposed to downloaders.

## Techniques (short samples)

| Approach | Good for | Bad for | Fit here |
| --- | --- | --- | --- |
| **Audio Chromaprint** (`fpcalc` on MV audio; local compare, not AcoustID) | Same song under different encodes/titles; duration off a few seconds | Lyric vs OMV (often same mix); live vs studio can still collide on covers | **Best first prototype** — tool already shipped |
| Visual pHash / videohash-style frame collage | Same *visual* cut across codecs/crops | Intro bumpers, aspect crops, lyric vs OMV (correctly split); Python-heavy | Optional later if audio+variant still conflates |
| Compact CNN embeddings | Research-grade NDVR | Ops/CPU/deps; overkill for self-hosted refresh | Reject |
| Provider content IDs | Ideal if exposed | Not available to us | Reject |

Chromaprint is built for **near-identical audio**, not 1–2s one-shots. Prefer
~15–30s of audio (`fpcalc -length`), ideally not only the first seconds (logos
/ silence). Compare fingerprints locally; do **not** treat AcoustID MB hits as
video recording identity.

## Refresh-time sampling (before full download)

Technically possible for some backends:

- YouTube / YT Music: `yt-dlp --download-sections "*0:00-0:30"` + ffmpeg audio
  extract (needs ffmpeg; cut accuracy is keyframe-bounded).
- Progressive/HLS elsewhere: byte/time ranges vary by provider DRM and CDN;
  Apple/TIDAL entitled streams are not a free “peek N seconds” API.

Cost dominates correctness:

- Fixed cost per offer (resolve + handshake + section fetch) is often **seconds**,
  not the size of a 30s audio clip.
- Artist refresh × many videos × multiple providers → minutes of extra wall
  clock, plus rate-limit / ToS risk — even if limited to “ambiguous” pairs.
- Enrichment already calls `getVideo` sparingly for duration/quality holes;
  content sampling would dwarf that.

**Do not** run on full catalog scans or every refresh offer. Even top-K
ambiguous pairs should wait until metadata improvements are exhausted.

## Import / library path (cheaper)

Once a video file is on disk:

1. One-time: demux ~30s audio → `fpcalc` → store on `TrackFiles` (column exists).
2. Optional later: pairwise compare within an artist (or among unresolved
   offers that already have a downloaded twin) as **extra evidence**, always
   gated by `video_variant` + existing duration/title soft gates.
3. Use for regrouping wrong album associations / confirming twins — not as a
   sole merge key.

This amortizes CPU on import (already heavy with organize/retag) and never
hits provider CDNs during refresh.

## Accuracy vs real MV diversity

- **Same OMV, different encode** (HEVC / AV1 / H.264): audio Chromaprint usually
  agrees; visual hash usually agrees.
- **Duration ± few seconds**: fingerprints can still match; keep a soft
  duration band so we do not merge radio edits with full cuts blindly.
- **Lyric vs official**: audio often matches → **false merge** unless variant
  (or visual) blocks it. Current lyric↔main merge rules must stay stricter than
  “audio similar”.
- **Live vs studio / sibling venue cuts**: audio often differs; when it does not
  (same backing track), content evidence is dangerous — prefer venue title /
  MB relations over fingerprint.

## Recommendation

1. **Defer** content sampling for provider refresh matching (reject as default).
2. If revisited: **import-only Chromaprint** on downloaded MVs, local compare,
   variant-gated, top-K / already-downloaded only — never full-offer refresh.
3. Near-term pain (wrong album links, missing YT offers, live siblings) stays a
   **metadata** problem: MB relations, ISRC, title cleaning, duration gates —
   not stream hashing.
4. Suggested future TASKS item (post-2.6.6): optional spike — fingerprint
   downloaded Bastille/Bakermat MVs, measure pairwise scores for known twins
   vs lyric/live negatives; no production matcher until that matrix looks safe.

## Rough cost model

- Import: ~0.5–2s wall clock per file for 30s extract + `fpcalc` (once).
- Refresh, all offers: **unacceptable** (multi-second fixed cost × N).
- Refresh, top-K ambiguous pairs only: still **high risk** (15–120s+ / artist);
  defer until proven necessary.
