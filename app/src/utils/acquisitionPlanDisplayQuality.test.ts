import { describe, expect, it } from "vitest";
import { acquisitionPlanDisplayQuality } from "./acquisitionPlanDisplayQuality";

describe("acquisitionPlanDisplayQuality", () => {
  it("maps Apple spatial plan to DOLBY_ATMOS", () => {
    expect(
      acquisitionPlanDisplayQuality({ qualityTier: "spatial", provider: "apple" }),
    ).toBe("DOLBY_ATMOS");
  });

  it("normalizes Apple Music alias variants correctly", () => {
    expect(
      acquisitionPlanDisplayQuality({ qualityTier: "spatial", provider: "apple-music" }),
    ).toBe("DOLBY_ATMOS");
    expect(
      acquisitionPlanDisplayQuality({ qualityTier: "spatial", provider: "apple_music" }),
    ).toBe("DOLBY_ATMOS");
  });

  it("maps TIDAL spatial plan to DOLBY_ATMOS", () => {
    expect(
      acquisitionPlanDisplayQuality({ qualityTier: "spatial", provider: "tidal" }),
    ).toBe("DOLBY_ATMOS");
  });

  it("gives explicit displayQuality DOLBY_ATMOS precedence regardless of alias spelling", () => {
    expect(
      acquisitionPlanDisplayQuality({
        qualityTier: "lossless",
        displayQuality: "DOLBY_ATMOS",
        provider: "unknown",
      }),
    ).toBe("DOLBY_ATMOS");
  });

  it("maps Apple plus displayQuality SPATIAL or SPATIAL_AUDIO to DOLBY_ATMOS", () => {
    expect(
      acquisitionPlanDisplayQuality({ displayQuality: "SPATIAL", provider: "apple" }),
    ).toBe("DOLBY_ATMOS");
    expect(
      acquisitionPlanDisplayQuality({ displayQuality: "SPATIAL_AUDIO", provider: "apple-music" }),
    ).toBe("DOLBY_ATMOS");
  });

  it("maps TIDAL plus generic Spatial displayQuality to DOLBY_ATMOS", () => {
    expect(
      acquisitionPlanDisplayQuality({ displayQuality: "SPATIAL", provider: "tidal" }),
    ).toBe("DOLBY_ATMOS");
  });

  it("maps future provider plus generic Spatial displayQuality to SPATIAL", () => {
    expect(
      acquisitionPlanDisplayQuality({ displayQuality: "SPATIAL", provider: "future-dsp" }),
    ).toBe("SPATIAL");
  });

  it("keeps SONY_360RA distinct", () => {
    expect(
      acquisitionPlanDisplayQuality({ displayQuality: "SONY_360RA" }),
    ).toBe("SONY_360RA");
  });

  it("keeps stereo Apple/TIDAL plan stereo", () => {
    expect(
      acquisitionPlanDisplayQuality({ qualityTier: "lossless", provider: "apple" }),
    ).toBe("LOSSLESS");
    expect(
      acquisitionPlanDisplayQuality({ qualityTier: "hires-lossless", provider: "tidal" }),
    ).toBe("HIRES_LOSSLESS");
  });
});
