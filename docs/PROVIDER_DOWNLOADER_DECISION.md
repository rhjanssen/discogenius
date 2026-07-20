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

## spotDL boundary

Spotify lists, followed artists, catalog identity, artwork, ISRC/UPC and previews
remain sourced from Spotify's official Web API. Discogenius already imports
those lists without needing spotDL. A future “match Spotify metadata to a
YouTube fallback” option could be explicit about both identities, but it must
produce a YouTube offer/file provenance and never masquerade as Spotify media.

All third-party download integrations remain subject to provider terms,
account subscriptions, regional availability, and applicable law. Bundling a
tool is not an entitlement to media.
