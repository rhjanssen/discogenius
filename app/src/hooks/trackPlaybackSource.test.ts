import { describe, expect, it } from "vitest";
import { selectTrackPlaybackSource } from "./trackPlaybackSource";

describe("selectTrackPlaybackSource", () => {
  it("prefers a downloaded local audio file even when provider preview metadata exists", () => {
    expect(selectTrackPlaybackSource({
      hasLocalAudioFile: true,
      forceProviderPreview: false,
    })).toBe("local");
  });

  it("uses a provider preview when no local audio file exists", () => {
    expect(selectTrackPlaybackSource({
      hasLocalAudioFile: false,
      forceProviderPreview: false,
    })).toBe("provider");
  });

  it("allows the compatibility fallback to bypass an unplayable local file", () => {
    expect(selectTrackPlaybackSource({
      hasLocalAudioFile: true,
      forceProviderPreview: true,
    })).toBe("provider");
  });
});
