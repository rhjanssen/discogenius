import React from "react";
import { Badge, makeStyles, mergeClasses, tokens, shorthands } from "@fluentui/react-components";
import { tidalBadgeColor, tidalBadgeColorLight, badgeStrokeColor } from "@/theme/theme";
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

const useStyles = makeStyles({
    base: {
        fontWeight: tokens.fontWeightBold,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        boxSizing: "border-box",
        // Consistent thin stroke on every badge; the colour is applied inline so
        // it can flip per theme (faint light stroke on dark, faint dark on light).
        ...shorthands.borderStyle("solid"),
        ...shorthands.borderWidth(tokens.strokeWidthThin),
        // Never let a flex parent squeeze the badge — that pushed the label
        // outside the rounded body. Hold the intrinsic width and clip cleanly.
        flexShrink: 0,
        whiteSpace: "nowrap",
        "::after": {
            display: "none",
        },
    },
    label: {
        textTransform: "uppercase",
        letterSpacing: "0.02em",
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
    const borderColor = badgeStrokeColor(isDarkMode);

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
                style={{ backgroundColor: palette.SpatialBackground, borderColor }}
                aria-label="Dolby Atmos"
                title="Dolby Atmos"
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

    let backgroundColor: string = tokens.colorNeutralBackground3;
    let color: string = tokens.colorNeutralForeground3;
    let badgeText = quality;

    if (isSpatialAudioQuality(normalizedQuality)) {
        backgroundColor = palette.SpatialBackground;
        color = palette.SpatialText;
        badgeText = "Spatial";
    } else if (normalizedQuality === "HIRES_LOSSLESS") {
        backgroundColor = palette.YellowBackground;
        color = palette.YellowText;
        badgeText = "24-BIT";
    } else if (normalizedQuality === "LOSSLESS") {
        backgroundColor = palette.TealBackground;
        color = palette.TealText;
        badgeText = "16-BIT";
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
            style={{ backgroundColor, color, borderColor }}
        >
            {badgeText}
        </Badge>
    );
};
