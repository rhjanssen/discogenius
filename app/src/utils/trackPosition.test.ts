import { describe, expect, it } from "vitest";
import {
  formatDescriptiveTrackPosition,
  formatTrackPositionFrom,
  isMultiVolumeTrackList,
} from "./trackPosition";

describe("trackPosition", () => {
  it("recognizes camelCase, snake_case, and queue volume fields", () => {
    expect(isMultiVolumeTrackList([
      { track_number: 1, volume_number: 1 },
      { trackNumber: 1, volumeNumber: 2 },
    ])).toBe(true);
    expect(isMultiVolumeTrackList([{ trackNum: 1, volumeNum: 1, mediaCount: 2 }])).toBe(true);
    expect(isMultiVolumeTrackList([{ position: 1, medium_position: 1 }])).toBe(false);
  });

  it("formats compact multi-volume positions from the shared API shapes", () => {
    expect(formatTrackPositionFrom(
      { track_number: 4, volume_number: 2 },
      { multiVolume: true },
    )).toBe("2-4");
    expect(formatTrackPositionFrom(
      { trackNum: 3, volumeNum: 1 },
      { multiVolume: false },
    )).toBe("3");
    expect(formatTrackPositionFrom({}, { fallbackIndex: 7 })).toBe("7");
  });

  it("formats one descriptive association label for albums and videos", () => {
    expect(formatDescriptiveTrackPosition({
      track_number: 4,
      volume_number: 1,
      media_count: 2,
    })).toBe("Disc 1 · Track 4");
    expect(formatDescriptiveTrackPosition({
      trackNumber: 4,
      volumeNumber: 1,
      mediaCount: 1,
    })).toBe("Track 4");
    expect(formatDescriptiveTrackPosition({ track_number: null })).toBeNull();
  });
});
