import { createDarkTheme, createLightTheme } from "@fluentui/react-components";
import { describe, expect, it } from "vitest";
import {
  buildDiscogeniusSearchUnderlineGradient,
  createDiscogeniusTheme,
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
  it("uses brand 100 as the light rest step for fills, compounds, and icons", () => {
    const theme = createDiscogeniusTheme(discogeniusOrangeTheme, "light");
    const stock = createLightTheme(discogeniusOrangeTheme);
    expect(theme.colorBrandForeground1).toBe(discogeniusOrangeTheme[100]);
    expect(theme.colorBrandBackground).toBe(discogeniusOrangeTheme[100]);
    expect(theme.colorBrandBackgroundHover).toBe(discogeniusOrangeTheme[90]);
    expect(theme.colorBrandBackgroundPressed).toBe(discogeniusOrangeTheme[60]);
    expect(theme.colorBrandBackgroundSelected).toBe(discogeniusOrangeTheme[80]);
    expect(theme.colorCompoundBrandBackground).toBe(discogeniusOrangeTheme[100]);
    expect(theme.colorCompoundBrandBackgroundHover).toBe(discogeniusOrangeTheme[90]);
    expect(theme.colorCompoundBrandStroke).toBe(discogeniusOrangeTheme[100]);
    expect(theme.colorBrandForeground2).toBe(stock.colorBrandForeground2);
    expect(theme.colorBrandBackground2).toBe(stock.colorBrandBackground2);
    expect(theme.colorNeutralForeground1).toBe(stock.colorNeutralForeground1);
  });

  it("uses brand 110 as the dark rest step for fills, compounds, and icons", () => {
    const theme = createDiscogeniusTheme(discogeniusOrangeTheme, "dark");
    const stock = createDarkTheme(discogeniusOrangeTheme);
    expect(theme.colorBrandForeground1).toBe(discogeniusOrangeTheme[110]);
    expect(theme.colorBrandForeground2).toBe(discogeniusOrangeTheme[120]);
    expect(theme.colorBrandBackground).toBe(discogeniusOrangeTheme[110]);
    expect(theme.colorBrandBackgroundHover).toBe(discogeniusOrangeTheme[120]);
    expect(theme.colorBrandBackgroundPressed).toBe(discogeniusOrangeTheme[80]);
    expect(theme.colorBrandBackgroundSelected).toBe(discogeniusOrangeTheme[100]);
    expect(theme.colorCompoundBrandBackground).toBe(discogeniusOrangeTheme[110]);
    expect(theme.colorCompoundBrandBackgroundHover).toBe(discogeniusOrangeTheme[120]);
    expect(theme.colorCompoundBrandStroke).toBe(discogeniusOrangeTheme[110]);
    expect(theme.colorBrandBackground2).toBe(stock.colorBrandBackground2);
    expect(theme.colorNeutralForeground1).toBe(stock.colorNeutralForeground1);
    expect(theme.colorNeutralBackground1).toBe(stock.colorNeutralBackground1);
  });

  it("uses brand-text tokens for accent icons and tint-badge polarity for type chips", () => {
    const lightAccents = getDiscogeniusAccentTokens("light");
    const darkAccents = getDiscogeniusAccentTokens("dark");
    const lightTheme = createDiscogeniusTheme(discogeniusOrangeTheme, "light");
    const darkTheme = createDiscogeniusTheme(discogeniusOrangeTheme, "dark");

    expect(lightAccents.artists.foreground).toBe(lightTheme.colorBrandForeground1);
    expect(darkAccents.artists.foreground).toBe(darkTheme.colorBrandForeground1);
    expect(lightAccents.artists.badgeForeground).toBe(lightTheme.colorBrandForeground2);
    expect(lightAccents.artists.badgeBackground).toBe(lightTheme.colorBrandBackground2);
    expect(darkAccents.artists.badgeForeground).toBe(darkTheme.colorBrandForeground2);
    expect(darkAccents.artists.badgeBackground).toBe(darkTheme.colorBrandBackground2);

    for (const accent of discogeniusAccentKeys) {
      const light = createDiscogeniusTheme(discogeniusAuxiliaryThemes[accent], "light");
      const dark = createDiscogeniusTheme(discogeniusAuxiliaryThemes[accent], "dark");
      expect(lightAccents[accent].foreground).toBe(light.colorBrandForeground1);
      expect(darkAccents[accent].foreground).toBe(dark.colorBrandForeground1);
      expect(contrastRatio(darkAccents[accent].foreground, dark.colorNeutralBackground1)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(lightAccents[accent].badgeForeground, lightAccents[accent].badgeBackground)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(darkAccents[accent].badgeForeground, darkAccents[accent].badgeBackground)).toBeGreaterThanOrEqual(4.5);
    }

    const gradient = buildDiscogeniusSearchUnderlineGradient("dark");
    for (const accent of discogeniusAccentKeys) {
      expect(gradient).toContain(darkAccents[accent].foreground);
    }
  });

  it("keeps dark brand text readable on the page", () => {
    const theme = createDiscogeniusTheme(discogeniusOrangeTheme, "dark");
    expect(contrastRatio(theme.colorBrandForeground1, theme.colorNeutralBackground1)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(["light", "dark"] as const)("keeps %s pressed filled brand darker than rest", (mode) => {
    const theme = createDiscogeniusTheme(discogeniusOrangeTheme, mode);
    expect(theme.colorBrandBackgroundPressed).not.toBe(theme.colorBrandBackground);
    expect(theme.colorBrandBackgroundHover).not.toBe(theme.colorBrandBackground);
  });
});
