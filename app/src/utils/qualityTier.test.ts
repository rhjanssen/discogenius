import { describe, expect, it } from "vitest";
import {
  isUnknownQualityTag,
  isVideoResolutionQuality,
  qualityDescription,
  stereoQualityTier,
  videoCapabilityLabel,
  videoQualityTier,
  videoResolutionLabel,
  videoTierFromMaxHeight,
} from "./qualityTier";

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
    expect(isVideoResolutionQuality("480p")).toBe(true);
    expect(isVideoResolutionQuality("FHD")).toBe(true);
    expect(isVideoResolutionQuality("4K")).toBe(true);
    expect(isVideoResolutionQuality("UHD")).toBe(true);
    expect(isVideoResolutionQuality("SD")).toBe(true);
    expect(isVideoResolutionQuality("LOSSLESS")).toBe(false);
    expect(isVideoResolutionQuality("DOLBY_ATMOS")).toBe(false);
    expect(isVideoResolutionQuality("SOURCE")).toBe(false);
  });

  it("maps resolutions onto SD / HD / FHD / UHD badge labels", () => {
    expect(videoQualityTier("MP4_1080P")).toBe("FHD");
    expect(videoQualityTier("2160P")).toBe("UHD");
    expect(videoQualityTier("720p")).toBe("HD");
    expect(videoQualityTier("480p")).toBe("SD");
    expect(videoQualityTier("MP4_360P")).toBe("SD");
    expect(videoQualityTier("FHD")).toBe("FHD");
    expect(videoQualityTier("4K")).toBe("UHD");
    expect(videoQualityTier("SD")).toBe("SD");
    expect(videoResolutionLabel("MP4_1080P")).toBe("FHD");
    expect(videoResolutionLabel("2160P")).toBe("UHD");
    expect(videoResolutionLabel("FHD")).toBe("FHD");
    expect(videoResolutionLabel("4K")).toBe("UHD");
    expect(videoResolutionLabel("480p")).toBe("SD");
  });

  it("treats SOURCE as unknown, not a stereo NORMAL stand-in", () => {
    expect(isUnknownQualityTag("SOURCE")).toBe(true);
    expect(videoQualityTier("SOURCE")).toBeNull();
    expect(isVideoResolutionQuality("SOURCE")).toBe(false);
    expect(qualityDescription("SOURCE")).toMatch(/unknown/i);
  });

  it("derives capability copy from max height", () => {
    expect(videoTierFromMaxHeight(2160)).toBe("UHD");
    expect(videoTierFromMaxHeight(1080)).toBe("FHD");
    expect(videoTierFromMaxHeight(720)).toBe("HD");
    expect(videoTierFromMaxHeight(480)).toBe("SD");
    expect(videoTierFromMaxHeight(360)).toBe("SD");
    expect(videoCapabilityLabel(2160)).toBe("Up to UHD (2160p)");
    expect(videoCapabilityLabel(1080)).toBe("Up to FHD (1080p)");
    expect(videoCapabilityLabel(480)).toBe("Up to SD (480p)");
    expect(videoCapabilityLabel(null)).toBe("Not available");
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
    expect(qualityDescription("MP4_1080P")).toBe("Full HD · 1080p");
    expect(qualityDescription("2160P")).toBe("Ultra HD · 2160p");
    expect(qualityDescription("MP4_360P")).toBe("SD · 360p");
    expect(qualityDescription("FHD")).toBe("Full HD · 1080p");
  });
});
