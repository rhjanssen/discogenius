import { describe, expect, it } from "vitest";
import {
  AUTOMATIC_ARTIST_LIBRARY_SCOPE,
  buildArtistLibraryUpdate,
} from "./artistMonitoring";

describe("automatic artist monitoring scope", () => {
  it("uses the server-resolved Settings scope instead of cached library ids", () => {
    expect(AUTOMATIC_ARTIST_LIBRARY_SCOPE).toEqual({ allLibraries: true });
    expect(buildArtistLibraryUpdate("monitor", "all")).toEqual({
      monitored: true,
      policy: "all",
      allLibraries: true,
    });
  });

  it("applies policy and unmonitor operations without opening a library chooser", () => {
    expect(buildArtistLibraryUpdate("policy", "none")).toEqual({
      policy: "none",
      allLibraries: true,
    });
    expect(buildArtistLibraryUpdate("unmonitor", "all")).toEqual({
      monitored: false,
      allLibraries: true,
    });
  });
});
