import assert from "node:assert/strict";
import test from "node:test";

import {
  AudioTagService,
  buildEmbeddedLyricsManagedTag,
  getCurrentTagValue,
  isAudioTagMaintenanceEnabled,
  isTagValueEqual,
  selectEmbeddedLyricsText,
  type ManagedTag,
} from "./audio-tag-service.js";

test("audio tag maintenance includes cover-only work and permits a true no-op policy", () => {
  const metadata = {
    write_audio_tags_policy: "no",
    embed_replaygain: false,
    enable_fingerprinting: false,
  } as any;

  assert.equal(isAudioTagMaintenanceEnabled(metadata, { embed_cover: true } as any), true);
  assert.equal(isAudioTagMaintenanceEnabled(metadata, { embed_cover: false } as any), false);
});

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
    TDOR: "2024-10-25",
    TMED: "Digital Media",
  });
});

test("getCurrentTagValue extracts all managed tags from common and native metadata", () => {
  const metadata = {
    common: {
      title: "How Dare You",
      artist: "10cc",
      albumartist: "10cc",
      album: "How Dare You!",
      track: { no: 1, of: 10 },
      disk: { no: 1, of: 1 },
      date: "1976-01-01",
      originaldate: "1976-01-01",
      genre: ["Rock", "Art Rock", "Pop Rock"],
      barcode: "042283449323",
      label: ["Mercury", "Phonogram"],
      media: "Digital Media",
      comment: [{ text: "Classic album" }],
      releasecountry: "US",
      releasestatus: "Official",
      releasetype: ["album"],
      musicbrainz_recordingid: "rec-123",
      musicbrainz_albumid: "rel-456",
      musicbrainz_artistid: "art-789",
      musicbrainz_albumartistid: "art-789",
      musicbrainz_releasegroupid: "rg-101",
      musicbrainz_releasetrackid: "trk-202",
      isrc: "GBAYE7500001",
      copyright: "(P) 1976 Phonogram Ltd.",
    },
    native: {},
    format: {},
    quality: { warnings: [] },
  } as any;
  const lookup = new Map<string, string>();

  assert.equal(getCurrentTagValue(metadata, lookup, { key: "title", label: "Title", ffmpegKey: "title", targetValue: "" }), "How Dare You");
  assert.equal(getCurrentTagValue(metadata, lookup, { key: "artist", label: "Artist", ffmpegKey: "artist", targetValue: "" }), "10cc");
  assert.equal(getCurrentTagValue(metadata, lookup, { key: "album_artist", label: "Album Artist", ffmpegKey: "album_artist", targetValue: "" }), "10cc");
  assert.equal(getCurrentTagValue(metadata, lookup, { key: "album", label: "Album", ffmpegKey: "album", targetValue: "" }), "How Dare You!");
  assert.equal(getCurrentTagValue(metadata, lookup, { key: "track", label: "Track", ffmpegKey: "track", targetValue: "" }), "1/10");
  assert.equal(getCurrentTagValue(metadata, lookup, { key: "disc", label: "Disc", ffmpegKey: "disc", targetValue: "" }), "1/1");
  assert.equal(getCurrentTagValue(metadata, lookup, { key: "date", label: "Date", ffmpegKey: "date", targetValue: "" }), "1976-01-01");
  assert.equal(getCurrentTagValue(metadata, lookup, { key: "original_date", label: "Original Date", ffmpegKey: "originaldate", targetValue: "" }), "1976-01-01");
  assert.equal(getCurrentTagValue(metadata, lookup, { key: "genre", label: "Genre", ffmpegKey: "genre", targetValue: "" }), "Rock / Art Rock / Pop Rock");
  assert.equal(getCurrentTagValue(metadata, lookup, { key: "barcode", label: "Barcode", ffmpegKey: "barcode", targetValue: "" }), "042283449323");
  assert.equal(getCurrentTagValue(metadata, lookup, { key: "label", label: "Label", ffmpegKey: "label", targetValue: "" }), "Mercury");
  assert.equal(getCurrentTagValue(metadata, lookup, { key: "media_format", label: "Media Format", ffmpegKey: "media_format", targetValue: "" }), "Digital Media");
  assert.equal(getCurrentTagValue(metadata, lookup, { key: "comment", label: "Comment", ffmpegKey: "comment", targetValue: "" }), "Classic album");
  assert.equal(getCurrentTagValue(metadata, lookup, { key: "release_country", label: "Release Country", ffmpegKey: "release_country", targetValue: "" }), "US");
  assert.equal(getCurrentTagValue(metadata, lookup, { key: "release_status", label: "Release Status", ffmpegKey: "release_status", targetValue: "" }), "official");
  assert.equal(getCurrentTagValue(metadata, lookup, { key: "release_type", label: "Release Type", ffmpegKey: "release_type", targetValue: "" }), "album");
  assert.equal(getCurrentTagValue(metadata, lookup, { key: "musicbrainz_recordingid", label: "MusicBrainz Recording ID", ffmpegKey: "musicbrainz_recordingid", targetValue: "" }), "rec-123");
  assert.equal(getCurrentTagValue(metadata, lookup, { key: "musicbrainz_albumid", label: "MusicBrainz Release ID", ffmpegKey: "musicbrainz_albumid", targetValue: "" }), "rel-456");
  assert.equal(getCurrentTagValue(metadata, lookup, { key: "musicbrainz_artistid", label: "MusicBrainz Artist ID", ffmpegKey: "musicbrainz_artistid", targetValue: "" }), "art-789");
  assert.equal(getCurrentTagValue(metadata, lookup, { key: "musicbrainz_releasegroupid", label: "MusicBrainz Release Group ID", ffmpegKey: "musicbrainz_releasegroupid", targetValue: "" }), "rg-101");
  assert.equal(getCurrentTagValue(metadata, lookup, { key: "musicbrainz_releasetrackid", label: "MusicBrainz Release Track ID", ffmpegKey: "musicbrainz_releasetrackid", targetValue: "" }), "trk-202");
  assert.equal(getCurrentTagValue(metadata, lookup, { key: "isrc", label: "ISRC", ffmpegKey: "isrc", targetValue: "" }), "GBAYE7500001");
  assert.equal(getCurrentTagValue(metadata, lookup, { key: "copyright", label: "Copyright", ffmpegKey: "copyright", targetValue: "" }), "(P) 1976 Phonogram Ltd.");
});

test("isTagValueEqual compares multi-value tags and dates with semantic tolerance", () => {
  // Equal strings
  assert.equal(isTagValueEqual("title", "Song Title", "Song Title"), true);
  assert.equal(isTagValueEqual("title", "Song Title", "Different Title"), false);

  // Genre delimiters
  assert.equal(isTagValueEqual("genre", "Rock / Pop Rock", "Rock, Pop Rock"), true);
  assert.equal(isTagValueEqual("genre", "Rock; Pop Rock", "Rock / Pop Rock"), true);
  assert.equal(isTagValueEqual("genre", "Rock / Pop", "Pop / Rock"), true);

  // Date normalization
  assert.equal(isTagValueEqual("date", "2016-04-29", "2016-04-29"), true);
  assert.equal(isTagValueEqual("original_date", "2016-04-29", "2016-04-29"), true);
  assert.equal(isTagValueEqual("original_date", "2016-04-29", "2015-04-29"), false);

  // Year-only container match (e.g. ID3v2.3 TYER/TORY)
  assert.equal(isTagValueEqual("date", "2012", "2012-02-17"), true);
  assert.equal(isTagValueEqual("date", "2012-02-17", "2012"), true);
  assert.equal(isTagValueEqual("original_date", "2012", "2012-02-17"), true);
  assert.equal(isTagValueEqual("original_date", "2015", "2012-02-17"), false);

  // itunesadvisory numeric equality
  assert.equal(isTagValueEqual("itunesadvisory", "0", "0"), true);
  assert.equal(isTagValueEqual("itunesadvisory", "1", "1"), true);
  assert.equal(isTagValueEqual("itunesadvisory", "0", "1"), false);

  // replaygain float tolerance
  assert.equal(isTagValueEqual("replaygain_track_gain", "-7.31 dB", "-7.32 dB"), true);
  assert.equal(isTagValueEqual("replaygain_track_gain", "-7.31 dB", "-8.00 dB"), false);
  assert.equal(isTagValueEqual("replaygain_track_peak", "0.967717", "0.97"), true);

  // comment newline normalization
  assert.equal(isTagValueEqual("comment", "Line1\r\nLine2", "Line1\nLine2"), true);

  // release_country matching
  assert.equal(isTagValueEqual("release_country", "US", "us"), true);
  assert.equal(isTagValueEqual("release_country", "US", "US, CA"), true);
});

test("buildAudioTagWriteMap maps comment, itunesadvisory, and replaygain across formats", () => {
  const tags: ManagedTag[] = [
    { key: "comment", label: "Comment", ffmpegKey: "comment", targetValue: "My review" },
    { key: "itunesadvisory", label: "iTunes Advisory", ffmpegKey: "ITUNESADVISORY", targetValue: "1" },
    { key: "replaygain_track_gain", label: "Gain", ffmpegKey: "REPLAYGAIN_TRACK_GAIN", targetValue: "-7.31 dB" },
    { key: "replaygain_track_peak", label: "Peak", ffmpegKey: "REPLAYGAIN_TRACK_PEAK", targetValue: "0.967717" },
  ];

  assert.deepEqual(AudioTagService.buildAudioTagWriteMap(tags, ".flac"), {
    COMMENT: "My review",
    ITUNESADVISORY: "1",
    REPLAYGAIN_TRACK_GAIN: "-7.31 dB",
    REPLAYGAIN_TRACK_PEAK: "0.967717",
  });

  assert.deepEqual(AudioTagService.buildAudioTagWriteMap(tags, ".mp3"), {
    comment: "My review",
    "TXXX:ITUNESADVISORY": "1",
    "TXXX:REPLAYGAIN_TRACK_GAIN": "-7.31 dB",
    "TXXX:REPLAYGAIN_TRACK_PEAK": "0.967717",
  });

  assert.deepEqual(AudioTagService.buildAudioTagWriteMap(tags, ".m4a"), {
    "©cmt": "My review",
    rtng: "1",
    "----:com.apple.iTunes:REPLAYGAIN_TRACK_GAIN": "-7.31 dB",
    "----:com.apple.iTunes:REPLAYGAIN_TRACK_PEAK": "0.967717",
  });

  assert.deepEqual(AudioTagService.buildAudioTagWriteMap(tags, ".wma"), {
    Description: "My review",
    "WM/ContentAdvisoryRating": "1",
    "WM/ReplayGainTrackGain": "-7.31 dB",
    "WM/ReplayGainTrackPeak": "0.967717",
  });
});

