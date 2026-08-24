import { describe, expect, it } from "vitest";
import {
  editionMediaLabel,
  editionMediaRank,
  editionRegionLabel,
  editionTabLabel,
  editionTabCompactLabel,
} from "./editionDisplay";

describe("editionRegionLabel", () => {
  it("reads ISO codes from the Servarr metadata mirror", () => {
    expect(editionRegionLabel('["DE","US"]')).toBe("Germany, United States");
    expect(editionRegionLabel('["GB"]')).toBe("United Kingdom");
  });

  it("reads full names from a local MusicBrainz mirror without shouting them", () => {
    // The local mirror stores names, not codes; uppercasing to look up a code
    // used to render "GERMANY, UNITED STATES" on the Frank tab strip.
    expect(editionRegionLabel('["Germany","United States"]')).toBe("Germany, United States");
    expect(editionRegionLabel('["Belgium"]')).toBe("Belgium");
  });

  it("surfaces worldwide pseudo-regions in either spelling", () => {
    expect(editionRegionLabel('["XW"]')).toBe("Worldwide");
    expect(editionRegionLabel('["Worldwide"]')).toBe("Worldwide");
    expect(editionRegionLabel('["XE"]')).toBe("Europe");
  });

  it("returns nothing for the blank payloads MusicBrainz actually emits", () => {
    expect(editionRegionLabel("[]")).toBeNull();
    expect(editionRegionLabel('[""]')).toBeNull();
    expect(editionRegionLabel(null)).toBeNull();
    expect(editionRegionLabel("  ")).toBeNull();
    expect(editionRegionLabel('["Unknown"]')).toBeNull();
  });

  it("caps long region lists", () => {
    expect(editionRegionLabel('["DE","US","GB","FR"]')).toBe("4 regions");
    expect(editionRegionLabel('["XW","DE","US","GB"]')).toBe("Worldwide & 3 regions");
  });

  it("deduplicates without destroying display casing", () => {
    expect(editionRegionLabel('["Germany","germany"]')).toBe("Germany");
  });
});

describe("editionMediaLabel", () => {
  it("shortens MusicBrainz medium formats", () => {
    expect(editionMediaLabel(["Digital Media"])).toBe("Digital");
    expect(editionMediaLabel(["CD"])).toBe("CD");
    expect(editionMediaLabel(['12" Vinyl'])).toBe("Vinyl");
    expect(editionMediaLabel(["CD", "DVD"])).toBe("CD + DVD");
  });

  it("has no label for an edition with no formats", () => {
    expect(editionMediaLabel([])).toBeNull();
    expect(editionMediaLabel(null)).toBeNull();
    expect(editionMediaLabel(["  "])).toBeNull();
  });

  it("ranks digital first and unknown last", () => {
    expect(editionMediaRank(["Digital Media"])).toBeLessThan(editionMediaRank(["CD"]));
    expect(editionMediaRank(["CD"])).toBeLessThan(editionMediaRank(["Vinyl"]));
    expect(editionMediaRank([])).toBeGreaterThan(editionMediaRank(["Cassette"]));
  });
});

describe("editionTabLabel", () => {
  const base = {
    title: "Frank",
    disambiguation: null,
    country: '["GB"]',
    mediaFormats: ["CD"],
    trackCount: 31,
  };

  it("drops the edition title when it repeats the album title", () => {
    expect(editionTabLabel(base, "Frank")).toBe("CD · United Kingdom · 31 tracks");
  });

  it("keeps a distinguishing title or disambiguation", () => {
    expect(editionTabLabel({ ...base, disambiguation: "deluxe edition" }, "Frank"))
      .toBe("deluxe edition · CD · United Kingdom · 31 tracks");
    expect(editionTabLabel({ ...base, title: "Bad Blood X" }, "Bad Blood"))
      .toBe("Bad Blood X · CD · United Kingdom · 31 tracks");
  });

  it("never renders an empty label", () => {
    expect(editionTabLabel({
      title: "",
      disambiguation: null,
      country: "[]",
      mediaFormats: [],
      trackCount: null,
    }, null)).toBe("Edition");
  });
});

describe("editionTabCompactLabel", () => {
  const base = {
    title: "Frank",
    disambiguation: null,
    country: '["GB"]',
    mediaFormats: ["CD"],
    trackCount: 31,
  };

  it("uses an edition title or disambiguation as the primary mobile distinction", () => {
    expect(editionTabCompactLabel({ ...base, title: "Bad Blood X" }, "Bad Blood"))
      .toBe("Bad Blood X");
    expect(editionTabCompactLabel({ ...base, disambiguation: "deluxe edition" }, "Frank"))
      .toBe("deluxe edition");
  });

  it("falls back to compact format, region and track facts", () => {
    expect(editionTabCompactLabel(base, "Frank"))
      .toBe("CD · United Kingdom · 31 tracks");
  });
});
