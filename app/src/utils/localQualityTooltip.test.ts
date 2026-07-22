import { describe, expect, it } from "vitest";
import {
  formatChannelsLabel,
  formatCodecLabel,
  isVideoCodecName,
  localFileQualityTooltip,
} from "./localQualityTooltip";
import { qualityDescription } from "./qualityTier";

describe("localFileQualityTooltip", () => {
  it("expands video badges without repeating the short tier label awkwardly", () => {
    expect(localFileQualityTooltip({ quality: "MP4_1080P" })).toBe("Full HD · 1080p");
    expect(qualityDescription("MP4_1080P")).toBe("Full HD · 1080p");
    expect(qualityDescription("MP4_1080P")).not.toMatch(/Video · FHD/);
  });

  it("appends video/audio codecs and bitrate when probe props are present", () => {
    expect(localFileQualityTooltip({
      quality: "MP4_1080P",
      video_codec: "h264",
      codec: "aac",
      bitrate: 320000,
    })).toBe("Full HD · 1080p · H.264 · AAC · 320 kbps");

    expect(localFileQualityTooltip({
      quality: "2160P",
      video_codec: "av1",
      codec: "opus",
      bitrate: 768000,
    })).toBe("Ultra HD · 2160p · AV1 · Opus · 768 kbps");
  });

  it("uses exact pixel height from the quality tag when richer than the tier default", () => {
    expect(localFileQualityTooltip({ quality: "MP4_360P" })).toBe("SD · 360p");
    expect(localFileQualityTooltip({
      quality: "MP4_720P",
      codec: "aac",
      bitrate: 192000,
    })).toBe("HD · 720p · AAC · 192 kbps");
  });

  it("treats a video FourCC in codec as the video codec when video_codec is absent", () => {
    expect(localFileQualityTooltip({
      quality: "MP4_1080P",
      codec: "hev1",
      bitrate: 256000,
    })).toBe("Full HD · 1080p · HEVC · 256 kbps");
  });

  it("describes hi-res / lossless from probe props", () => {
    expect(localFileQualityTooltip({
      quality: "HIRES_LOSSLESS",
      bit_depth: 24,
      sample_rate: 192000,
      codec: "ALAC",
    })).toBe("24 Bit · 192 kHz · ALAC");
  });

  it("describes lossy from bitrate + codec", () => {
    expect(localFileQualityTooltip({
      quality: "HIGH",
      bitrate: 256000,
      codec: "AAC",
    })).toBe("256 kbps · AAC");
  });

  it("describes spatial Atmos files with clearer codec naming", () => {
    expect(localFileQualityTooltip({
      quality: "DOLBY_ATMOS",
      bitrate: 768000,
      channels: 6,
      codec: "eac3",
    })).toBe("Dolby Digital Plus 5.1 + Dolby Atmos · 768 kbps");
  });

  it("maps channel counts and codecs for display", () => {
    expect(formatChannelsLabel(6)).toBe("5.1");
    expect(formatChannelsLabel(2)).toBe("Stereo");
    expect(formatCodecLabel("eac3")).toBe("Dolby Digital Plus");
    expect(formatCodecLabel("FLAC")).toBe("FLAC");
    expect(formatCodecLabel("h264")).toBe("H.264");
    expect(formatCodecLabel("avc1")).toBe("H.264");
    expect(formatCodecLabel("h265")).toBe("HEVC");
    expect(formatCodecLabel("hev1")).toBe("HEVC");
    expect(formatCodecLabel("av1")).toBe("AV1");
    expect(formatCodecLabel("vp9")).toBe("VP9");
    expect(isVideoCodecName("h264")).toBe(true);
    expect(isVideoCodecName("aac")).toBe(false);
  });
});
