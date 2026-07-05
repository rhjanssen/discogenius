import React from "react";
import { Badge, makeStyles, mergeClasses, tokens } from "@fluentui/react-components";
import { tidalBadgeColor, tidalBadgeColorLight } from "@/theme/theme";
import { useTheme } from "@/providers/themeContext";
import { isSpatialAudioQuality, normalizeQualityTag } from "@/utils/spatialAudio";

// Standard quality values we store in DB (no underscore in HIRES)
export type AudioQuality = string;

type BadgeSize = "small" | "medium" | "large";

interface QualityBadgeProps {
    quality: string;
    className?: string;
    size?: BadgeSize;
}

// Horizontal "Dolby Atmos" lockup aspect ratio (viewBox 110.76 × 15.64). The
// logo renders at a fixed height per size and the badge widens to fit it, so the
// Atmos badge lines up in height with the text badges — it's just longer.
const ATMOS_ASPECT = 110.7599945 / 15.6427517;
const ATMOS_LOGO_HEIGHT: Record<BadgeSize, number> = { small: 10, medium: 12, large: 14 };
const ATMOS_LOGO_OFFSET_Y: Record<BadgeSize, number> = { small: 0.75, medium: 1, large: 1 };

function transparentHex(hex: string, alpha: number): string {
    const normalized = hex.replace("#", "");
    if (!/^[\da-f]{6}$/i.test(normalized)) {
        return hex;
    }
    const value = Number.parseInt(normalized, 16);
    const r = (value >> 16) & 255;
    const g = (value >> 8) & 255;
    const b = value & 255;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

const useStyles = makeStyles({
    base: {
        fontWeight: tokens.fontWeightSemibold,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        boxSizing: "border-box",
        // Never let a flex parent squeeze the badge — that pushed the label
        // outside the rounded body. Hold the intrinsic width and clip cleanly.
        flexShrink: 0,
        whiteSpace: "nowrap",
        minWidth: "max-content",
        "::after": {
            display: "none",
        },
    },
    label: {
        textTransform: "uppercase",
        letterSpacing: "0",
    },
    textLabel: {
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        lineHeight: 1,
    },
    // Heights are intentionally NOT overridden — we let Fluent's `size` prop set
    // the badge height so a QualityBadge lines up exactly with a MediaTypeBadge
    // (and any other Fluent Badge) of the same size in a shared row. We only tune
    // the horizontal padding and font size here.
    small: {
        fontSize: tokens.fontSizeBase100,
        paddingLeft: tokens.spacingHorizontalSNudge,
        paddingRight: tokens.spacingHorizontalSNudge,
    },
    medium: {
        fontSize: tokens.fontSizeBase200,
        paddingLeft: tokens.spacingHorizontalS,
        paddingRight: tokens.spacingHorizontalS,
    },
    large: {
        fontSize: tokens.fontSizeBase300,
        paddingLeft: tokens.spacingHorizontalM,
        paddingRight: tokens.spacingHorizontalM,
    },
    atmos: {
        lineHeight: 0,
    },
    atmosLogo: {
        display: "block",
        flexShrink: 0,
        // colour set inline (white on dark, near-black on light)
        WebkitMaskImage: 'url("/assets/images/dolby_atmos_horizontal.svg")',
        maskImage: 'url("/assets/images/dolby_atmos_horizontal.svg")',
        WebkitMaskRepeat: "no-repeat",
        maskRepeat: "no-repeat",
        WebkitMaskPosition: "center",
        maskPosition: "center",
        WebkitMaskSize: "contain",
        maskSize: "contain",
    },
});

export const QualityBadge: React.FC<QualityBadgeProps> = ({ quality, className, size = "medium" }) => {
    const styles = useStyles();
    const { isDarkMode } = useTheme();
    const palette = isDarkMode ? tidalBadgeColor : tidalBadgeColorLight;
    const badgeAlpha = isDarkMode ? 0.64 : 0.72;

    const normalizedQuality = normalizeQualityTag(quality);
    const sizeClass = size === "small" ? styles.small : size === "large" ? styles.large : styles.medium;

    if (normalizedQuality === "DOLBY_ATMOS") {
        const logoHeight = ATMOS_LOGO_HEIGHT[size];
        return (
            <Badge
                shape="circular"
                appearance="tint"
                size={size}
                className={mergeClasses(styles.base, styles.atmos, sizeClass, className)}
                style={{ backgroundColor: transparentHex(palette.SpatialBackground, badgeAlpha) }}
                aria-label="Dolby Atmos"
            >
                <span
                    aria-hidden="true"
                    className={styles.atmosLogo}
                    style={{
                        height: `${logoHeight}px`,
                        width: `${Math.round(logoHeight * ATMOS_ASPECT)}px`,
                        backgroundColor: palette.SpatialText,
                        transform: `translateY(${ATMOS_LOGO_OFFSET_Y[size]}px)`,
                    }}
                />
            </Badge>
        );
    }

    let backgroundColor: string = `color-mix(in srgb, ${tokens.colorNeutralForeground3} 14%, transparent)`;
    let color: string = tokens.colorNeutralForeground3;
    let badgeText = quality;

    if (isSpatialAudioQuality(normalizedQuality)) {
        backgroundColor = transparentHex(palette.SpatialBackground, badgeAlpha);
        color = palette.SpatialText;
        badgeText = "Spatial";
    } else if (normalizedQuality === "HIRES_LOSSLESS") {
        backgroundColor = transparentHex(palette.YellowBackground, badgeAlpha);
        color = palette.YellowText;
        badgeText = "MAX";
    } else if (normalizedQuality === "LOSSLESS") {
        backgroundColor = transparentHex(palette.TealBackground, badgeAlpha);
        color = palette.TealText;
        badgeText = "HIGH";
    } else if (normalizedQuality?.includes("HIGH")) {
        badgeText = "High";
    } else if (normalizedQuality?.startsWith("MP4_")) {
        badgeText = normalizedQuality.replace("MP4_", "").toLowerCase();
    }

    return (
        <Badge
            shape="circular"
            appearance="tint"
            size={size}
            className={mergeClasses(styles.base, styles.label, sizeClass, className)}
            style={{ backgroundColor, color }}
        >
            <span className={styles.textLabel}>{badgeText}</span>
        </Badge>
    );
};
