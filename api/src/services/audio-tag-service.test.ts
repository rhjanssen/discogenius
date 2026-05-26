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
