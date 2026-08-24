import { createDarkTheme, createLightTheme } from "@fluentui/react-components";
import { describe, expect, it } from "vitest";
import {
  createDiscogeniusTheme,
  buildDiscogeniusSearchUnderlineGradient,
  discogeniusAccentKeys,
  discogeniusAuxiliaryThemes,
  discogeniusOrangeTheme,
  getDiscogeniusAccentTokens,
} from "./theme";

function relativeLuminance(hex: string): number {
  const channels = hex
    .replace("#", "")
    .match(/.{2}/g)
    ?.map((channel) => Number.parseInt(channel, 16) / 255)
    .map((channel) => channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4);

  if (!channels || channels.length !== 3) throw new Error(`Expected a six-digit hex color, received ${hex}`);
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(foreground: string, background: string): number {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

describe("Discogenius theme semantics", () => {
  it("keeps Fluent's mode-aware brand mappings intact", () => {
    expect(createDiscogeniusTheme(discogeniusOrangeTheme, "light")).toEqual(
      createLightTheme(discogeniusOrangeTheme),
    );
    expect(createDiscogeniusTheme(discogeniusOrangeTheme, "dark")).toEqual(
      createDarkTheme(discogeniusOrangeTheme),
    );
  });

  it.each(["light", "dark"] as const)("keeps %s media accents readable", (mode) => {
    const accents = getDiscogeniusAccentTokens(mode);
    for (const accent of discogeniusAccentKeys) {
      expect(contrastRatio(accents[accent].foreground, accents[accent].background)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(["light", "dark"] as const)("keeps %s dynamic-brand accents readable", (mode) => {
    for (const brand of Object.values(discogeniusAuxiliaryThemes)) {
      const accent = getDiscogeniusAccentTokens(mode, brand).artists;
      expect(contrastRatio(accent.foreground, accent.background)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(["light", "dark"] as const)("keeps %s filled brand controls readable", (mode) => {
    const theme = createDiscogeniusTheme(discogeniusOrangeTheme, mode);
    expect(contrastRatio(theme.colorNeutralForegroundOnBrand, theme.colorBrandBackground)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(["light", "dark"] as const)("keeps the %s search underline on the saturated media palette", (mode) => {
    const gradient = buildDiscogeniusSearchUnderlineGradient(mode);
    const accents = getDiscogeniusAccentTokens(mode);
    expect(gradient).toContain(accents.videos.foreground);
    expect(gradient).toContain(accents.tracks.foreground);
    expect(gradient).toContain(accents.albums.foreground);
    expect(gradient).toContain(accents.artists.foreground);
  });
});
