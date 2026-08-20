import { describe, expect, it } from "vitest";
import { queueProviderOffers } from "./queueProviderOffers";

describe("queueProviderOffers", () => {
  it("builds a video offer that hides match coverage copy", () => {
    expect(queueProviderOffers({
      type: "video",
      provider: "apple-music",
      providerId: "1445311108",
      quality: "FHD",
      url: "https://music.apple.com/nl/music-video/pompeii-live/1445311108",
    })).toEqual([{
      slot: "video",
      quality: "FHD",
      provider: "apple-music",
      providerAlbumId: "1445311108",
      providerUrl: "https://music.apple.com/nl/music-video/pompeii-live/1445311108",
      coverageSummary: "",
    }]);
  });

  it("treats Atmos album downloads as the spatial slot", () => {
    expect(queueProviderOffers({
      type: "album",
      provider: "tidal",
      providerId: "330314022",
      quality: "DOLBY_ATMOS",
    })[0]).toMatchObject({
      slot: "spatial",
      provider: "tidal",
      coverageSummary: "",
    });
  });
});
