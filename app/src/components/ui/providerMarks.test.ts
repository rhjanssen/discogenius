import { describe, expect, it } from "vitest";
import { providerAlbumUrl, providerMarkFor, providerVideoUrl } from "./providerMarks";

describe("provider marks", () => {
  it("resolves the manifest ids used by Amazon Music and YouTube Music", () => {
    expect(providerMarkFor("amazon-music")?.src).toBe("/assets/images/amazon_icon.svg");
    expect(providerMarkFor("youtube-music")?.src).toBe("/assets/images/youtube_icon.svg");
  });

  it("builds public links for every provider with stable album or video URLs", () => {
    expect(providerAlbumUrl("amazon-music", "B0ABC")).toBe("https://music.amazon.com/albums/B0ABC");
    expect(providerAlbumUrl("spotify", "spotify-id")).toBe("https://open.spotify.com/album/spotify-id");
    expect(providerAlbumUrl("youtube-music", "MPREb_test")).toBe("https://music.youtube.com/browse/MPREb_test");
    expect(providerAlbumUrl("youtube-music", "OLAK5uy_test")).toBe("https://music.youtube.com/playlist?list=OLAK5uy_test");
    expect(providerAlbumUrl("deezer", "42")).toBe("https://www.deezer.com/album/42");
    expect(providerVideoUrl("youtube-music", "dQw4w9WgXcQ")).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  });
});
