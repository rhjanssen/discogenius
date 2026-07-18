import { describe, expect, it } from "vitest";
import {
  selectVideoDownloadOffer,
  selectVideoOffer,
  selectVideoPreviewOffer,
  videoOfferSelectionKey,
  videoQueueTarget,
} from "./videoOffers";

describe("video provider offer selection", () => {
  it("uses provider plus id when two providers expose the same numeric id", () => {
    const offers = [
      { provider: "tidal", provider_id: "42", quality: "MP4_1080P" },
      { provider: "apple-music", provider_id: "42", quality: "MP4_2160P" },
    ];

    const selected = selectVideoOffer(
      offers,
      videoOfferSelectionKey("apple-music", "42"),
    );

    expect(selected).toEqual(offers[1]);
  });

  it("queues the selected provider offer id instead of the canonical recording id", () => {
    expect(videoQueueTarget("canonical-17", {
      provider: "apple-music",
      provider_id: "1697173352",
    })).toEqual({
      provider: "apple-music",
      providerId: "1697173352",
    });
  });

  it("falls back to a playable offer without changing the selected download source", () => {
    const offers = [
      { provider: "youtube-music", provider_id: "youtube-id", can_preview: false, can_download: true },
      { provider: "tidal", provider_id: "tidal-id", can_preview: true, can_download: true },
    ];
    const selectedKey = videoOfferSelectionKey("youtube-music", "youtube-id");

    expect(selectVideoPreviewOffer(offers, selectedKey)).toEqual(offers[1]);
    expect(selectVideoDownloadOffer(offers, selectedKey)).toEqual(offers[0]);
  });

  it("does not choose unavailable or unsupported offers for an action", () => {
    const offers = [
      { provider: "tidal", provider_id: "offline", available: false, can_preview: true, can_download: true },
      { provider: "youtube-music", provider_id: "view-only", can_preview: false, can_download: false },
    ];
    expect(selectVideoPreviewOffer(offers, null)).toBeNull();
    expect(selectVideoDownloadOffer(offers, null)).toBeNull();
  });
});
