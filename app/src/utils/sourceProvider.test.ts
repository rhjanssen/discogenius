import { describe, expect, it } from "vitest";
import {
  formatSourceProviderLabel,
  isProviderMarkSupported,
  summarizeTrackFileSources,
} from "./sourceProvider";
import { localFileQualityTooltip } from "./localQualityTooltip";

describe("sourceProvider utilities", () => {
  it("formats canonical and legacy provider identifiers", () => {
    expect(formatSourceProviderLabel("tidal")).toBe("TIDAL");
    expect(formatSourceProviderLabel("apple_music")).toBe("Apple Music");
    expect(formatSourceProviderLabel("apple-music")).toBe("Apple Music");
    expect(formatSourceProviderLabel("amazon")).toBe("Amazon Music");
    expect(formatSourceProviderLabel("youtube_music")).toBe("YouTube");
    expect(formatSourceProviderLabel("deezer")).toBe("Deezer");
    expect(formatSourceProviderLabel("external")).toBe("External import");
    expect(formatSourceProviderLabel("unknown")).toBe("Unknown");
    expect(formatSourceProviderLabel(null)).toBeNull();
    expect(formatSourceProviderLabel("   ")).toBeNull();
  });

  it("identifies when ProviderMark is supported", () => {
    expect(isProviderMarkSupported("tidal")).toBe(true);
    expect(isProviderMarkSupported("apple")).toBe(true);
    expect(isProviderMarkSupported("external")).toBe(false);
    expect(isProviderMarkSupported("manual")).toBe(false);
    expect(isProviderMarkSupported("unknown")).toBe(false);
    expect(isProviderMarkSupported(null)).toBe(false);
  });

  it("summarizes single and mixed track file sources while ignoring non-track files", () => {
    expect(summarizeTrackFileSources([])).toBeNull();
    expect(
      summarizeTrackFileSources([
        { files: [{ file_type: "cover", source_provider: "tidal" }] },
      ]),
    ).toBeNull();

    expect(
      summarizeTrackFileSources([
        { files: [{ file_type: "track", source_provider: "tidal" }] },
        { files: [{ file_type: "track", source_provider: "tidal" }] },
      ]),
    ).toBe("TIDAL");

    expect(
      summarizeTrackFileSources([
        { files: [{ file_type: "track", source_provider: "tidal" }] },
        { files: [{ file_type: "track", source_provider: "tidal" }] },
        { files: [{ file_type: "track", source_provider: "tidal" }] },
        { files: [{ file_type: "track", source_provider: "apple" }] },
        { files: [{ file_type: "track", source_provider: "apple_music" }] },
      ]),
    ).toBe("TIDAL, 2 tracks Apple Music");

    expect(
      summarizeTrackFileSources([
        { files: [{ file_type: "track", source_provider: "tidal" }] },
        { files: [{ file_type: "track", source_provider: "tidal" }] },
        { files: [{ file_type: "track", source_provider: "external" }] },
      ]),
    ).toBe("TIDAL, 1 track External import");
  });

  it("appends source provider to localFileQualityTooltip when present", () => {
    expect(
      localFileQualityTooltip({
        quality: "LOSSLESS",
        bit_depth: 16,
        sample_rate: 44100,
        codec: "FLAC",
        source_provider: "tidal",
      }),
    ).toBe("16 Bit · 44.1 kHz · FLAC · Source: TIDAL");

    expect(
      localFileQualityTooltip({
        quality: "LOSSLESS",
        bit_depth: 16,
        sample_rate: 44100,
        codec: "FLAC",
        source_provider: null,
      }),
    ).toBe("16 Bit · 44.1 kHz · FLAC");
  });
});
