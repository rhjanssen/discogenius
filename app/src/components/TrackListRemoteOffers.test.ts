import { describe, expect, it } from "vitest";
import { acquisitionPlanDisplayQuality } from "@/utils/acquisitionPlanDisplayQuality";

describe("TrackList remote acquisition-plan offer quality normalization", () => {
  it("shows DOLBY_ATMOS for Apple generic spatial track offer", () => {
    const displayQuality = acquisitionPlanDisplayQuality({
      displayQuality: "SPATIAL",
      qualityTier: "spatial",
      provider: "apple",
    });
    expect(displayQuality).toBe("DOLBY_ATMOS");
  });

  it("shows DOLBY_ATMOS for TIDAL generic spatial track offer", () => {
    const displayQuality = acquisitionPlanDisplayQuality({
      displayQuality: "SPATIAL",
      qualityTier: "spatial",
      provider: "tidal",
    });
    expect(displayQuality).toBe("DOLBY_ATMOS");
  });

  it("shows SPATIAL for future-provider generic spatial track offer", () => {
    const displayQuality = acquisitionPlanDisplayQuality({
      displayQuality: "SPATIAL",
      qualityTier: "spatial",
      provider: "future-dsp",
    });
    expect(displayQuality).toBe("SPATIAL");
  });

  it("remains stereo for stereo track offer", () => {
    const displayQuality = acquisitionPlanDisplayQuality({
      displayQuality: "LOSSLESS",
      qualityTier: "lossless",
      provider: "apple",
    });
    expect(displayQuality).toBe("LOSSLESS");
  });

  it("returns null when no plan quality exists (plan hole or manual file)", () => {
    const offerQuality = null;
    const displayQuality = offerQuality
      ? acquisitionPlanDisplayQuality({
          displayQuality: offerQuality,
          provider: "apple",
        })
      : null;
    expect(displayQuality).toBeNull();
  });
});
