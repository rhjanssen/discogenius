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
    50: "#6e2200",
    60: "#852900",
    // Fluent's dark theme uses step 70 for filled controls and its light theme
    // uses step 80. Keep both dark enough for white text, but closer to the
    // logo orange than the previous near-brown dark-theme control fill.
    70: "#b03901",
    80: "#c3450b",
    90: "#e86125",
    100: "#fa6f32",
    110: "#ff8751",
    120: "#ff9f74",
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

type BrandStep = 10 | 20 | 30 | 40 | 50 | 60 | 70 | 80 | 90 | 100 | 110 | 120 | 130 | 140 | 150 | 160;
type DiscogeniusAccentTone = "foreground" | "background";

export type DiscogeniusAccentTokens = Record<DiscogeniusAccentKey, Record<DiscogeniusAccentTone, string>>;

const discogeniusAccentToneSteps: Record<DiscogeniusAccentKey, Record<DiscogeniusAccentTone, { light: BrandStep; dark: BrandStep }>> = {
    artists: {
        foreground: { light: 60, dark: 100 },
        background: { light: 150, dark: 20 },
    },
    albums: {
        foreground: { light: 60, dark: 100 },
        background: { light: 150, dark: 20 },
    },
    tracks: {
        foreground: { light: 60, dark: 110 },
        background: { light: 150, dark: 20 },
    },
    videos: {
        foreground: { light: 60, dark: 120 },
        background: { light: 150, dark: 20 },
    },
};

const dynamicDiscogeniusAccentToneSteps: Record<DiscogeniusAccentTone, { light: BrandStep; dark: BrandStep }> = {
    foreground: { light: 60, dark: 100 },
    background: { light: 150, dark: 20 },
};

export const discogeniusAccentKeys = ["artists", "albums", "tracks", "videos"] as const;

export const discogeniusSearchUnderlineGradientCssVariable = "--dg-search-underline-gradient";

function getDiscogeniusAccentTone(
    brand: BrandVariants,
    accent: DiscogeniusAccentKey,
    tone: DiscogeniusAccentTone,
    mode: "light" | "dark"
): string {
    const step = discogeniusAccentToneSteps[accent][tone][mode];
    return brand[step];
}

function getDynamicDiscogeniusAccentTone(
    brand: BrandVariants,
    tone: DiscogeniusAccentTone,
    mode: "light" | "dark"
): string {
    const step = dynamicDiscogeniusAccentToneSteps[tone][mode];
    return brand[step];
}

export function getDiscogeniusAccentTokens(mode: "light" | "dark", dynamicBrand?: BrandVariants | null): DiscogeniusAccentTokens {
    return discogeniusAccentKeys.reduce((map, accent) => {
        const brand = dynamicBrand ?? discogeniusAuxiliaryThemes[accent];
        map[accent] = {
            foreground: dynamicBrand
                ? getDynamicDiscogeniusAccentTone(brand, "foreground", mode)
                : getDiscogeniusAccentTone(brand, accent, "foreground", mode),
            background: dynamicBrand
                ? getDynamicDiscogeniusAccentTone(brand, "background", mode)
                : getDiscogeniusAccentTone(brand, accent, "background", mode),
        };
        return map;
    }, {} as DiscogeniusAccentTokens);
}

export function getDiscogeniusAccentCssVariable(
    accent: DiscogeniusAccentKey,
    tone: "foreground" | "background" = "foreground"
) {
    return tone === "foreground"
        ? `--dg-accent-${accent}`
        : `--dg-accent-${accent}-background`;
}

export function buildDiscogeniusSearchUnderlineGradient(mode: "light" | "dark"): string {
    // Saturated media accents, not the pale foreground steps that grey out in dark mode.
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

export function createDiscogeniusTheme(brand: BrandVariants, mode: "light" | "dark"): Theme {
    // Fluent maps a complete brand ramp to semantic tokens with mode-specific
    // contrast. Keep those mappings intact so Buttons, Tabs, Toggles and Badges
    // share the same accessible interaction states in light and dark themes.
    return mode === "dark" ? createDarkTheme(brand) : createLightTheme(brand);
}

export const lightTheme: Theme = createDiscogeniusTheme(discogeniusOrangeTheme, "light");

export const darkTheme: Theme = createDiscogeniusTheme(discogeniusOrangeTheme, "dark");
