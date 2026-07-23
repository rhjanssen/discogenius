import { describe, expect, it } from "vitest";
import {
    composeProviderPriority,
    dropConnectedProviderOn,
    reorderConnectedProviderIds,
} from "./providerPriority";

const providers = [
    { id: "tidal", authenticated: false },
    { id: "apple-music", authenticated: true },
    { id: "deezer", authenticated: false },
    { id: "youtube-music", authenticated: true },
];

describe("provider priority ordering", () => {
    it("puts every connected provider before disconnected providers", () => {
        expect(composeProviderPriority(providers, ["youtube-music", "apple-music"])).toEqual([
            "youtube-music",
            "apple-music",
            "tidal",
            "deezer",
        ]);
    });

    it("moves visible providers without leaving a hidden provider as default", () => {
        expect(reorderConnectedProviderIds(providers, "youtube-music", -1)).toEqual([
            "youtube-music",
            "apple-music",
            "tidal",
            "deezer",
        ]);
        expect(reorderConnectedProviderIds(providers, "apple-music", -1)).toBeNull();
    });

    it("drags within the connected group and appends inactive providers", () => {
        expect(dropConnectedProviderOn(providers, "apple-music", "youtube-music")).toEqual([
            "youtube-music",
            "apple-music",
            "tidal",
            "deezer",
        ]);
    });
});
