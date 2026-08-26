import { describe, expect, it } from "vitest";
import { isLocalAudioLibraryFile, selectTrackPlaybackSource } from "./trackPlaybackSource";

describe("isLocalAudioLibraryFile", () => {
  it("treats a missing file_type as an audio track", () => {
    expect(isLocalAudioLibraryFile({ id: 1 } as { file_type?: string })).toBe(true);
  });

  it("ignores lyrics and video sidecars", () => {
    expect(isLocalAudioLibraryFile({ file_type: "lyrics" })).toBe(false);
    expect(isLocalAudioLibraryFile({ file_type: "video" })).toBe(false);
  });
});

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
