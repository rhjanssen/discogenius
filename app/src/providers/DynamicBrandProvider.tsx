import { useEffect, type ReactNode } from "react";
import { useTheme } from "@/providers/themeContext";
import type { UltraBlurColors } from "@/ultrablur/colors";
import { hexToRgb } from "@/ultrablur/color";

interface DynamicBrandProviderProps {
    /** Hex color to use as the brand seed (e.g. "#A34FCC"). When falsy, children render with default brand. */
    keyColor?: string | null;
    children: ReactNode;
}

/**
 * Pick the most chromatic (saturated) hex color from UltraBlur corners.
 * Falls back to null if all corners are near-grey.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function dominantUltraBlurColor(colors: UltraBlurColors): string | null {
    const corners = [colors.topLeft, colors.topRight, colors.bottomLeft, colors.bottomRight];
    let best: string | null = null;
    let bestSat = 0;

    for (const hex of corners) {
        try {
            const { r, g, b } = hexToRgb(hex);
            const rf = r / 255, gf = g / 255, bf = b / 255;
            const max = Math.max(rf, gf, bf);
            const min = Math.min(rf, gf, bf);
            const l = (max + min) / 2;
            const d = max - min;
            const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
            if (sat > bestSat) {
                bestSat = sat;
                best = hex;
            }
        } catch {
            // skip invalid
        }
    }

    return bestSat >= 0.12 ? best : null;
}

/**
 * Sets the global brand key color when mounted or when keyColor changes.
 * Always updates — sets null when no color is provided so the brand
 * resets properly when navigating between pages.
 */
export function DynamicBrandProvider({ keyColor, children }: DynamicBrandProviderProps) {
    const { setBrandKeyColor } = useTheme();

    useEffect(() => {
        setBrandKeyColor(keyColor || null);
    }, [keyColor, setBrandKeyColor]);

    return <>{children}</>;
}
