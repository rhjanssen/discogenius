import { describe, it, expect } from "vitest";
import {
  mediaCoverProxySrc,
  mediaCoverSrc,
  toMediaCoverProxyUrl,
} from "./artwork.js";

describe("artwork helpers", () => {
  it("mediaCoverSrc prefers cover_art_url", () => {
    expect(mediaCoverSrc({
      cover_art_url: "/media-cover/Videos/12/cover.jpg",
      cover: "/media-cover/Videos/12/other.jpg",
    })).toBe("/media-cover/Videos/12/cover.jpg");
  });

  it("toMediaCoverProxyUrl rewrites local media-cover paths to height proxies", () => {
    expect(toMediaCoverProxyUrl("/media-cover/Albums/rg/cover.jpg")).toBe(
      "/media-cover/Albums/rg/cover-500.jpg",
    );
    expect(toMediaCoverProxyUrl("/media-cover/Albums/rg/cover.jpg", 250)).toBe(
      "/media-cover/Albums/rg/cover-250.jpg",
    );
    expect(toMediaCoverProxyUrl("/media-cover/Videos/12/cover.jpg")).toBe(
      "/media-cover/Videos/12/cover-250.jpg",
    );
    expect(toMediaCoverProxyUrl("/media-cover/Videos/12/cover.jpg", 500)).toBe(
      "/media-cover/Videos/12/cover-500.jpg",
    );
    expect(toMediaCoverProxyUrl("/media-cover/Videos/12/cover-250.jpg")).toBe(
      "/media-cover/Videos/12/cover-250.jpg",
    );
  });

  it("toMediaCoverProxyUrl preserves source and revision query params", () => {
    expect(
      toMediaCoverProxyUrl("/media-cover/Videos/12/cover.jpg?rev=abc123"),
    ).toBe("/media-cover/Videos/12/cover-250.jpg?rev=abc123");
    expect(
      toMediaCoverProxyUrl("/media-cover/Albums/rg/cover.jpg?source=canonical&rev=def456"),
    ).toBe("/media-cover/Albums/rg/cover-500.jpg?source=canonical&rev=def456");
  });

  it("toMediaCoverProxyUrl leaves remote URLs alone", () => {
    expect(toMediaCoverProxyUrl("https://resources.tidal.com/images/a/b/c/d/e/origin.jpg"))
      .toBe("https://resources.tidal.com/images/a/b/c/d/e/origin.jpg");
  });

  it("mediaCoverProxySrc maps video entities onto the 250px card proxy", () => {
    expect(mediaCoverProxySrc({
      cover_art_url: "/media-cover/Videos/99/cover.jpg?lastWrite=7",
    })).toBe("/media-cover/Videos/99/cover-250.jpg?lastWrite=7");
  });
});
