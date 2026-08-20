import { describe, expect, it } from "vitest";
import { albumSelectedQualityOffers } from "./albumSelectedQualityOffers";

describe("albumSelectedQualityOffers", () => {
  it("uses Complete match for a selected single-source stereo offer", () => {
    const offers = albumSelectedQualityOffers({
      stereo_provider: "tidal",
      stereo_provider_id: "287367980",
      stereo_quality: "HIRES_LOSSLESS",
      stereo_release_mbid: "edition-1",
    });
    expect(offers).toHaveLength(1);
    expect(offers[0]?.coverageSummary).toBe("Complete match");
    expect(offers[0]?.matchKind).toBe("direct");
    expect(offers[0]?.provider).toBe("tidal");
  });

  it("uses the plan relation when the card carries it", () => {
    const offers = albumSelectedQualityOffers({
      stereo_provider: "tidal",
      stereo_provider_id: "1",
      stereo_plan_composition: "single_source",
      stereo_plan_relation: "source_superset",
      stereo_plan_coverage: 10,
      stereo_plan_target_track_count: 10,
    });
    expect(offers[0]?.coverageSummary).toBe("Single source · Full coverage");
  });

  it("labels a composite plan from composition or multiple album ids", () => {
    const fromComposition = albumSelectedQualityOffers({
      stereo_provider: "tidal",
      stereo_provider_id: "1",
      stereo_plan_composition: "composite",
      stereo_plan_coverage: 8,
      stereo_plan_target_track_count: 10,
    });
    expect(fromComposition[0]?.coverageSummary).toBe("Composite · Partial coverage");
    expect(fromComposition[0]?.matchKind).toBe("composite");

    const fromIds = albumSelectedQualityOffers({
      stereo_provider: "tidal",
      stereo_provider_id: "1;2",
    });
    expect(fromIds[0]?.coverageSummary).toBe("Composite · Full coverage");
  });
});
