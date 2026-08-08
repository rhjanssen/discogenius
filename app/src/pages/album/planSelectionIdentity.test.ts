import { describe, expect, it } from "vitest";
import { isOfferSelected, type ProviderQualityOffer } from "@/components/ui/ProviderQualityPill";
import { isSamePlanOffer } from "./ReleaseSwitcher";

/**
 * Two acquisition plans of one edition can be built from the same provider
 * release: an explicit composite and a clean single-source plan on Bad Blood
 * both resolve to TIDAL album 4012 once the composite's out-of-edition sources
 * are dropped from the badge's id list. Selection used to compare provider plus
 * provider album id, so both pills rendered as the selected one and a click
 * could resolve to the wrong plan.
 */
function planOffer(planKey: string, overrides: Partial<ProviderQualityOffer> = {}): ProviderQualityOffer {
  return {
    slot: "stereo",
    planKey,
    provider: "tidal",
    quality: "LOSSLESS",
    providerAlbumId: "4012",
    providerAlbumIds: ["4012"],
    ...overrides,
  };
}

describe("acquisition plan pill identity", () => {
  it("selects exactly the plan that is chosen, not its provider twin", () => {
    const composite = planOffer("tidal|hires-lossless|explicit|composite|4012");
    const single = planOffer("tidal|lossless|clean|single_source|4012");
    const selected = { planKey: single.planKey, provider: "tidal", albumId: "4012" };

    expect(isOfferSelected(single, selected)).toBe(true);
    expect(isOfferSelected(composite, selected)).toBe(false);
  });

  it("does not select any plan when the chosen plan key is absent", () => {
    const plan = planOffer("tidal|lossless|clean|single_source|4012");
    expect(isOfferSelected(plan, { planKey: null, provider: "tidal", albumId: "4012" })).toBe(false);
  });

  it("still matches raw provider offers, which carry no plan", () => {
    const raw: ProviderQualityOffer = {
      slot: "video",
      provider: "youtube-music",
      providerAlbumId: "abc",
    };
    expect(isOfferSelected(raw, { provider: "youtube-music", albumId: "abc" })).toBe(true);
    expect(isOfferSelected(raw, { provider: "youtube-music", albumId: "def" })).toBe(false);
  });

  it("resolves a clicked badge back to its own plan", () => {
    const composite = planOffer("tidal|hires-lossless|explicit|composite|4012");
    const single = planOffer("tidal|lossless|clean|single_source|4012");

    expect(isSamePlanOffer(single, single)).toBe(true);
    expect(isSamePlanOffer(composite, single)).toBe(false);
  });
});
