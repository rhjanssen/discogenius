import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  File as TagLibFile,
  Id3v2FrameClassType,
  Id3v2Tag,
  Id3v2UserTextInformationFrame,
  Mpeg4AppleTag,
  ReadStyle,
  TagTypes,
  XiphComment,
} from "node-taglib-sharp";
import {
  clearMediaTagsWithTagLib,
  writeMediaTagsWithTagLib,
} from "./media-tag-io.js";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { windowsHide: true }).status === 0;

test("MP4 text verification retains semicolons and multiline comments and lyrics", { skip: !hasFfmpeg }, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-mp4-text-"));
  try {
    const mediaPath = path.join(tempDir, "sample.m4a");
    generateAudio(mediaPath, ["-c:a", "aac", "-f", "mp4"]);
    const beforeHash = decodedAudioHash(mediaPath);
    const comment = "First observation; second observation.\nA full album review.";
    const lyrics = "First lyric; second lyric\nA final line.";
    const result = await writeMediaTagsWithTagLib(mediaPath, { "©cmt": comment, "©lyr": lyrics, artist: "Artist One; Artist Two" });
    assert.equal(result.success, true, result.error);
    const { parseFile } = await import("music-metadata");
    const metadata = await parseFile(mediaPath);
    assert.equal(metadata.common.comment?.[0]?.text, comment);
    assert.equal(metadata.native.iTunes.find(tag => tag.id === "©lyr")?.value, lyrics);
    assert.equal(decodedAudioHash(mediaPath), beforeHash);
  } finally { fs.rmSync(tempDir, { recursive: true, force: true }); }
});

for (const version of [3, 4]) {
  test(`ISRC values follow Picard's ID3v2.${version} representation`, { skip: !hasFfmpeg }, async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-id3-isrc-"));
    try {
      const mediaPath = path.join(tempDir, "sample.mp3");
      generateAudio(mediaPath, ["-c:a", "libmp3lame", "-id3v2_version", String(version)]);
      const beforeHash = decodedAudioHash(mediaPath);
      const result = await writeMediaTagsWithTagLib(mediaPath, { isrc: "USUM70722793; USUM70809583" });
      assert.equal(result.success, true, result.error);
      const { parseFile } = await import("music-metadata");
      const metadata = await parseFile(mediaPath);
      const native = metadata.native[`ID3v2.${version}`].filter(tag => tag.id === "TSRC").map(tag => tag.value);
      assert.deepEqual(native, ["USUM70722793", "USUM70809583"]);
      if (version === 3) {
        // music-metadata also splits v2.3 native TSRC values on '/'. Check the
        // serialized frame so parsing cannot hide an incorrect representation.
        const bytes = fs.readFileSync(mediaPath);
        const joined = "USUM70722793/USUM70809583";
        assert.ok(bytes.includes(Buffer.from(joined, "utf8")) || bytes.includes(Buffer.from(joined, "utf16le")));
      }
      assert.equal(decodedAudioHash(mediaPath), beforeHash);
    } finally { fs.rmSync(tempDir, { recursive: true, force: true }); }
  });
}

const formats = [
  { extension: ".aac", codec: ["-c:a", "aac", "-f", "adts"] },
  { extension: ".flac", codec: ["-c:a", "flac"] },
  { extension: ".m4a", codec: ["-c:a", "aac", "-f", "mp4"] },
  { extension: ".mp3", codec: ["-c:a", "libmp3lame"] },
  { extension: ".ogg", codec: ["-c:a", "libvorbis"] },
  { extension: ".opus", codec: ["-c:a", "libopus"] },
] as const;

function generateAudio(filePath: string, codec: readonly string[]): void {
  const generated = spawnSync("ffmpeg", [
    "-hide_banner",
    "-loglevel", "error",
    "-y",
    "-f", "lavfi",
    "-i", "sine=frequency=440:sample_rate=48000",
    "-t", "1",
    ...codec,
    filePath,
  ], { windowsHide: true, encoding: "utf-8" });
  assert.equal(generated.status, 0, generated.stderr);
}

function decodedAudioHash(filePath: string): string {
  const result = spawnSync("ffmpeg", [
    "-hide_banner",
    "-loglevel", "error",
    "-i", filePath,
    "-map", "0:a:0",
    "-f", "hash",
    "-hash", "md5",
    "-",
  ], { windowsHide: true, encoding: "utf-8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function formatTags(extension: string): Record<string, string> {
  if (extension === ".flac" || extension === ".ogg" || extension === ".opus") {
    return {
      TITLE: "Canonical title",
      ARTIST: "Bastille",
      MUSICBRAINZ_TRACKID: "recording-mbid",
      REPLAYGAIN_TRACK_GAIN: "-8.00 dB",
      LYRICS: "A lyric line",
      DISCOGENIUS_CUSTOM: "preserve me",
    };
  }
  if (extension === ".mp3" || extension === ".aac") {
    return {
      title: "Canonical title",
      artist: "Bastille",
      "TXXX:MusicBrainz Track Id": "recording-mbid",
      "TXXX:REPLAYGAIN_TRACK_GAIN": "-8.00 dB",
      "lyrics-eng": "A lyric line",
      "TXXX:DISCOGENIUS_CUSTOM": "preserve me",
    };
  }
  return {
    title: "Canonical title",
    artist: "Bastille",
    "----:com.apple.iTunes:MusicBrainz Track Id": "recording-mbid",
    "----:com.apple.iTunes:REPLAYGAIN_TRACK_GAIN": "-8.00 dB",
    "lyrics-eng": "A lyric line",
    "----:com.apple.iTunes:DISCOGENIUS_CUSTOM": "preserve me",
  };
}

function readCustomValue(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  const file = TagLibFile.createFromPath(filePath, undefined, ReadStyle.None);
  try {
    if (extension === ".flac" || extension === ".ogg" || extension === ".opus") {
      return (file.getTag(TagTypes.Xiph, false) as XiphComment)
        .getFieldFirstValue("DISCOGENIUS_CUSTOM") ?? "";
    }
    if (extension === ".mp3" || extension === ".aac") {
      const tag = file.getTag(TagTypes.Id3v2, false) as Id3v2Tag;
      const frames = tag.getFramesByClassType<Id3v2UserTextInformationFrame>(
        Id3v2FrameClassType.UserTextInformationFrame,
      );
      return Id3v2UserTextInformationFrame.findUserTextInformationFrame(
        frames,
        "DISCOGENIUS_CUSTOM",
        false,
      )?.text?.[0] ?? "";
    }
    return (file.getTag(TagTypes.Apple, false) as Mpeg4AppleTag)
      .getFirstItunesString("com.apple.iTunes", "DISCOGENIUS_CUSTOM") ?? "";
  } finally {
    file.dispose();
  }
}

test("TagLib writes and strips real supported formats without changing decoded audio", {
  skip: !hasFfmpeg,
}, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-taglib-formats-"));
  try {
    for (const format of formats) {
      const filePath = path.join(tempDir, `sample${format.extension}`);
      generateAudio(filePath, format.codec);
      const beforeHash = decodedAudioHash(filePath);

      const write = await writeMediaTagsWithTagLib(filePath, formatTags(format.extension));
      assert.deepEqual(write, { handled: true, success: true, backend: "taglib" });
      assert.equal(decodedAudioHash(filePath), beforeHash, `${format.extension} decoded audio changed`);

      const tagged = TagLibFile.createFromPath(filePath, undefined, ReadStyle.None);
      try {
        assert.equal(tagged.tag.title, "Canonical title");
        assert.deepEqual(tagged.tag.performers, ["Bastille"]);
        assert.equal(tagged.tag.lyrics, "A lyric line");
      } finally {
        tagged.dispose();
      }
      assert.equal(readCustomValue(filePath), "preserve me");

      const secondWrite = await writeMediaTagsWithTagLib(filePath, { title: "Updated title" });
      assert.equal(secondWrite.success, true);
      assert.equal(readCustomValue(filePath), "preserve me", `${format.extension} custom tag was lost`);
      assert.equal(decodedAudioHash(filePath), beforeHash, `${format.extension} audio changed on second write`);

      const cleared = await clearMediaTagsWithTagLib(filePath);
      assert.equal(cleared.success, true);
      const stripped = TagLibFile.createFromPath(filePath, undefined, ReadStyle.None);
      try {
        assert.equal(stripped.tag.title || "", "");
        assert.deepEqual(stripped.tag.performers, []);
        assert.equal(stripped.tag.lyrics || "", "");
      } finally {
        stripped.dispose();
      }
      assert.equal(readCustomValue(filePath), "", `${format.extension} custom tag was not stripped`);
      assert.equal(decodedAudioHash(filePath), beforeHash, `${format.extension} audio changed on strip`);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("TagLib writes E-AC-3 MP4 metadata without changing encoded audio", {
  skip: !hasFfmpeg,
}, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-taglib-eac3-"));
  const filePath = path.join(tempDir, "spatial-like.m4a");
  const keyedMetadataPath = path.join(tempDir, "keyed-metadata.m4a");
  try {
    const generated = spawnSync("ffmpeg", [
      "-hide_banner",
      "-loglevel", "error",
      "-y",
      "-f", "lavfi",
      "-i", "anullsrc=channel_layout=5.1:sample_rate=48000",
      "-t", "1",
      "-c:a", "eac3",
      "-b:a", "768k",
      "-f", "mp4",
      filePath,
    ], { windowsHide: true, encoding: "utf-8" });
    assert.equal(generated.status, 0, generated.stderr);
    const beforeHash = decodedAudioHash(filePath);

    const write = await writeMediaTagsWithTagLib(filePath, formatTags(".m4a"));
    assert.deepEqual(write, { handled: true, success: true, backend: "taglib" });
    assert.equal(decodedAudioHash(filePath), beforeHash);
    assert.equal(readCustomValue(filePath), "preserve me");

    const cleared = await clearMediaTagsWithTagLib(filePath);
    assert.equal(cleared.success, true);
    assert.equal(decodedAudioHash(filePath), beforeHash);

    const keyedMetadata = spawnSync("ffmpeg", [
      "-hide_banner",
      "-loglevel", "error",
      "-y",
      "-f", "lavfi",
      "-i", "sine=frequency=440:sample_rate=48000",
      "-t", "1",
      "-c:a", "aac",
      "-metadata", "MUSICBRAINZ_TRACKID=recording-mbid",
      "-movflags", "use_metadata_tags",
      "-f", "mp4",
      keyedMetadataPath,
    ], { windowsHide: true, encoding: "utf-8" });
    assert.equal(keyedMetadata.status, 0, keyedMetadata.stderr);
    assert.deepEqual(
      await writeMediaTagsWithTagLib(keyedMetadataPath, formatTags(".m4a")),
      { handled: false, success: false },
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("unvalidated QuickTime-family extensions stay on the compatibility backend", async () => {
  assert.deepEqual(
    await writeMediaTagsWithTagLib("sample.m4v", { title: "Canonical title" }),
    { handled: false, success: false },
  );
  assert.deepEqual(
    await clearMediaTagsWithTagLib("sample.mov"),
    { handled: false, success: false },
  );
});

test("a failed TagLib write leaves the original file byte-for-byte intact", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-taglib-atomicity-"));
  const filePath = path.join(tempDir, "invalid.flac");
  const original = Buffer.from("not a FLAC file");
  fs.writeFileSync(filePath, original);
  try {
    const result = await writeMediaTagsWithTagLib(filePath, { TITLE: "Should fail" });
    assert.equal(result.handled, true);
    assert.equal(result.success, false);
    assert.deepEqual(fs.readFileSync(filePath), original);
    assert.deepEqual(
      fs.readdirSync(tempDir).sort(),
      ["invalid.flac"],
      "failed writes must clean working copies and backups",
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("TagLib work files do not exceed the filesystem name limit for long media names", {
  skip: !hasFfmpeg,
}, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-taglib-long-name-"));
  const filePath = path.join(tempDir, `${"long-title-".repeat(20)}video.m4a`);
  try {
    generateAudio(filePath, ["-c:a", "aac", "-f", "mp4"]);
    const beforeHash = decodedAudioHash(filePath);

    assert.deepEqual(
      await writeMediaTagsWithTagLib(filePath, { title: "Long but valid title" }),
      { handled: true, success: true, backend: "taglib" },
    );
    assert.equal(decodedAudioHash(filePath), beforeHash);
    assert.deepEqual(fs.readdirSync(tempDir), [path.basename(filePath)]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("M4A ISRC writes retain the Apple code when it belongs to the complete canonical list", {
  skip: !hasFfmpeg,
}, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-m4a-isrc-"));
  try {
    const filePath = path.join(tempDir, "sample.m4a");
    generateAudio(filePath, ["-c:a", "aac", "-f", "mp4"]);
    const file = TagLibFile.createFromPath(filePath, undefined, ReadStyle.None);
    try {
      const tag = file.getTag(TagTypes.Apple, true) as Mpeg4AppleTag;
      tag.setItunesStrings("com.apple.iTunes", "ISRC", "USUM70809583");
      file.save();
    } finally { file.dispose(); }
    const beforeHash = decodedAudioHash(filePath);
    assert.equal((await writeMediaTagsWithTagLib(filePath, { isrc: "USUM70722793; USUM70809583" })).success, true);
    const { parseFile } = await import("music-metadata");
    assert.deepEqual((await parseFile(filePath)).common.isrc, ["USUM70722793", "USUM70809583"]);
    assert.equal(decodedAudioHash(filePath), beforeHash);
  } finally { fs.rmSync(tempDir, { recursive: true, force: true }); }
});
