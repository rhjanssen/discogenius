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
    70: "#9b3000",
    80: "#b03901",
    90: "#c3450b",
    100: "#d65318",
    110: "#e86125",
    120: "#fa6f32",
    130: "#ff8751",
    140: "#ff9f74",
    150: "#ffb695",
    160: "#ffcbb4"
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
        foreground: { light: 110, dark: 130 },
        background: { light: 150, dark: 80 },
    },
    albums: {
        foreground: { light: 80, dark: 120 },
        background: { light: 150, dark: 30 },
    },
    tracks: {
        foreground: { light: 80, dark: 120 },
        background: { light: 150, dark: 30 },
    },
    videos: {
        foreground: { light: 110, dark: 140 },
        background: { light: 150, dark: 50 },
    },
};

const dynamicDiscogeniusAccentToneSteps: Record<DiscogeniusAccentTone, { light: BrandStep; dark: BrandStep }> = {
    foreground: { light: 80, dark: 140 },
    background: { light: 160, dark: 40 },
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

export function buildDiscogeniusSearchUnderlineGradient(accentTokens: DiscogeniusAccentTokens): string {
    return `linear-gradient(90deg, ${accentTokens.videos.foreground} 0%, ${accentTokens.tracks.foreground} 33%, ${accentTokens.albums.foreground} 66%, ${accentTokens.artists.foreground} 100%)`;
}

/**
 * Tidal quality badge colors - consistent with Tidal's UI
 * Used for QualityBadge component and file quality indicators
 */
export const tidalBadgeColor = {
    // Hi-Res / 24-bit (Gold/Yellow)
    YellowText: "#ffd432",
    YellowBackground: "#4d3c00",
    // Lossless / 16-bit (Teal/Blue)
    TealText: "#33ffee",
    TealBackground: "#004d46",
    // Atmos (Black)
    AtmosText: "#ffffff",
    AtmosBackground: "#000000",
} as const;

export function createDiscogeniusTheme(brand: BrandVariants, mode: "light" | "dark"): Theme {
    const baseTheme = mode === "dark" ? createDarkTheme(brand) : createLightTheme(brand);

    if (mode === "dark") {
        return {
            ...baseTheme,
            colorBrandForeground1: brand[130],
            colorBrandForeground2: brand[140],
            colorBrandBackground: brand[130],
            colorBrandBackground2: brand[120],
            colorBrandBackgroundHover: brand[140],
            colorBrandBackgroundPressed: brand[120],
            colorBrandStroke1: brand[140],
            colorBrandStroke2: brand[120],
            colorCompoundBrandBackground: brand[130],
            colorCompoundBrandBackgroundHover: brand[140],
            colorCompoundBrandBackgroundPressed: brand[120],
            colorCompoundBrandStroke: brand[140],
            colorCompoundBrandStrokeHover: brand[150],
            colorCompoundBrandStrokePressed: brand[120],
        };
    }

    return {
        ...baseTheme,
        colorBrandForeground1: brand[120],
        colorBrandForeground2: brand[110],
        colorBrandBackground: brand[120],
        colorBrandBackground2: brand[110],
        colorBrandBackgroundHover: brand[110],
        colorBrandBackgroundPressed: brand[130],
        colorBrandStroke1: brand[110],
        colorBrandStroke2: brand[130],
        colorCompoundBrandBackground: brand[120],
        colorCompoundBrandBackgroundHover: brand[110],
        colorCompoundBrandBackgroundPressed: brand[130],
        colorCompoundBrandStroke: brand[110],
        colorCompoundBrandStrokeHover: brand[100],
        colorCompoundBrandStrokePressed: brand[130],
    };
}

export const lightTheme: Theme = createDiscogeniusTheme(discogeniusOrangeTheme, "light");

export const darkTheme: Theme = createDiscogeniusTheme(discogeniusOrangeTheme, "dark");
