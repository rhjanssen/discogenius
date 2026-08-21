import assert from "node:assert/strict";
import test from "node:test";

import {
  AudioTagService,
  buildEmbeddedLyricsManagedTag,
  getCurrentTagValue,
  selectEmbeddedLyricsText,
  type ManagedTag,
} from "./audio-tag-service.js";

test("embedded lyrics prefer synced subtitles with plain text fallback", () => {
  assert.equal(selectEmbeddedLyricsText({
    subtitles: "[00:01.00]Synced line",
    text: "Plain line",
  }), "[00:01.00]Synced line");
  assert.equal(selectEmbeddedLyricsText({
    subtitles: "",
    text: "Plain line",
  }), "Plain line");
  assert.equal(selectEmbeddedLyricsText({
    subtitles: "Timestamp-free subtitle field",
    text: "Canonical plain line",
  }), "Canonical plain line");
});

test("audio tag writer expands total aliases", () => {
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
  assert.deepEqual(AudioTagService.buildAudioTagRemovalKeys(tags, ".mp3"), ["TXXX:REPLAYGAIN_TRACK_GAIN", "REPLAYGAIN_TRACK_GAIN"]);
  assert.deepEqual(AudioTagService.buildAudioTagRemovalKeys(tags, ".m4a"), ["----:com.apple.iTunes:REPLAYGAIN_TRACK_GAIN", "REPLAYGAIN_TRACK_GAIN"]);
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

test("audio tag writer emits genre and label fields for common formats", () => {
  const tags: ManagedTag[] = [
    {
      key: "genre",
      label: "Genre",
      ffmpegKey: "genre",
      targetValue: "Indie Rock / Alternative",
    },
    {
      key: "label",
      label: "Label",
      ffmpegKey: "LABEL",
      targetValue: "Canonical Label",
    },
  ];

  assert.deepEqual(AudioTagService.buildAudioTagWriteMap(tags, ".flac"), {
    GENRE: "Indie Rock / Alternative",
    LABEL: "Canonical Label",
  });
  assert.deepEqual(AudioTagService.buildAudioTagWriteMap(tags, ".mp3"), {
    genre: "Indie Rock / Alternative",
    publisher: "Canonical Label",
  });
  assert.deepEqual(AudioTagService.buildAudioTagWriteMap(tags, ".m4a"), {
    genre: "Indie Rock / Alternative",
    "----:com.apple.iTunes:LABEL": "Canonical Label",
  });
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

test("resolved sidecar lyrics become the managed embedded-lyrics tag", () => {
  assert.deepEqual(buildEmbeddedLyricsManagedTag({
    subtitles: "[00:01.00]Synced line",
    text: "Plain line",
  }), {
    key: "lyrics",
    label: "Lyrics",
    ffmpegKey: "lyrics-eng",
    targetValue: "[00:01.00]Synced line",
    aliases: ["lyrics", "LYRICS", "unsyncedlyrics"],
  });
  assert.equal(buildEmbeddedLyricsManagedTag(null), null);
});

test("lyrics verification reads the native LYRICS tag, not music-metadata timed objects", () => {
  const lyricTag = buildEmbeddedLyricsManagedTag({
    subtitles: "[00:00.11] This is a song my heart does sing",
    text: "This is a song my heart does sing",
  });
  assert.ok(lyricTag);
  const lookup = new Map([
    ["lyrics", "[00:00.11] This is a song my heart does sing"],
  ]);
  const metadata = {
    common: {
      lyrics: [{ text: "This is a song my heart does sing", time: 0.11 }],
    },
    native: {},
    format: {},
    quality: { warnings: [] },
  } as any;
  assert.equal(
    getCurrentTagValue(metadata, lookup, lyricTag),
    "[00:00.11] This is a song my heart does sing",
  );
});

test("plain txt sidecar lyrics remain plain when reused for the embedded tag", () => {
  assert.deepEqual(buildEmbeddedLyricsManagedTag({
    subtitles: "",
    text: "Plain line without a timestamp",
  }), {
    key: "lyrics",
    label: "Lyrics",
    ffmpegKey: "lyrics-eng",
    targetValue: "Plain line without a timestamp",
    aliases: ["lyrics", "LYRICS", "unsyncedlyrics"],
  });
});

test("buildAudioTagWriteMap accepts database extensions without a leading dot", () => {
  const tags: ManagedTag[] = [{
    key: "musicbrainz_recordingid",
    label: "MusicBrainz Recording ID",
    ffmpegKey: "musicbrainz_recordingid",
    targetValue: "recording-id",
  }];
  assert.deepEqual(AudioTagService.buildAudioTagWriteMap(tags, "m4a"), AudioTagService.buildAudioTagWriteMap(tags, ".m4a"));
  assert.deepEqual(AudioTagService.buildAudioTagWriteMap(tags, "mp4"), AudioTagService.buildAudioTagWriteMap(tags, ".mp4"));
});

test("buildAudioTagWriteMap maps .opus like FLAC/Vorbis (Ogg-container Vorbis comments)", () => {
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

  assert.deepEqual(AudioTagService.buildAudioTagWriteMap(tags, ".opus"), {
    MUSICBRAINZ_TRACKID: "rec-id",
    RELEASETYPE: "album; compilation",
    RELEASECOUNTRY: "US",
  });
});

test("buildAudioTagWriteMap maps tags correctly for WMA/ASF (.wma)", () => {
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

  assert.deepEqual(AudioTagService.buildAudioTagWriteMap(tags, ".wma"), {
    "MusicBrainz/Track Id": "rec-id",
    "MusicBrainz/Album Type": "album; compilation",
    "MusicBrainz/Album Release Country": "US",
  });
});

test("buildAudioTagWriteMap maps tags correctly for APE (.ape)", () => {
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

  assert.deepEqual(AudioTagService.buildAudioTagWriteMap(tags, ".ape"), {
    MUSICBRAINZ_TRACKID: "rec-id",
    RELEASETYPE: "album; compilation",
    RELEASECOUNTRY: "US",
  });
});

test("buildAudioTagWriteMap expands release_type writeAliases for FLAC/Vorbis", () => {
  const tags: ManagedTag[] = [
    {
      key: "release_type",
      label: "Release Type",
      ffmpegKey: "release_type",
      targetValue: "album; live",
      writeAliases: [
        "RELEASETYPE",
        "MUSICBRAINZ_ALBUMTYPE",
      ],
    },
  ];

  assert.deepEqual(AudioTagService.buildAudioTagWriteMap(tags, ".flac"), {
    RELEASETYPE: "album; live",
  });

  // Without extension (generic fallback), both writeAliases are emitted:
  assert.deepEqual(AudioTagService.buildAudioTagWriteMap(tags), {
    release_type: "album; live",
    RELEASETYPE: "album; live",
    MUSICBRAINZ_ALBUMTYPE: "album; live",
  });
});

test("buildAudioTagWriteMap maps original_date and media_format across formats", () => {
  const tags: ManagedTag[] = [
    {
      key: "original_date",
      label: "Original Release Date",
      ffmpegKey: "original_date",
      targetValue: "2024-10-25",
    },
    {
      key: "media_format",
      label: "Media Format",
      ffmpegKey: "media_format",
      targetValue: "Digital Media",
    },
  ];

  assert.deepEqual(AudioTagService.buildAudioTagWriteMap(tags, ".flac"), {
    ORIGINALDATE: "2024-10-25",
    MEDIA: "Digital Media",
  });

  assert.deepEqual(AudioTagService.buildAudioTagWriteMap(tags, ".mp3"), {
    "TXXX:Original Release Date": "2024-10-25",
    TMED: "Digital Media",
  });
});
