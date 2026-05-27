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

