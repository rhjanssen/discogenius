import assert from "node:assert/strict";
import test from "node:test";

import { AudioTagService, type ManagedTag } from "./audio-tag-service.js";

test("audio tag writer expands Lidarr-compatible total aliases", () => {
  const tags: ManagedTag[] = [
    {
      key: "track_count",
      label: "Track Count",
      ffmpegKey: "TRACKTOTAL",
      targetValue: "13",
      writeAliases: ["TOTALTRACKS", "totaltracks"],
    },
    {
      key: "disc_count",
      label: "Disc Count",
      ffmpegKey: "DISCTOTAL",
      targetValue: "3",
      writeAliases: ["TOTALDISCS", "totaldiscs"],
    },
  ];

  assert.deepEqual(AudioTagService.buildAudioTagWriteMap(tags), {
    TRACKTOTAL: "13",
    TOTALTRACKS: "13",
    totaltracks: "13",
    DISCTOTAL: "3",
    TOTALDISCS: "3",
    totaldiscs: "3",
  });
});

test("audio tag writer maps musicbrainz_releasetrackid and writeAliases correctly", () => {
  const tags: ManagedTag[] = [
    {
      key: "musicbrainz_releasetrackid",
      label: "MusicBrainz Release Track ID",
      ffmpegKey: "MUSICBRAINZ_RELEASETRACKID",
      targetValue: "d9b23b3f-1d42-4f7f-a5b6-6e54580bfb9f",
      aliases: [
        "musicbrainz_releasetrackid",
        "musicbrainzreleasetrackid",
        "musicbrainz release track id",
        "MusicBrainz Release Track Id",
      ],
      writeAliases: [
        "musicbrainz_releasetrackid",
        "musicbrainzreleasetrackid",
        "MusicBrainz Release Track Id",
      ],
    },
  ];

  assert.deepEqual(AudioTagService.buildAudioTagWriteMap(tags), {
    MUSICBRAINZ_RELEASETRACKID: "d9b23b3f-1d42-4f7f-a5b6-6e54580bfb9f",
    musicbrainz_releasetrackid: "d9b23b3f-1d42-4f7f-a5b6-6e54580bfb9f",
    musicbrainzreleasetrackid: "d9b23b3f-1d42-4f7f-a5b6-6e54580bfb9f",
    "MusicBrainz Release Track Id": "d9b23b3f-1d42-4f7f-a5b6-6e54580bfb9f",
  });
});

test("disabled ReplayGain embedding plans removal of managed ReplayGain tags", () => {
  assert.deepEqual(
    AudioTagService.buildManagedTagRemovals({ embed_replaygain: false } as any)
      .map((tag: any) => tag.ffmpegKey),
    ["UPC", "EAN", "REPLAYGAIN_TRACK_GAIN", "REPLAYGAIN_TRACK_PEAK"],
  );
});

test("audio tag removal keys use format-specific metadata fields", () => {
  const tags: ManagedTag[] = [{
    key: "replaygain_track_gain",
    label: "ReplayGain Track Gain",
    ffmpegKey: "REPLAYGAIN_TRACK_GAIN",
    targetValue: "",
  }];

  assert.deepEqual(AudioTagService.buildAudioTagRemovalKeys(tags, ".flac"), ["REPLAYGAIN_TRACK_GAIN"]);
  assert.deepEqual(AudioTagService.buildAudioTagRemovalKeys(tags, ".mp3"), ["TXXX:REPLAYGAIN_TRACK_GAIN"]);
  assert.deepEqual(AudioTagService.buildAudioTagRemovalKeys(tags, ".m4a"), ["----:com.apple.iTunes:REPLAYGAIN_TRACK_GAIN"]);
});

test("audio tag writer emits Picard canonical barcode fields", () => {
  const tags: ManagedTag[] = [{
    key: "barcode",
    label: "Barcode",
    ffmpegKey: "BARCODE",
    targetValue: "123456789012",
  }];

  assert.deepEqual(AudioTagService.buildAudioTagWriteMap(tags, ".flac"), { BARCODE: "123456789012" });
  assert.deepEqual(AudioTagService.buildAudioTagWriteMap(tags, ".mp3"), { "TXXX:Barcode": "123456789012" });
  assert.deepEqual(AudioTagService.buildAudioTagWriteMap(tags, ".m4a"), { "----:com.apple.iTunes:Barcode": "123456789012" });
});

test("buildAudioTagWriteMap maps tags correctly for FLAC (.flac)", () => {
  const tags: ManagedTag[] = [
    {
      key: "musicbrainz_recordingid",
      label: "MusicBrainz Recording ID",
      ffmpegKey: "musicbrainz_recordingid",
      targetValue: "rec-id",
    },
    {
      key: "release_type",
      label: "Release Type",
      ffmpegKey: "release_type",
      targetValue: "album; compilation",
    },
    {
      key: "release_country",
      label: "Release Country",
      ffmpegKey: "release_country",
      targetValue: "US",
    }
  ];

  assert.deepEqual(AudioTagService.buildAudioTagWriteMap(tags, ".flac"), {
    MUSICBRAINZ_TRACKID: "rec-id",
    RELEASETYPE: "album; compilation",
    RELEASECOUNTRY: "US",
  });
});

test("buildAudioTagWriteMap maps tags correctly for MP3 (.mp3)", () => {
  const tags: ManagedTag[] = [
    {
      key: "musicbrainz_recordingid",
      label: "MusicBrainz Recording ID",
      ffmpegKey: "musicbrainz_recordingid",
      targetValue: "rec-id",
    },
    {
      key: "release_type",
      label: "Release Type",
      ffmpegKey: "release_type",
      targetValue: "album; compilation",
    },
    {
      key: "release_country",
      label: "Release Country",
      ffmpegKey: "release_country",
      targetValue: "US",
    }
  ];

  assert.deepEqual(AudioTagService.buildAudioTagWriteMap(tags, ".mp3"), {
    "TXXX:MusicBrainz Track Id": "rec-id",
    "TXXX:MusicBrainz Album Type": "album; compilation",
    "TXXX:MusicBrainz Album Release Country": "US",
  });
});

test("buildAudioTagWriteMap maps tags correctly for M4A (.m4a)", () => {
  const tags: ManagedTag[] = [
    {
      key: "musicbrainz_recordingid",
      label: "MusicBrainz Recording ID",
      ffmpegKey: "musicbrainz_recordingid",
      targetValue: "rec-id",
    },
    {
      key: "release_type",
      label: "Release Type",
      ffmpegKey: "release_type",
      targetValue: "album; compilation",
    },
    {
      key: "release_country",
      label: "Release Country",
      ffmpegKey: "release_country",
      targetValue: "US",
    }
  ];

  assert.deepEqual(AudioTagService.buildAudioTagWriteMap(tags, ".m4a"), {
    "----:com.apple.iTunes:MusicBrainz Track Id": "rec-id",
    "----:com.apple.iTunes:MusicBrainz Album Type": "album; compilation",
    "----:com.apple.iTunes:MusicBrainz Album Release Country": "US",
  });
});
