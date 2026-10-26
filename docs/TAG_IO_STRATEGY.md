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

A TagLib write now verifies once:

1. FLAC and MP3 reuse padding in place when the new metadata fits the leading
   tag. The audio tail of the probe is compared before the original head is
   patched. A write that does not fit copies the file and replaces it.
2. MP4 and M4A tag-only changes stay in place when `mdat` is before `moov`
   (the usual ffmpeg layout): TagLib saves on the original and the `moov` tail
   is restored if the tag read-back or the layout check fails. When `moov` is
   before `mdat`, the header is rendered on a probe and patched back only when
   a `free` or `skip` atom at or after `stco` can absorb TagLib's growth, and
   chunk offsets are put back so `mdat` does not move. Otherwise the file is
   copied. `mdta`/`keys` files still go to Mutagen and are not patched.
3. The only value check is one TagLib read-back of the requested tags and
   cover. FLAC and MP3 no longer take a second structure parse. MP4 keeps a
   lightweight check: `ftyp` bytes (including an Atmos `dby1` brand), `mdat`
   payload length, and the raw `dec3` / `ec-3` / `dac3` sample-entry atoms.
   An in-place success also requires the `mdat` offset and chunk offsets to
   stay put.

An in-place write is crash-safe. Before the original is patched, the bytes
needed to undo that region are written to a sibling
`.discogenius-tag-undo-<id>.bin`, and the intent is fsynced (file and
directory) as `.discogenius-tag-undo-<id>.json` plus a pointer in
`config/tag-undo/`. The intent is not a `FileMutationJournal` row: inserting
one would take the SQLite write gate while the retag still holds the HDD
permit. `FileMutationJournal.recoverPending()` is still the only startup
entry. It runs before any command touches the folder, under the album-folder
lock and then the HDD permit.

Recovery is deterministic:

- `preparing` (the backup was not durable yet): delete leftovers, do not touch the media file.
- `armed`, and the patched region still matches the pre-write image: delete the backup.
- `armed`, and the region does not match: write the backup back, truncate to the original size, fsync, and delete the backup only after the pre-write image matches. A kill after the patched bytes were fsynced and before verify therefore comes back byte-identical to the original.
- `verified`, and the post-write image matches: delete the backup and keep the new tags.
- `verified`, but the file matches neither image: restore the original, same as `armed`.

OGG, Opus, AAC, and any FLAC, MP3, or MP4 layout that does not fit the in-place rules stay on copy-plus-`rename`. That rename fsyncs the replacement and its directory. A kill leaves either the old file or the new file. Hashing only the patched region (the tag head, or the `moov` tail) keeps a large `mdat` out of the undo hash.

The measurements below are the previous copy-plus-structure path, kept so the
cost of a full rewrite is still visible. A structural reread averaged about
1 ms even for the 507 MB 4K sample. The complete production path for metadata
plus a separate cover update measured:

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

Audio and video retagging share the native-field diff. A file whose
`managed_tag_fingerprint` already equals the catalogue projection (policy,
scrub flag, ReplayGain, lyrics and cover flags, album-artist mode, tag
standard `picard-v1`, and the managed tag values) is skipped without opening
it. The stored prefix stays `retag:v1:`. A null fingerprint, or a hash from
before this tag standard, is opened once. Obsolete aliases of managed fields
are removed during that diff. Unrelated custom tags remain unless
`scrub_audio_tags`, exposed as "Remove unmanaged tags", is enabled. Turning
scrub on changes the fingerprint, so each file is opened once and custom tags
are removed in the same write. Cover art follows its separate policy, and
MP4 iTunSMPB playback information is preserved. The TagLib read-back is the
only post-write check; retag does not parse the file again with music-metadata.

A read-back that does not match the requested text is a warning, not a file
error. The original file is kept: in-place undo restores it, and a copy that
fails verification is discarded. That covers `TagLib verification failed`,
multi-value order, artist-id lists, ISRC sets, a removal that did not stick,
and a cover whose stored bytes differ. Those notices do not fail the command.
A command whose only problems are warnings ends `completed`, and its
description includes the warning count and a short sample.

These stay file errors, and the message is the writer’s own cause rather than
a bare “Metadata write failed”: MP4 layout, `ftyp`, `mdat` length, sample
entry, or chunk-offset checks; a strip whose clear verification failed; and
read-only, permission, or lock failures (`EACCES`, `EROFS`, `EPERM`, `EBUSY`).

An album cover is validated once per album before it is embedded. A file ffmpeg
cannot decode, including a `cover.jpg` whose JPEG header parses but whose
scan data is corrupt, is not the canonical cover anymore: it is removed, then
replaced through the normal artwork resolve and materialize path when that
path can produce a readable image. Otherwise the tracks are tagged with no
embedded cover and the album records one warning. One bad cover does not
fail every track.

`album_artist_mode` chooses ALBUMARTIST. `plex_jellyfin` (default) writes one
primary artist in MusicBrainz spelling, or Various Artists when that release
credit is the MusicBrainz Various Artists artist. `picard` writes the full
release credit with MusicBrainz join phrases (`A & B`, `A feat. B`). A saved
`full_album_artist_credit: true` migrates to `picard`. ALBUMARTISTS is the
credited-as list in MusicBrainz order in both modes. ALBUMARTISTSORT and
MUSICBRAINZ_ALBUMARTISTID match the people in ALBUMARTIST. ARTIST is the track
credit with join phrases. ARTISTS is each artist's own MusicBrainz name, so a
player does not split one MBID into two spellings.

Multi-value fields are one Vorbis key per value, null-separated ID3v2.4 text,
and multiple MP4 freeform strings. ID3v2.3 files are not upgraded. New empty
ID3 tags are written as v2.4. Navidrome reads M4A `----:com.apple.iTunes:ALBUMARTISTS`
as repeated `albumartists` after it strips the freeform prefix and lowercases
the name. A single `"; "`-joined string would stay one artist, so the writer
does not join those values.

| Field | Vorbis | ID3 | MP4 | Source |
| --- | --- | --- | --- | --- |
| ALBUMARTIST | ALBUMARTIST | TPE2 | aART | Primary MB name, VA, or full credit |
| ALBUMARTISTS | ALBUMARTISTS | TXXX:ALBUMARTISTS | freeform ALBUMARTISTS | Credited-as names |
| ARTIST | ARTIST | TPE1 | ©ART | Track credit with join phrases |
| ARTISTS | ARTISTS | TXXX:ARTISTS | freeform ARTISTS | Each artist's MB name |
| MUSICBRAINZ_ARTISTID | MUSICBRAINZ_ARTISTID | TXXX:MusicBrainz Artist Id | freeform MusicBrainz Artist Id | Track artist MBIDs |
| MUSICBRAINZ_ALBUMARTISTID | MUSICBRAINZ_ALBUMARTISTID | TXXX:MusicBrainz Album Artist Id | freeform MusicBrainz Album Artist Id | People in ALBUMARTIST |
| LABEL | LABEL | TPUB | freeform LABEL | Release labels |
| CATALOGNUMBER | CATALOGNUMBER | TXXX:CATALOGNUMBER | freeform CATALOGNUMBER | `release_label.catalog_number` |
| ASIN | ASIN | TXXX:ASIN | freeform ASIN | `release_meta.amazon_asin` |
| SCRIPT | SCRIPT | TXXX:SCRIPT | freeform SCRIPT | `script.iso_code` |
| LANGUAGE | LANGUAGE | TLAN | freeform LANGUAGE | Release `language.iso_code_3` |
| DISCSUBTITLE | DISCSUBTITLE | TSST, or TXXX:DISCSUBTITLE on v2.3 | freeform DISCSUBTITLE | Medium name |
| ORIGINALDATE | ORIGINALDATE | TDOR | freeform originaldate | Release-group first release date |
| ORIGINALYEAR | ORIGINALYEAR | TXXX:originalyear | freeform originalyear | Year of that date |
| COMPILATION | COMPILATION=1 | TCMP | cpil | Various Artists release |
| ARTISTSORT | ARTISTSORT | TSOP | soar | Track sort names with join phrases |
| ALBUMARTISTSORT | ALBUMARTISTSORT | TSO2 | soaa | Sort names of the ALBUMARTIST people |
| GENRE | GENRE | TCON | ©gen | Release genres |
| RELEASETYPE | RELEASETYPE | TXXX:MusicBrainz Album Type | freeform MusicBrainz Album Type | Primary and secondary types |
| Track totals | TRACKNUMBER, TRACKTOTAL, DISCNUMBER, DISCTOTAL | TRCK and TPOS as n/m | trkn, disk | Canonical positions |

A retag removes fields Discogenius used to write and no longer owns:
PROVIDER_URL, TXXX/freeform Track Number, Track Count, Disc Number, Disc Count,
ITUNESADVISORY (the MP4 `rtng` atom stays), DISCOGENIUS_ALBUMARTIST_MBIDS,
RELEASETIME, and the provider sort atoms soal, sonm, and soco. A user tag such
as DISCOGENIUS_CUSTOM is left in place unless "Remove unmanaged tags" is on.
Embedded lyrics are plain text (LYRICS, USLT, ©lyr). Synced lyrics stay in the
`.lrc` sidecar.

FLAC, Ogg Vorbis, Opus, MP3, AAC ADTS, WAV, classic AIFF (FORM AIFF), and M4A
(AAC or ALAC in an MP4) round-trip these fields. WMA, APE, MP2, a bare `.alac`
file, and AIFF-C are left unchanged: TagLib cannot store this tag set there,
and ffmpeg is not used as a half-tag fallback. Catalog number, ASIN, script,
and language are empty until the next MusicBrainz mirror import. Disc subtitle
and the release-group first release date were already stored. `user_version`
stays 46.

Composer, lyricist, performer, and the other relationship credits are not
written yet. Music-video files still use the previous video writer, including
PROVIDER_URL. Both are listed in `docs/TASKS.md`.

Track and edition artist IDs come from their respective canonical credits.
ISRCs and artist IDs retain multiple native values. MP4 uses native integer
advisory/media-kind atoms; music videos have media kind 6. Barcode and original
date fields follow Picard's format mappings. Explicit edition context supplies
album identifiers; ambiguous provider membership does not invent one.

Video imports tag the exact returned TrackFiles rows and fail on tag-write
errors. Artist retagging also includes videos. Video tag writes verify the
result and a second unchanged retag skips the file. The real MP4 integration
test checks that encoded audio and video hashes remain unchanged.
