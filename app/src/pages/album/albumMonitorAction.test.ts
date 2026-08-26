import { describe, expect, it } from "vitest";
import { getAlbumMonitorActionPresentation } from "./albumMonitorAction";

describe("album monitor action presentation", () => {
  it("keeps an explicit monitor action enabled while Album Lock is active", () => {
    const action = getAlbumMonitorActionPresentation({
      isLocked: true,
      isMonitored: false,
      isPending: false,
    });

    expect(action).toMatchObject({
      disabled: false,
      label: "Monitor",
    });
    expect(action.tooltip).toContain("automatic curation");
    expect(action.tooltip).toContain("manual changes remain available");
  });

  it("disables the action only while its mutation is pending", () => {
    expect(getAlbumMonitorActionPresentation({
      isLocked: true,
      isMonitored: true,
      isPending: true,
    })).toMatchObject({
      disabled: true,
      label: "Monitored",
    });
  });

  it("labels a monitored album as Monitored", () => {
    expect(getAlbumMonitorActionPresentation({
      isLocked: false,
      isMonitored: true,
      isPending: false,
    })).toMatchObject({
      disabled: false,
      label: "Monitored",
    });
  });
});
