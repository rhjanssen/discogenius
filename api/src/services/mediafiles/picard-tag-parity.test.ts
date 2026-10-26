import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { writeMetadata } from "./audioUtils.js";
import {
  AudioTagService,
  MULTI_VALUE_SEPARATOR,
  VARIOUS_ARTISTS_MBID,
  planAlbumArtistTags,
  type ManagedTag,
} from "./audio-tag-service.js";
import { writeMediaTagsWithTagLib } from "./media-tag-io.js";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { windowsHide: true }).status === 0;
const A = "a3ee920f-4e7f-4993-8aca-4b8538cfaa4a";
const B = "481cbdd9-02ac-46fd-825f-afed658bc505";

const FORMATS = [
  { extension: ".flac", codec: ["-c:a", "flac"] },
  { extension: ".opus", codec: ["-c:a", "libopus"] },
  { extension: ".ogg", codec: ["-c:a", "libvorbis"] },
  { extension: ".mp3", codec: ["-c:a", "libmp3lame", "-id3v2_version", "4"] },
  { extension: ".m4a", codec: ["-c:a", "aac", "-f", "mp4"] },
  { extension: ".aac", codec: ["-c:a", "aac", "-f", "adts"] },
  { extension: ".wav", codec: ["-c:a", "pcm_s16le", "-f", "wav"] },
  // TagLib only opens classic FORM AIFF. ffmpeg's default PCM is AIFF-C.
  { extension: ".aiff", codec: ["-c:a", "pcm_s16be", "-f", "aiff"] },
] as const;

function generateAudio(filePath: string, codec: readonly string[]): void {
  const generated = spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "1",
    ...codec, filePath,
  ], { windowsHide: true, encoding: "utf8" });
  assert.equal(generated.status, 0, generated.stderr);
}

function fileHash(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function tag(key: string, ffmpegKey: string, targetValue: string): ManagedTag {
  return { key, label: key, ffmpegKey, targetValue };
}

function removalTags(): ManagedTag[] {
  return [
    tag("provider_url", "PROVIDER_URL", ""),
    tag("legacy_track_number", "TXXX:Track Number", ""),
    tag("legacy_track_count", "TXXX:Track Count", ""),
    tag("legacy_disc_number", "TXXX:Disc Number", ""),
    tag("legacy_disc_count", "TXXX:Disc Count", ""),
    tag("legacy_itunesadvisory", "ITUNESADVISORY", ""),
    tag("album_artist_mbids", "DISCOGENIUS_ALBUMARTIST_MBIDS", ""),
    tag("legacy_release_time", "RELEASETIME", ""),
    tag("acoustid_fingerprint", "ACOUSTID_FINGERPRINT", ""),
  ];
}

function desiredTags(mode: "picard" | "plex_jellyfin", various: boolean): ManagedTag[] {
  const plan = various
    ? planAlbumArtistTags({
      creditNames: ["Various Artists", "A"],
      artistNames: ["Various Artists", "A"],
      creditMbids: [VARIOUS_ARTISTS_MBID, A],
      joinPhrases: ["; ", ""],
      sortNames: ["Various Artists", "A, Sort"],
      ownerMbid: A,
      ownerName: "A",
      mode,
      fallbackName: "x",
    })
    : planAlbumArtistTags({
      creditNames: ["A", "B"],
      artistNames: ["A", "B"],
      creditMbids: [A, B],
      joinPhrases: [" & ", ""],
      sortNames: ["A, Sort", "B, Sort"],
      ownerMbid: A,
      ownerName: "A",
      mode,
      fallbackName: "x",
    });
  const tags: ManagedTag[] = [
    tag("title", "title", various ? "Compilation Track" : "Collaboration"),
    tag("artist", "artist", "A & B"),
    tag("artists", "ARTISTS", ["A", "B"].join(MULTI_VALUE_SEPARATOR)),
    tag("album_artist", "album_artist", plan.albumArtist),
    tag("album_artists", "ALBUMARTISTS", plan.creditNames.join(MULTI_VALUE_SEPARATOR)),
    tag("album", "album", various ? "VA Album" : "A & B Album"),
    tag("track", "track", "2/10"),
    tag("track_number", "TRACKNUMBER", "2"),
    tag("track_count", "TRACKTOTAL", "10"),
    tag("disc", "disc", "1/2"),
    tag("disc_number", "DISCNUMBER", "1"),
    tag("disc_count", "DISCTOTAL", "2"),
    tag("date", "date", "2020-01-02"),
    tag("original_date", "original_date", "1999-05-01"),
    tag("original_year", "ORIGINALYEAR", "1999"),
    tag("disc_subtitle", "DISCSUBTITLE", "The Second Disc"),
    tag("label", "LABEL", ["Island", "Virgin"].join(MULTI_VALUE_SEPARATOR)),
    tag("catalog_number", "CATALOGNUMBER", ["ABC-1", "ABC-2"].join(MULTI_VALUE_SEPARATOR)),
    tag("asin", "ASIN", "B000123456"),
    tag("script", "SCRIPT", "Latn"),
    tag("language", "LANGUAGE", "eng"),
    tag("genre", "genre", ["Pop", "Rock"].join(MULTI_VALUE_SEPARATOR)),
    tag("release_type", "release_type", various ? "album; compilation" : "album"),
    tag("musicbrainz_artistid", "musicbrainz_artistid", [A, B].join(MULTI_VALUE_SEPARATOR)),
    tag("musicbrainz_albumartistid", "musicbrainz_albumartistid", plan.albumArtistMbids.join(MULTI_VALUE_SEPARATOR)),
    tag("itunesadvisory", "ITUNESADVISORY", "1"),
    tag("acoustid_id", "ACOUSTID_ID", "2b3c4d5e-6f70-8192-a3b4-c5d6e7f8091a"),
  ];
  if (plan.albumArtistSort) tags.push(tag("album_artist_sort", "ALBUMARTISTSORT", plan.albumArtistSort));
  if (plan.compilation) tags.push(tag("compilation", "COMPILATION", "1"));
  return tags;
}

function readMutagen(filePath: string): Record<string, unknown> {
  const script = `
import json, sys
path = sys.argv[1]
ext = path.rsplit(".", 1)[-1].lower()
def texts(frame):
    text = getattr(frame, "text", None)
    if text is None:
        return None
    return [str(item) for item in text]
if ext in {"flac", "ogg", "opus"}:
    from mutagen.flac import FLAC
    from mutagen.oggopus import OggOpus
    from mutagen.oggvorbis import OggVorbis
    audio = FLAC(path) if ext == "flac" else OggOpus(path) if ext == "opus" else OggVorbis(path)
    # Mutagen lowercases Vorbis names. Picard and TagLib store them in uppercase.
    print(json.dumps({key.upper(): list(values) for key, values in audio.tags.items()}))
elif ext in {"m4a", "mp4"}:
    from mutagen.mp4 import MP4
    audio = MP4(path)
    decoded = {}
    for key, values in (audio.tags or {}).items():
        if isinstance(values, list):
            decoded[key] = [item.decode("utf-8", "replace") if isinstance(item, bytes) else item for item in values]
        else:
            decoded[key] = values
    print(json.dumps(decoded))
else:
    if ext == "wav":
        from mutagen.wave import WAVE
        audio = WAVE(path).tags
    elif ext in {"aiff", "aif"}:
        from mutagen.aiff import AIFF
        audio = AIFF(path).tags
    else:
        from mutagen.id3 import ID3
        audio = ID3(path)
    decoded = {}
    for key, frame in (audio.items() if audio is not None else []):
        value = texts(frame)
        if value is not None:
            decoded[key] = value
    print(json.dumps(decoded))
`;
  const result = spawnSync("python3", ["-c", script, filePath], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function values(tags: Record<string, unknown>, key: string): string[] {
  const value = tags[key];
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item));
}

function assertPicardFields(tags: Record<string, unknown>, extension: string, various: boolean, mode: "picard" | "plex_jellyfin"): void {
  const albumArtist = various ? "Various Artists" : (mode === "picard" ? "A & B" : "A");
  const albumArtists = various ? ["Various Artists", "A"] : ["A", "B"];
  const albumArtistIds = various ? [VARIOUS_ARTISTS_MBID] : (mode === "picard" ? [A, B] : [A]);
  if (extension === ".flac" || extension === ".ogg" || extension === ".opus") {
    assert.deepEqual(values(tags, "ALBUMARTIST"), [albumArtist]);
    assert.deepEqual(values(tags, "ALBUMARTISTS"), albumArtists);
    assert.deepEqual(values(tags, "ARTISTS"), ["A", "B"]);
    assert.deepEqual(values(tags, "ARTIST"), ["A & B"]);
    assert.deepEqual(values(tags, "LABEL"), ["Island", "Virgin"]);
    assert.deepEqual(values(tags, "CATALOGNUMBER"), ["ABC-1", "ABC-2"]);
    assert.deepEqual(values(tags, "MUSICBRAINZ_ARTISTID"), [A, B]);
    assert.deepEqual(values(tags, "MUSICBRAINZ_ALBUMARTISTID"), albumArtistIds);
    assert.deepEqual(values(tags, "ASIN"), ["B000123456"]);
    assert.deepEqual(values(tags, "SCRIPT"), ["Latn"]);
    assert.deepEqual(values(tags, "LANGUAGE"), ["eng"]);
    assert.deepEqual(values(tags, "DISCSUBTITLE"), ["The Second Disc"]);
    assert.deepEqual(values(tags, "ORIGINALDATE"), ["1999-05-01"]);
    assert.deepEqual(values(tags, "ORIGINALYEAR"), ["1999"]);
    assert.deepEqual(values(tags, "DATE"), ["2020-01-02"]);
    assert.deepEqual(values(tags, "TRACKNUMBER"), ["2"]);
    assert.deepEqual(values(tags, "TRACKTOTAL"), ["10"]);
    assert.equal(values(tags, "PROVIDER_URL").length, 0);
    assert.equal(values(tags, "ITUNESADVISORY").length, 0);
    assert.equal(values(tags, "DISCOGENIUS_ALBUMARTIST_MBIDS").length, 0);
    assert.equal(values(tags, "RELEASETIME").length, 0);
    assert.equal(values(tags, "ACOUSTID_FINGERPRINT").length, 0);
    assert.deepEqual(values(tags, "ACOUSTID_ID"), ["2b3c4d5e-6f70-8192-a3b4-c5d6e7f8091a"]);
    assert.deepEqual(values(tags, "DISCOGENIUS_CUSTOM"), ["keep me"]);
    if (various) assert.deepEqual(values(tags, "COMPILATION"), ["1"]);
    else assert.equal(values(tags, "COMPILATION").length, 0);
    return;
  }
  if (extension === ".m4a") {
    assert.deepEqual(values(tags, "aART"), [albumArtist]);
    assert.deepEqual(values(tags, "----:com.apple.iTunes:ALBUMARTISTS"), albumArtists);
    assert.deepEqual(values(tags, "----:com.apple.iTunes:ARTISTS"), ["A", "B"]);
    assert.deepEqual(values(tags, "----:com.apple.iTunes:LABEL"), ["Island", "Virgin"]);
    assert.deepEqual(values(tags, "----:com.apple.iTunes:CATALOGNUMBER"), ["ABC-1", "ABC-2"]);
    assert.deepEqual(values(tags, "----:com.apple.iTunes:MusicBrainz Artist Id"), [A, B]);
    assert.deepEqual(values(tags, "----:com.apple.iTunes:MusicBrainz Album Artist Id"), albumArtistIds);
    assert.deepEqual(values(tags, "----:com.apple.iTunes:ASIN"), ["B000123456"]);
    assert.deepEqual(values(tags, "----:com.apple.iTunes:SCRIPT"), ["Latn"]);
    assert.deepEqual(values(tags, "----:com.apple.iTunes:LANGUAGE"), ["eng"]);
    assert.deepEqual(values(tags, "----:com.apple.iTunes:DISCSUBTITLE"), ["The Second Disc"]);
    assert.deepEqual(values(tags, "----:com.apple.iTunes:originaldate"), ["1999-05-01"]);
    assert.deepEqual(values(tags, "----:com.apple.iTunes:originalyear"), ["1999"]);
    assert.equal(values(tags, "----:com.apple.iTunes:PROVIDER_URL").length, 0);
    assert.equal(values(tags, "----:com.apple.iTunes:ITUNESADVISORY").length, 0);
    assert.equal(values(tags, "----:com.apple.iTunes:Track Number").length, 0);
    assert.equal(values(tags, "----:com.apple.iTunes:DISCOGENIUS_ALBUMARTIST_MBIDS").length, 0);
    assert.equal(values(tags, "----:com.apple.iTunes:RELEASETIME").length, 0);
    assert.equal(values(tags, "----:com.apple.iTunes:Acoustid Fingerprint").length, 0);
    assert.deepEqual(values(tags, "----:com.apple.iTunes:Acoustid Id"), ["2b3c4d5e-6f70-8192-a3b4-c5d6e7f8091a"]);
    assert.deepEqual(values(tags, "----:com.apple.iTunes:DISCOGENIUS_CUSTOM"), ["keep me"]);
    assert.deepEqual(values(tags, "rtng"), ["1"]);
    if (various) assert.equal(tags.cpil, true);
    return;
  }
  assert.deepEqual(values(tags, "TPE2"), [albumArtist]);
  assert.deepEqual(values(tags, "TXXX:ALBUMARTISTS"), albumArtists);
  assert.deepEqual(values(tags, "TXXX:ARTISTS"), ["A", "B"]);
  assert.deepEqual(values(tags, "TPE1"), ["A & B"]);
  assert.deepEqual(values(tags, "TPUB"), ["Island", "Virgin"]);
  assert.deepEqual(values(tags, "TXXX:CATALOGNUMBER"), ["ABC-1", "ABC-2"]);
  assert.deepEqual(values(tags, "TXXX:MusicBrainz Artist Id"), [A, B]);
  assert.deepEqual(values(tags, "TXXX:MusicBrainz Album Artist Id"), albumArtistIds);
  assert.deepEqual(values(tags, "TXXX:ASIN"), ["B000123456"]);
  assert.deepEqual(values(tags, "TXXX:SCRIPT"), ["Latn"]);
  assert.deepEqual(values(tags, "TLAN"), ["eng"]);
  assert.deepEqual(values(tags, "TSST"), ["The Second Disc"]);
  assert.deepEqual(values(tags, "TXXX:originalyear"), ["1999"]);
  assert.deepEqual(values(tags, "TDOR"), ["1999-05-01"]);
  assert.equal(values(tags, "TXXX:PROVIDER_URL").length, 0);
  assert.equal(values(tags, "TXXX:ITUNESADVISORY").length, 0);
  assert.equal(values(tags, "TXXX:Track Number").length, 0);
  assert.equal(values(tags, "TXXX:DISCOGENIUS_ALBUMARTIST_MBIDS").length, 0);
  assert.equal(values(tags, "TXXX:RELEASETIME").length, 0);
  assert.equal(values(tags, "TXXX:Acoustid Fingerprint").length, 0);
  assert.deepEqual(values(tags, "TXXX:Acoustid Id"), ["2b3c4d5e-6f70-8192-a3b4-c5d6e7f8091a"]);
  assert.deepEqual(values(tags, "TXXX:DISCOGENIUS_CUSTOM"), ["keep me"]);
  if (various) assert.deepEqual(values(tags, "TCMP"), ["1"]);
}

for (const format of FORMATS) {
  for (const mode of ["picard", "plex_jellyfin"] as const) {
    for (const various of [false, true]) {
      test(`Picard tags ${format.extension} ${mode} ${various ? "VA" : "collaboration"}`, { skip: !hasFfmpeg }, async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-picard-"));
        try {
          const mediaPath = path.join(tempDir, `sample${format.extension}`);
          generateAudio(mediaPath, format.codec);
          const legacy = AudioTagService.buildAudioTagWriteMap([
            tag("provider_url", "PROVIDER_URL", "https://tidal.example/track"),
            tag("legacy_track_number", "TXXX:Track Number", "1"),
            tag("legacy_track_count", "TXXX:Track Count", "10"),
            tag("legacy_disc_number", "TXXX:Disc Number", "1"),
            tag("legacy_disc_count", "TXXX:Disc Count", "2"),
            tag("legacy_itunesadvisory", "ITUNESADVISORY", "1"),
            tag("album_artist_mbids", "DISCOGENIUS_ALBUMARTIST_MBIDS", `${A}; ${B}`),
            tag("legacy_release_time", "RELEASETIME", "2020-01-02"),
            tag("acoustid_fingerprint", "ACOUSTID_FINGERPRINT", "AQAAAA"),
            tag("acoustid_id", "ACOUSTID_ID", "2b3c4d5e-6f70-8192-a3b4-c5d6e7f8091a"),
            tag("custom", "DISCOGENIUS_CUSTOM", "keep me"),
          ], format.extension);
          const seeded = await writeMediaTagsWithTagLib(mediaPath, legacy);
          assert.equal(seeded.success, true, seeded.error);
          const before = fileHash(mediaPath);
          const written = AudioTagService.buildAudioTagWriteMap(desiredTags(mode, various), format.extension);
          const removed = AudioTagService.buildAudioTagRemovalKeys(removalTags(), format.extension);
          const result = await writeMediaTagsWithTagLib(mediaPath, written, removed);
          assert.equal(result.success, true, result.error);
          assert.notEqual(fileHash(mediaPath), before);
          assertPicardFields(readMutagen(mediaPath), format.extension, various, mode);
        } finally {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      });
    }
  }
}

test("AIFF-C is left unchanged when TagLib cannot open it", { skip: !hasFfmpeg }, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-aifc-"));
  try {
    const mediaPath = path.join(tempDir, "sample.aiff");
    generateAudio(mediaPath, ["-c:a", "pcm_s16le", "-f", "aiff"]);
    assert.equal(fs.readFileSync(mediaPath).subarray(8, 12).toString("ascii"), "AIFC");
    const before = fs.readFileSync(mediaPath);
    const written = await writeMediaTagsWithTagLib(mediaPath, { TIT2: "Half tag" });
    assert.equal(written.success, false);
    assert.deepEqual(fs.readFileSync(mediaPath), before);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("wma, ape, mp2, and alac are not half-tagged", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-untaggable-"));
  try {
    for (const extension of [".wma", ".ape", ".mp2", ".alac"]) {
      const mediaPath = path.join(tempDir, `sample${extension}`);
      fs.writeFileSync(mediaPath, "not audio");
      const wrote = await writeMetadata(mediaPath, { title: "Half tag" });
      assert.equal(wrote, false);
      assert.equal(fs.readFileSync(mediaPath, "utf8"), "not audio");
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
