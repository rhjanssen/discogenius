# Apple Music downloader evaluation

Status for 2.2.0: keep `zhaarey/apple-music-downloader` as the Apple Music
candidate, but do not claim it is fully live-validated until Robert provides an
Apple token and the wrapper/MP4Box runtime is exercised.

## What Discogenius needs

- Album, track, playlist, and music-video URLs.
- Stable provider ids in staged filenames.
- Lossless/hi-res ALAC for stereo libraries.
- Dolby Atmos/spatial downloads.
- Music-video downloads.
- Non-interactive CLI operation from a worker process.
- Progress text we can parse into the shared queue contract.

## Candidate summary

| Candidate | Strengths | Gaps for Discogenius |
| --- | --- | --- |
| `zhaarey/apple-music-downloader` | Supports ALAC, Atmos, AAC, music videos, Docker usage, provider-id filename templates, and a config-driven non-interactive CLI. | Needs MP4Box and a decryption wrapper for the high-fidelity path. No formal releases; pin the source image by digest. |
| `glomatico/gamdl` | Actively released on PyPI, pip-installable, Python CLI, strong AAC/video story, rich metadata/lyrics support. More TIDAL-like to install for lossy/video cases. | Lossless/ALAC still recommends or effectively needs wrapper support; cookie/Widevine setup is not simpler for our parity target. |
| `WorldObservationLog/AppleMusicDecrypt` | Focused on decryption and wrapper/manager ecosystem; can be powerful for ALAC. | More complex operational model, AGPL license, and not as directly aligned to Discogenius' provider-id staging/downloader-wrapper pattern. |
| `apmyx-gui` | User-friendly GUI and quality selection; confirms same dependency landscape. | GUI-first, not a clean headless worker backend. |

## Decision

For 2.2.0, `zhaarey/apple-music-downloader` remains the most compatible with the
Discogenius acquisition model because it can be driven by URL, reads a managed
`config.yaml`, and supports provider-id output templates. It is not as tidy as
TIDAL/tiddl, but that appears to be an Apple Music ecosystem constraint rather
than a bad single-tool choice.

To keep the core image reasonable, Discogenius only bundles the static
`apple-music-dl` binary (about tens of MB), pinned by image digest. It does not
bundle the heavy MP4Box dependency stack or an authenticated wrapper rootfs.
Those remain provider prerequisites surfaced by diagnostics.

`gamdl` stays the main revisit candidate. If live validation shows zhaarey is
too brittle, evaluate a `gamdl` backend for AAC/video first, then decide whether
ALAC/Atmos still needs the same wrapper infrastructure.

References:

- https://github.com/zhaarey/apple-music-downloader
- https://github.com/glomatico/gamdl
- https://github.com/WorldObservationLog/AppleMusicDecrypt
- https://github.com/rwnk-12/apmyx-gui
