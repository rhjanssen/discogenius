import { describe, expect, it } from "vitest";
import { providerArtworkThumbnailUrl } from "./providerArtworkThumbnail";

describe("providerArtworkThumbnailUrl", () => {
    it("replaces TIDAL origin artwork with a supported compact square", () => {
        expect(providerArtworkThumbnailUrl(
            "tidal",
            "https://resources.tidal.com/images/aa/bb/cc/origin.jpg",
        )).toBe("https://resources.tidal.com/images/aa/bb/cc/160x160.jpg");
    });

    it("preserves unknown provider URLs", () => {
        const source = "https://example.test/full-size-artist.jpg";
        expect(providerArtworkThumbnailUrl("spotify", source)).toBe(source);
    });
});
