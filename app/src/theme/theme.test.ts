import { createDarkTheme, createLightTheme } from "@fluentui/react-components";
import { describe, expect, it } from "vitest";
import {
  buildDiscogeniusSearchUnderlineGradient,
  createDiscogeniusTheme,
  discogeniusAccentKeys,
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
  it("keeps Fluent's light brand mapping intact", () => {
    expect(createDiscogeniusTheme(discogeniusOrangeTheme, "light")).toEqual(
      createLightTheme(discogeniusOrangeTheme),
    );
  });

  it("applies Fluent theme-designer dark brand text and a readable filled step", () => {
    const theme = createDiscogeniusTheme(discogeniusOrangeTheme, "dark");
    const stock = createDarkTheme(discogeniusOrangeTheme);
    expect(theme.colorBrandForeground1).toBe(discogeniusOrangeTheme[110]);
    expect(theme.colorBrandForeground2).toBe(discogeniusOrangeTheme[120]);
    expect(theme.colorCompoundBrandForeground1).toBe(discogeniusOrangeTheme[110]);
    expect(theme.colorBrandBackground).toBe(discogeniusOrangeTheme[80]);
    expect(theme.colorNeutralForeground1).toBe(stock.colorNeutralForeground1);
    expect(theme.colorNeutralBackground1).toBe(stock.colorNeutralBackground1);
  });

  it("uses Fluent brand-text tokens for dashboard accents", () => {
    const lightAccents = getDiscogeniusAccentTokens("light");
    const darkAccents = getDiscogeniusAccentTokens("dark");

    expect(lightAccents.artists.foreground).toBe(
      createDiscogeniusTheme(discogeniusOrangeTheme, "light").colorBrandForeground1,
    );
    expect(darkAccents.artists.foreground).toBe(
      createDiscogeniusTheme(discogeniusOrangeTheme, "dark").colorBrandForeground1,
    );

    for (const accent of discogeniusAccentKeys) {
      expect(contrastRatio(lightAccents[accent].foreground, createLightTheme(discogeniusOrangeTheme).colorNeutralBackground1)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(darkAccents[accent].foreground, createDarkTheme(discogeniusOrangeTheme).colorNeutralBackground1)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(lightAccents[accent].badgeForeground, lightAccents[accent].badgeBackground)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(darkAccents[accent].badgeForeground, darkAccents[accent].badgeBackground)).toBeGreaterThanOrEqual(4.5);
    }

    const gradient = buildDiscogeniusSearchUnderlineGradient("dark");
    for (const accent of discogeniusAccentKeys) {
      expect(gradient).toContain(darkAccents[accent].foreground);
    }
  });

  it.each(["light", "dark"] as const)("keeps %s filled brand controls readable", (mode) => {
    const theme = createDiscogeniusTheme(discogeniusOrangeTheme, mode);
    expect(contrastRatio(theme.colorNeutralForegroundOnBrand, theme.colorBrandBackground)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(theme.colorNeutralForegroundOnBrand, theme.colorBrandBackgroundHover)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(theme.colorNeutralForegroundOnBrand, theme.colorBrandBackgroundPressed)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(["light", "dark"] as const)("keeps %s brand foreground readable", (mode) => {
    const theme = createDiscogeniusTheme(discogeniusOrangeTheme, mode);
    expect(contrastRatio(theme.colorBrandForeground1, theme.colorNeutralBackground1)).toBeGreaterThanOrEqual(4.5);
  });
});
