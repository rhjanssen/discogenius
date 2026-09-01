import { createLightTheme, createDarkTheme } from "@fluentui/react-components";
import type { Theme, BrandVariants } from "@fluentui/react-components";

export const discogeniusLogoColor = {
    Orange: "#fc7134",
    Purple: "#8532ce",
    Teal: "#00bddf",
    Blue: "#2353ca"
} as const;

export const discogeniusOrangeTheme: BrandVariants = {
    10: "#070200",
    20: "#271100",
    30: "#421800",
    40: "#581d00",
    50: "#6e2800",
    60: "#943800",
    // Fluent uses 80 for light filled controls and 70 for dark filled
    // controls. These stay recognisably orange while retaining white-text
    // contrast in both modes.
    70: "#ba4a00",
    80: "#c45100",
    90: "#db6413",
    100: "#ef772c",
    110: "#f98747",
    120: "#ff9b69",
    130: "#ffb695",
    140: "#ffcbb4",
    150: "#ffddcf",
    160: "#ffece4"
};

export const discogeniusPurpleTheme: BrandVariants = {
    10: "#0a000f",
    20: "#280547",
    30: "#400274",
    40: "#51068e",
    50: "#6111a5",
    60: "#711fb9",
    70: "#812ecb",
    80: "#913ed9",
    90: "#9f4fe5",
    100: "#ad61ed",
    110: "#ba73f4",
    120: "#c686fa",
    130: "#d299fe",
    140: "#dcacff",
    150: "#e5c0ff",
    160: "#eed4ff",
};

export const discogeniusBlueTheme: BrandVariants = {
    10: "#030210",
    20: "#001648",
    30: "#00266c",
    40: "#003186",
    50: "#003ca0",
    60: "#0248bc",
    70: "#2654cc",
    80: "#3f62d9",
    90: "#556fe4",
    100: "#6a7ded",
    110: "#7e8cf3",
    120: "#929bf8",
    130: "#a4aafc",
    140: "#b7baff",
    150: "#c9caff",
    160: "#dadaff",
};

export const discogeniusTealTheme: BrandVariants = {
    10: "#000406",
    20: "#001d24",
    30: "#002f39",
    40: "#003c49",
    50: "#004958",
    60: "#005768",
    70: "#006679",
    80: "#00748a",
    90: "#00839c",
    100: "#0092ad",
    110: "#00a2c0",
    120: "#00b2d2",
    130: "#19c2e4",
    140: "#51cfef",
    150: "#7fdcf6",
    160: "#a9e8fb",
};

export const discogeniusAccentKeyColor = {
    artists: discogeniusLogoColor.Orange,
    albums: discogeniusLogoColor.Purple,
    tracks: discogeniusLogoColor.Blue,
    videos: discogeniusLogoColor.Teal,
} as const;

export type DiscogeniusAccentKey = keyof typeof discogeniusAccentKeyColor;

export const discogeniusAuxiliaryThemes: Record<DiscogeniusAccentKey, BrandVariants> = {
    artists: discogeniusOrangeTheme,
    albums: discogeniusPurpleTheme,
    tracks: discogeniusBlueTheme,
    videos: discogeniusTealTheme,
};

type DiscogeniusAccentTone = "foreground" | "background" | "badgeForeground" | "badgeBackground";

export type DiscogeniusAccentTokens = Record<DiscogeniusAccentKey, Record<DiscogeniusAccentTone, string>>;

export const discogeniusAccentKeys = ["artists", "albums", "tracks", "videos"] as const;

export const discogeniusSearchUnderlineGradientCssVariable = "--dg-search-underline-gradient";

export function getDiscogeniusAccentTokens(mode: "light" | "dark"): DiscogeniusAccentTokens {
    return discogeniusAccentKeys.reduce((map, accent) => {
        const brand = discogeniusAuxiliaryThemes[accent];
        const theme = createDiscogeniusTheme(brand, mode);
        map[accent] = {
            // Same Fluent brand-text token the rest of the UI uses (light 80 /
            // dark 110 after the theme-designer override). Logo hex stays on
            // UltraBlur seeds and the wordmark, not on dashboard stats.
            foreground: theme.colorBrandForeground1,
            background: theme.colorBrandBackground2,
            badgeForeground: theme.colorBrandForeground2,
            badgeBackground: theme.colorBrandBackground2,
        };
        return map;
    }, {} as DiscogeniusAccentTokens);
}

export function getDiscogeniusAccentCssVariable(
    accent: DiscogeniusAccentKey,
    tone: DiscogeniusAccentTone = "foreground"
) {
    if (tone === "foreground") return `--dg-accent-${accent}`;
    if (tone === "background") return `--dg-accent-${accent}-background`;
    if (tone === "badgeForeground") return `--dg-accent-${accent}-badge-foreground`;
    return `--dg-accent-${accent}-badge-background`;
}

export function buildDiscogeniusSearchUnderlineGradient(mode: "light" | "dark"): string {
    const accents = getDiscogeniusAccentTokens(mode);
    return `linear-gradient(90deg, ${accents.videos.foreground} 0%, ${accents.tracks.foreground} 33%, ${accents.albums.foreground} 66%, ${accents.artists.foreground} 100%)`;
}

/**
 * Tidal quality badge colors - consistent with Tidal's UI
 * Used for QualityBadge component and file quality indicators
 */
export const tidalBadgeColor = {
    // Dark mode — dark fill + bright text (Tidal's canonical look).
    // Hi-Res / 24-bit (Gold/Yellow)
    YellowText: "#ffd432",
    YellowBackground: "#4d3c00",
    // Lossless / 16-bit (Teal/Blue)
    TealText: "#33ffee",
    TealBackground: "#004d46",
    // Spatial audio
    SpatialText: "#ffffff",
    SpatialBackground: "#0a0a0a",
} as const;

/**
 * Light-mode quality badge colours — soft coloured fill + dark text, so the
 * pills flip to "dark-on-light" in light mode instead of staying dark chips.
 */
export const tidalBadgeColorLight = {
    YellowText: "#5a4500",
    YellowBackground: "#ffe48a",
    TealText: "#00463f",
    TealBackground: "#9cefe4",
    SpatialText: "#111111",
    SpatialBackground: "#ededed",
} as const;

/**
 * Fluent's theme designer keeps `createLightTheme` / `createDarkTheme` as the
 * mapping, then lifts dark-mode brand *text* to 110/120 so links and selected
 * indicators stay recognizable on dark chrome:
 * https://react.fluentui.dev/?path=/docs/theme-theme-designer--docs
 *
 * Orange (and similar warm ramps) also make `createDarkTheme`'s filled brand
 * step (70) read as brown. Use the lightest filled step that still has 4.5:1
 * with white on-brand text.
 */
function applyFluentDarkBrandOverrides(theme: Theme, brand: BrandVariants): Theme {
    return {
        ...theme,
        colorBrandForeground1: brand[110],
        colorBrandForeground2: brand[120],
        colorCompoundBrandForeground1: brand[110],
        colorCompoundBrandForeground1Hover: brand[120],
        colorCompoundBrandForeground1Pressed: brand[130],
        colorBrandBackground: brand[80],
        colorBrandBackgroundHover: brand[80],
        colorBrandBackgroundPressed: brand[70],
        colorBrandBackgroundSelected: brand[80],
        colorCompoundBrandBackground: brand[80],
        colorCompoundBrandBackgroundHover: brand[80],
        colorCompoundBrandBackgroundPressed: brand[70],
    };
}

export function createDiscogeniusTheme(brand: BrandVariants, mode: "light" | "dark"): Theme {
    if (mode !== "dark") {
        return createLightTheme(brand);
    }
    return applyFluentDarkBrandOverrides(createDarkTheme(brand), brand);
}

export const lightTheme: Theme = createDiscogeniusTheme(discogeniusOrangeTheme, "light");

export const darkTheme: Theme = createDiscogeniusTheme(discogeniusOrangeTheme, "dark");
