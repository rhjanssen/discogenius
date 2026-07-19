import { describe, expect, it } from "vitest";
import { orderedQualityTags } from "./qualityTags";

describe("orderedQualityTags", () => {
  it("deduplicates provider-native values that render as the same neutral tier", () => {
    expect(orderedQualityTags({
      qualityTags: ["HIRES_LOSSLESS", "MAX", "LOSSLESS", "FLAC", "AAC_256"],
    })).toEqual(["HIRES_LOSSLESS", "LOSSLESS", "AAC_256"]);
  });

  it("keeps stereo before distinct spatial formats", () => {
    expect(orderedQualityTags({
      qualityTags: ["DOLBY_ATMOS", "FLAC", "SONY_360RA", "SPATIAL"],
    })).toEqual(["FLAC", "DOLBY_ATMOS", "SONY_360RA"]);
  });

  it("deduplicates equivalent video resolution spellings", () => {
    expect(orderedQualityTags({ qualityTags: ["MP4_1080P", "1080p", "FHD", "2160P"] }))
      .toEqual(["MP4_1080P", "2160P"]);
  });
});
