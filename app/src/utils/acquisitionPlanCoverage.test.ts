import { describe, expect, it } from "vitest";
import {
  coverageSummaryForSelectedOffer,
  formatAcquisitionPlanCoverageSummary,
} from "./acquisitionPlanCoverage";

describe("formatAcquisitionPlanCoverageSummary", () => {
  it("calls an exact single source a Complete match", () => {
    expect(formatAcquisitionPlanCoverageSummary({
      composition: "single_source",
      relation: "exact",
      coverage: 12,
      targetTrackCount: 12,
    })).toBe("Complete match");
  });

  it("keeps non-exact single sources as coverage copy", () => {
    expect(formatAcquisitionPlanCoverageSummary({
      composition: "single_source",
      relation: "overlap",
      coverage: 10,
      targetTrackCount: 12,
    })).toBe("Single source · Partial coverage");
  });
});

describe("coverageSummaryForSelectedOffer", () => {
  it("defaults a selected single source to Complete match", () => {
    expect(coverageSummaryForSelectedOffer({
      providerAlbumId: "287367980",
    })).toBe("Complete match");
  });
});
