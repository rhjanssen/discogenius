# Provider downloader backend decision

Decision date: 2026-07-19

## Decision

Keep Discogenius's provider-specific backends. Do not replace them with
OrpheusDL, and do not label spotDL output as a Spotify download.

Discogenius already owns the useful common layer: provider-neutral offer
identity, quality mapping, bounded command execution, cancellation/progress,
provider-ID staging names, and MusicBrainz-based import. OrpheusDL would put a
second plugin abstraction underneath that layer, while its modules still need
the same provider credentials, DRM helpers, and service-specific maintenance.
It does not make an otherwise impossible provider directly downloadable.

Revisit this decision only when an Orpheus module demonstrably supports a
format or entitlement that the current provider tool cannot, and it can expose
non-interactive progress, cancellation, deterministic output identity, and
partial-failure status at least as well as the existing backend.

## Current feasibility

| Provider | Current backend | What is actually downloaded | Decision |
| --- | --- | --- | --- |
| TIDAL | [`tiddl`](https://github.com/oskvr37/tiddl) | Direct TIDAL audio, Atmos and videos within the account/region entitlement | Keep. It already exposes the required quality and per-job controls. |
| Apple Music | [`apple-music-downloader`](https://github.com/zhaarey/apple-music-downloader) plus the decryption sidecar | Direct Apple audio, Atmos and videos; upstream config accepts video heights through 2160 | Keep for 2.4.0. [`gamdl`](https://github.com/glomatico/gamdl) is the strongest alternative if live validation proves a persistent 4K/lyrics defect. The [Orpheus Apple module](https://github.com/bascurtiz/orpheusdl-applemusic) describes itself as a gamdl bridge, requires its own Orpheus fork, and does not remove the DRM/profile requirements. |
| Amazon Music | [`amazon-music`](https://github.com/AmineSoukara/Amazon-Music) | Direct entitled Amazon audio through an unofficial API/session when the hosted token API is up | **Soon in Auth for 2.4.0.** The pip client is not dead (last release 1.7.7, Dec 2025), but catalog/download both depend on `amz.dezalty.com`, which is currently unreachable and not self-hostable like the Apple wrapper. Code stays in-tree; reconnect when the host (or a compatible mirror) is reliable. |
| Spotify | [`Votify`](https://github.com/glomatico/votify) with librespot | Direct Spotify Vorbis audio for a Premium session; no lossless, spatial or video claim | **Soon in Auth for 2.4.0.** Plugin works with a Spotify Developer client ID/secret (+ optional cookies for downloads), but that UX is held back until connection is simpler. spotDL remains rejected (YouTube audio provenance). |
| YouTube / YouTube Music | [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) + [`ytmusicapi`](https://github.com/sigma67/ytmusicapi) | Direct YouTube audio/video; YouTube audio remains lossy | Keep. Bundle yt-dlp's EJS scripts and a supported JavaScript runtime as required by the [upstream EJS guide](https://github.com/yt-dlp/yt-dlp/wiki/EJS). |
| Deezer | [`Streamrip`](https://github.com/nathom/streamrip) | Direct entitled Deezer MP3/FLAC with an ARL session | Keep. The pinned Streamrip implementation does not expose Deezer lyrics, so lyrics must come from a canonical cross-provider counterpart rather than a false capability claim. |
| SoundCloud | Native progressive resolve via `api-v2`, with [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) fallback | Lossy progressive/HLS when the session can resolve it; major-label free accounts often SNIP or encrypted-HLS only | Experimental. Prefer native progressive for entitled tracks; keep yt-dlp as fallback rather than yt-dlp-only. Official OAuth 2.1 download path deferred. **Do not** add Widevine decrypt or analog-hole capture (see below). |

## SoundCloud DRM (decided 2026-07-23)

Major-label / Go+ catalog often exposes only `cbc-encrypted-hls` /
`ctr-encrypted-hls` (browser EME + Widevine/FairPlay CDM). Example: Bastille
OPH set tracks such as SoundCloud `26282908` play in-browser but have no plain
progressive/HLS for downloaders.

### Decrypt path — REJECT

- [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) and [`scdl`](https://github.com/imthaghost/scdl)
  intentionally refuse DRM; yt-dlp now surfaces a clear DRM error instead of a
  misleading 404 on encrypted formats.
- Unlike Apple Music, there is **no** maintained SoundCloud FairPlay/Widevine
  wrapper comparable to `ghcr.io/itouakirai/wrapper` + `apple-music-downloader`.
  Generic Widevine L3 stacks (pywidevine / Vinetrimmer-style) need extracted CDM
  device files, brittle license-client reverse engineering, and ongoing
  cat-and-mouse — not a legitimate, Docker-shippable Discogenius dependency.
- Spotify’s own quality map already refuses Widevine-backed modes for the same
  reason (no CDM provisioning in-tree).

### Analog-hole recording — REJECT

- Capture is always a **re-encode of decoded PCM** (quality ceiling ≤ stream
  decode; never a bit-perfect copy of the AAC/MP3 segments).
- Self-hosted Docker has no host WASAPI/Pulse sink; adding headless Chromium +
  Widevine CDM + virtual audio is fragile and host-OS-specific.
- Windows WASAPI loopback explicitly refuses DRM-flagged protected streams on
  trusted drivers (Microsoft Core Audio docs).
- Real-time 1× playback, silence/ads/UI noise, and batch reliability make this
  worse than skip-DRM for album jobs.

### Product behavior

Keep rejecting DRM/SNIP as terminal for those tracks (do not fall through to
yt-dlp for encrypted formats). **2.6.5:** skip DRM/SNIP tracks and complete
partial albums with per-track `skipped` status plus a job-level warning.
Go+ oauth may unlock
non-DRM HQ progressive/HLS on entitled non-major tracks — that remains the only
supported quality path.

## spotDL boundary

Spotify lists, followed artists, catalog identity, artwork, ISRC/UPC and previews
remain sourced from Spotify's official Web API. Discogenius already imports
those lists without needing spotDL. A future “match Spotify metadata to a
YouTube fallback” option could be explicit about both identities, but it must
produce a YouTube offer/file provenance and never masquerade as Spotify media.

All third-party download integrations remain subject to provider terms,
account subscriptions, regional availability, and applicable law. Bundling a
tool is not an entitlement to media.
