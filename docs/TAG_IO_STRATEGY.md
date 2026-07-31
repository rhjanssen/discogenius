# Media tag I/O strategy

## Decision

Discogenius uses `node-taglib-sharp` as the primary in-process metadata writer
for the formats that have passed byte-preservation tests. MP4-family writes are
currently enabled only for `.m4a` and `.mp4`, and only for iTunes-style metadata
layouts. Files containing the ISO `mdta` `keys` atom stay on the Mutagen
compatibility path because `node-taglib-sharp` corrupts that layout.

Mediabunny is not a safe tag writer for Discogenius. It is a remuxer when used
for this job, and its MP4 output changed Dolby Atmos container signaling and
did not round-trip the MusicBrainz, ReplayGain, and Discogenius custom atoms.

Tag writing and technical media analysis remain separate responsibilities.
TagLib writes tags; the technical reader/prober remains responsible for codec,
quality, spatial, and video facts. FFmpeg remains for real extraction,
transcoding, downmixing, or remuxing—not routine tag changes.

## Real preservation corpus

The live corpus is local and gitignored under
`downloads/tag-writer-benchmark/`. It was downloaded through Discogenius's
configured provider tooling and is not a generated codec simulation.

| Sample | Provider | Actual media | Size |
| --- | --- | --- | ---: |
| Lossy stereo | TIDAL | AAC-LC, 44.1 kHz, stereo, M4A | 7,735,534 B |
| Lossless stereo | TIDAL | FLAC, 44.1 kHz, stereo | 22,170,938 B |
| Spatial audio | TIDAL | E-AC-3/JOC, 48 kHz, 5.1, M4A | 17,649,141 B |
| 1080p video | TIDAL | H.264 1624×1080 + AAC | 95,459,943 B |
| 4K video | Apple Music | HEVC Main 10 3840×2160 + AAC | 506,953,412 B |

The Atmos source carries compatible brand `dby1`, an `ec-3` sample entry, and a
`dec3` box reporting Dolby Atmos complexity index type 16.

## Writer results

Every candidate wrote title, artist, album artist, album, comment, lyrics,
MusicBrainz Recording ID, ReplayGain, a Discogenius custom field, and a
replacement cover.

| Writer | FLAC | AAC M4A | Atmos M4A | 1080p MP4 | 4K MP4 | Result |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| node-taglib-sharp | 53.67 ms | 56.21 ms | 61.87 ms | 120.87 ms | 69.28 ms | Passed provider corpus |
| Mutagen | 343.29 ms | 210.37 ms | 312.30 ms | 53.47 ms | 73.28 ms | Passed provider corpus |
| Mediabunny | 148.63 ms | 117.84 ms | 123.10 ms | 330.79 ms | 1,276.56 ms | Rejected |

These are in-library write plus reread times. They exclude process startup and
the outer atomic-copy policy.

For both TagLib and Mutagen:

- encoded audio and video packet hashes were unchanged;
- duration, channel count, sample rate, dimensions, and stream count remained
  readable;
- replacement artwork was readable;
- MusicBrainz, ReplayGain, lyrics, and custom fields round-tripped;
- the Atmos `ec-3` and `dec3` boxes were byte-identical;
- the `dby1` brand and Atmos complexity index remained present.

Mediabunny kept the encoded E-AC-3 packets but rebuilt the MP4:

- `dby1` was removed from compatible brands;
- `dec3` changed from 15 bytes to 13 bytes;
- MP4Box no longer reported the Atmos complexity index;
- custom MP4 atoms did not round-trip through Mutagen;
- track order changed on M4A files.

The additional FFmpeg-created `mdta/keys` regression exposed a separate
node-taglib-sharp limitation. TagLib's cover write made that file unreadable;
Mutagen preserved it. Discogenius now detects this layout before mutation and
routes it to Mutagen.

## Production verification policy

Every TagLib write:

1. reads the original technical structure;
2. copies the source to a sibling working file;
3. modifies only the working file;
4. rereads and verifies every requested tag or cover;
5. rereads and compares duration, media types, codec descriptions, audio
   channels/sample rate/bit depth, and video dimensions;
6. atomically replaces the original only after verification succeeds.

A structural reread averaged about 1 ms even for the 507 MB 4K sample. The
complete production path for metadata plus a separate cover update measured:

- Atmos M4A: 207.35 ms;
- 4K MP4: 1,518.64 ms.

The 4K cost is dominated by safe working-file copies, not parsing.

Full packet hashing is intentionally not the default retag behavior. Average
single-pass packet-hash costs on the local SSD were:

| Sample | Header probe | Full packet hash |
| --- | ---: | ---: |
| Lossy M4A | 29.67 ms | 57.58 ms |
| Lossless FLAC | 25.33 ms | 78.57 ms |
| Atmos M4A | 29.07 ms | 76.23 ms |
| 1080p MP4 | 33.41 ms | 289.97 ms |
| 4K MP4 | 26.48 ms | 1,241.19 ms |

A before-and-after hash doubles those I/O costs and will be materially slower
on NAS storage. Packet hashing therefore remains a benchmark, diagnostic, and
future opt-in deep-verification mode. The default path uses atomic mutation,
exact tag/cover rereads, and the inexpensive structural comparison.

