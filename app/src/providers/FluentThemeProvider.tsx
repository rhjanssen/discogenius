import { useCallback, useEffect, useMemo, useState } from "react";
import { FluentProvider, createCSSRuleFromTheme } from "@fluentui/react-components";
import type { Theme, BrandVariants } from "@fluentui/react-components";
import {
    buildDiscogeniusSearchUnderlineGradient,
    createDiscogeniusTheme,
    darkTheme,
    discogeniusAccentKeys,
    discogeniusSearchUnderlineGradientCssVariable,
    getDiscogeniusAccentCssVariable,
    getDiscogeniusAccentTokens,
    lightTheme,
} from "@/theme/theme";
import { ThemeProviderContext, type ThemeMode, type ThemeProviderState } from "@/providers/themeContext";
import { getBrandTokensFromPalette } from "@/theme/fluentThemeDesigner";

/**
 * Cache generated brand ramps so we don't recalculate on every render.
 */
const brandThemeCache = new Map<string, { light: Theme; dark: Theme }>();

function buildBrandThemes(brand: BrandVariants): { light: Theme; dark: Theme } {
    return {
        light: createDiscogeniusTheme(brand, "light"),
        dark: createDiscogeniusTheme(brand, "dark"),
    };
}

function getOrCreateBrandThemes(keyColor: string): { light: Theme; dark: Theme } | null {
    const hex = keyColor.startsWith("#") ? keyColor : `#${keyColor}`;
    if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return null;
    const cached = brandThemeCache.get(hex);
    if (cached) return cached;
    const brand = getBrandTokensFromPalette(hex);
    const themes = buildBrandThemes(brand);
    brandThemeCache.set(hex, themes);
    return themes;
}

type ThemeProviderProps = {
    children: React.ReactNode;
    defaultTheme?: ThemeMode;
    storageKey?: string;
};

export function FluentThemeProvider({
    children,
    defaultTheme = "system",
    storageKey = "discogenius-theme",
    ...props
}: ThemeProviderProps) {
    const [theme, setTheme] = useState<ThemeMode>(
        () => (localStorage.getItem(storageKey) as ThemeMode) || defaultTheme
    );
    const [brandKeyColor, setBrandKeyColorRaw] = useState<string | null>(null);
    const setBrandKeyColor = useCallback((c: string | null) => setBrandKeyColorRaw(c), []);

    useEffect(() => {
        const root = window.document.documentElement;
        root.classList.remove("light", "dark");

        if (theme === "system") {
            const systemTheme = window.matchMedia("(prefers-color-scheme: dark)")
                .matches
                ? "dark"
                : "light";
            root.classList.add(systemTheme);
            return;
        }

        root.classList.add(theme);
    }, [theme]);

    const isDarkMode = theme === "dark"
        || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);

    const dynamicAccentBrand = useMemo(() => {
        if (!brandKeyColor) {
            return null;
        }

        const hex = brandKeyColor.startsWith("#") ? brandKeyColor : `#${brandKeyColor}`;
        if (!/^#[0-9a-fA-F]{6}$/.test(hex)) {
            return null;
        }

        return getBrandTokensFromPalette(hex);
    }, [brandKeyColor]);

    const accentTokens = useMemo(
        () => getDiscogeniusAccentTokens(isDarkMode ? "dark" : "light", dynamicAccentBrand),
        [dynamicAccentBrand, isDarkMode]
    );

    const fluentTheme = useMemo(() => {
        const baseTheme = isDarkMode ? darkTheme : lightTheme;
        if (!brandKeyColor) return baseTheme;
        const brandThemes = getOrCreateBrandThemes(brandKeyColor);
        if (!brandThemes) return baseTheme;
        const dynamicTheme = isDarkMode ? brandThemes.dark : brandThemes.light;
        // Merge: use dynamic brand tokens on top of the base neutral tokens
        return { ...baseTheme, ...dynamicTheme };
    }, [isDarkMode, brandKeyColor]);

    const value: ThemeProviderState = {
        theme,
        setTheme: (theme: ThemeMode) => {
            localStorage.setItem(storageKey, theme);
            setTheme(theme);
        },
        isDarkMode,
        brandKeyColor,
        setBrandKeyColor,
    };

    useEffect(() => {
        const cssRule = createCSSRuleFromTheme(":root", fluentTheme);
        const styleId = "discogenius-fluent-theme";
        let styleTag = document.getElementById(styleId) as HTMLStyleElement | null;
        if (!styleTag) {
            styleTag = document.createElement("style");
            styleTag.id = styleId;
            document.head.appendChild(styleTag);
        }
        styleTag.textContent = cssRule;
    }, [fluentTheme]);

    useEffect(() => {
        const root = document.documentElement;
        for (const accent of discogeniusAccentKeys) {
            root.style.setProperty(getDiscogeniusAccentCssVariable(accent), accentTokens[accent].foreground);
            root.style.setProperty(getDiscogeniusAccentCssVariable(accent, "background"), accentTokens[accent].background);
        }
        root.style.setProperty(
            discogeniusSearchUnderlineGradientCssVariable,
            buildDiscogeniusSearchUnderlineGradient(accentTokens)
        );
    }, [accentTokens]);

    return (
        <ThemeProviderContext.Provider {...props} value={value}>
            <FluentProvider theme={fluentTheme}>{children}</FluentProvider>
        </ThemeProviderContext.Provider>
    );
}
