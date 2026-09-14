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


## Import and retag verification

Audio imports and retagging use AudioTagService. Ordinary retagging reads the local catalog,
local lyric sidecars and cached covers. Provider lyric discovery requires an
explicit import/repair option. Preview does not rename sidecars.

Lyrics retain line breaks. Verification reads native Vorbis LYRICS, M4A
`©lyr` and ID3 USLT fields because music-metadata's parsed timed-lyric
objects are not the original LRC text. Its common musicbrainz_trackid is a
release-track ID, so it cannot substitute for musicbrainz_recordingid.
MP3 recording IDs use Picard's UFID frame with owner `http://musicbrainz.org`.
Retagging replaces the former custom `MusicBrainz Track Id` text frame.
M4A ISRC writes use the iTunes freeform ISRC field and remove the conflicting
raw isrc atom, including on the Mutagen compatibility path.

The complete canonical recording ISRC list is written, following Picard's
`mbjson.add_isrcs_to_metadata` and format writers: repeated Vorbis ISRC fields,
multiple iTunes freeform ISRC values, and ID3 TSRC text values. ID3v2.3 uses
Picard's slash-separated representation because that version lacks general
multivalue text support. Verification compares normalized sets. A provider ISRC
is a fallback only when the canonical list is empty; provider evidence is not
silently added to MusicBrainz facts. A missing ISRC in MusicBrainz alone does
not establish a bad match, and an edition barcode alone does not establish the
identity of each track.

The canonical tag integration tests write real FLAC, M4A and MP3 files against
the active schema, embed a local sidecar with tag scrubbing enabled, and require
a second retag and preview to report no changes. The M4A ISRC regression begins
with an existing Apple freeform field and checks decoded audio preservation.

## Managed fields and cleanup

Audio and video retagging share the native-field diff. Unchanged files are
skipped. Obsolete aliases of managed fields are removed during the verified
write. Unrelated custom tags remain unless `scrub_audio_tags`, exposed as
"Remove unmanaged tags", is enabled. Scrubbing detects custom-only changes
and removes them in the same atomic write. Cover art follows its separate
policy, and MP4 iTunSMPB playback information is preserved.

Track and edition artist IDs come from their respective canonical credits.
ISRCs and artist IDs retain multiple native values. MP4 uses native integer
advisory/media-kind atoms; music videos have media kind 6. Barcode and original
date fields follow Picard's format mappings. Explicit edition context supplies
album identifiers; ambiguous provider membership does not invent one.

Video imports tag the exact returned TrackFiles rows and fail on tag-write
errors. Artist retagging also includes videos. Video tag writes verify the
result and a second unchanged retag skips the file. The real MP4 integration
test checks that encoded audio and video hashes remain unchanged.

This is not full Picard feature parity. Composer and performer relationship
metadata needs canonical acquisition support before it can be written. The
real-file regression coverage here is FLAC, MP3, M4A and MP4; it does not prove
every legacy container or arbitrary custom tag representation.
