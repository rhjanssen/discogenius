import { describe, expect, it } from "vitest";
import { isVideoResolutionQuality, qualityDescription, stereoQualityTier, videoResolutionLabel } from "./qualityTier";

describe("stereoQualityTier", () => {
  it("maps hi-res lossless variants to MAX", () => {
    for (const q of ["HIRES_LOSSLESS", "HI_RES_LOSSLESS", "hires_lossless", "MQA", "MASTER", "MAX"]) {
      expect(stereoQualityTier(q)).toBe("MAX");
    }
  });

  it("maps CD-quality lossless to HIGH", () => {
    for (const q of ["LOSSLESS", "FLAC", "ALAC", "flac"]) {
      expect(stereoQualityTier(q)).toBe("HIGH");
    }
  });

  it("maps standard lossy tiers (256-320 kbps) to NORMAL", () => {
    for (const q of ["HIGH", "AAC", "MP3_320", "NORMAL", "OGG_VORBIS", "VERY_HIGH", "AAC_256"]) {
      expect(stereoQualityTier(q)).toBe("NORMAL");
    }
  });

  it("maps explicit low-bitrate lossy to LOW, including YouTube (yt-dlp ~160 kbps Opus, no Premium)", () => {
    for (const q of ["LOW", "MP3_128", "MP3_96", "AAC_96", "OPUS_LOW", "YOUTUBE_LOSSY", "youtube_lossy"]) {
      expect(stereoQualityTier(q)).toBe("LOW");
    }
  });

  it("defaults unknown/empty values to NORMAL rather than leaking a raw string", () => {
    expect(stereoQualityTier("")).toBe("NORMAL");
    expect(stereoQualityTier(null)).toBe("NORMAL");
    expect(stereoQualityTier(undefined)).toBe("NORMAL");
    expect(stereoQualityTier("SOME_UNKNOWN_TAG")).toBe("NORMAL");
  });

  it("does not misclassify lossless as low just because a bitrate marker appears elsewhere", () => {
    expect(stereoQualityTier("FLAC")).toBe("HIGH");
    expect(stereoQualityTier("HIRES_LOSSLESS")).toBe("MAX");
  });
});

describe("video resolution helpers", () => {
  it("detects video resolution qualities", () => {
    expect(isVideoResolutionQuality("MP4_1080P")).toBe(true);
    expect(isVideoResolutionQuality("2160P")).toBe(true);
    expect(isVideoResolutionQuality("720p")).toBe(true);
    expect(isVideoResolutionQuality("FHD")).toBe(true);
    expect(isVideoResolutionQuality("4K")).toBe(true);
    expect(isVideoResolutionQuality("LOSSLESS")).toBe(false);
    expect(isVideoResolutionQuality("DOLBY_ATMOS")).toBe(false);
  });

  it("labels resolutions without the MP4_ prefix", () => {
    expect(videoResolutionLabel("MP4_1080P")).toBe("1080p");
    expect(videoResolutionLabel("2160P")).toBe("2160p");
    expect(videoResolutionLabel("FHD")).toBe("1080p");
    expect(videoResolutionLabel("4K")).toBe("2160p");
  });
});

describe("qualityDescription", () => {
  it("describes each tier with a bitrate/format range", () => {
    expect(qualityDescription("HIRES_LOSSLESS")).toMatch(/24-bit/);
    expect(qualityDescription("LOSSLESS")).toMatch(/16-bit|CD quality/);
    expect(qualityDescription("MP3_320")).toMatch(/256.?320/);
    expect(qualityDescription("YOUTUBE_LOSSY")).toMatch(/96.?160/);
  });

  it("describes spatial and video qualities distinctly", () => {
    expect(qualityDescription("DOLBY_ATMOS")).toMatch(/Atmos/);
    expect(qualityDescription("MP4_1080P")).toMatch(/Video/);
  });
});
