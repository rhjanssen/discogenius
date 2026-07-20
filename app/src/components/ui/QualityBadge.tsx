import React from "react";
import { Badge, makeStyles, mergeClasses, tokens } from "@fluentui/react-components";
import { tidalBadgeColor, tidalBadgeColorLight } from "@/theme/theme";
import { useTheme } from "@/providers/themeContext";
import { isSpatialAudioQuality, normalizeQualityTag } from "@/utils/spatialAudio";
import {
  isUnknownQualityTag,
  isVideoResolutionQuality,
  qualityDescription,
  stereoQualityTier,
  videoQualityTier,
} from "@/utils/qualityTier";
import {
  ATMOS_LOGO_HEIGHT_PX,
  BADGE_HEIGHT_PX,
  type DiscogeniusBadgeSize,
} from "./badgeSizes";

export type AudioQuality = string;

type BadgeSize = DiscogeniusBadgeSize;

interface QualityBadgeProps {
    quality: string;
    className?: string;
    size?: BadgeSize;
}

// Horizontal "Dolby Atmos" lockup aspect ratio (viewBox 110.76 × 15.64).
const ATMOS_ASPECT = 110.7599945 / 15.6427517;

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
        flexShrink: 0,
        whiteSpace: "nowrap",
        minWidth: "max-content",
        lineHeight: 1,
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
    // Explicit heights match BADGE_HEIGHT_PX / provider pills in each size group.
    small: {
        height: `${BADGE_HEIGHT_PX.small}px`,
        minHeight: `${BADGE_HEIGHT_PX.small}px`,
        maxHeight: `${BADGE_HEIGHT_PX.small}px`,
        fontSize: tokens.fontSizeBase100,
        paddingLeft: tokens.spacingHorizontalSNudge,
        paddingRight: tokens.spacingHorizontalSNudge,
        paddingTop: 0,
        paddingBottom: 0,
    },
    medium: {
        height: `${BADGE_HEIGHT_PX.medium}px`,
        minHeight: `${BADGE_HEIGHT_PX.medium}px`,
        maxHeight: `${BADGE_HEIGHT_PX.medium}px`,
        fontSize: tokens.fontSizeBase200,
        paddingLeft: tokens.spacingHorizontalS,
        paddingRight: tokens.spacingHorizontalS,
        paddingTop: 0,
        paddingBottom: 0,
    },
    large: {
        height: `${BADGE_HEIGHT_PX.large}px`,
        minHeight: `${BADGE_HEIGHT_PX.large}px`,
        maxHeight: `${BADGE_HEIGHT_PX.large}px`,
        fontSize: tokens.fontSizeBase300,
        paddingLeft: tokens.spacingHorizontalM,
        paddingRight: tokens.spacingHorizontalM,
        paddingTop: 0,
        paddingBottom: 0,
    },
    atmos: {
        lineHeight: 0,
    },
    atmosLogo: {
        display: "block",
        flexShrink: 0,
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
    const badgeAlpha = isDarkMode ? 0.72 : 0.82;

    const normalizedQuality = normalizeQualityTag(quality);
    const sizeClass = size === "small" ? styles.small : size === "large" ? styles.large : styles.medium;

    if (isUnknownQualityTag(normalizedQuality)) {
        return null;
    }

    if (normalizedQuality === "DOLBY_ATMOS") {
        const logoHeight = ATMOS_LOGO_HEIGHT_PX[size];
        return (
            <Badge
                shape="circular"
                appearance="tint"
                size={size}
                className={mergeClasses(styles.base, styles.atmos, sizeClass, className)}
                style={{ backgroundColor: transparentHex(palette.SpatialBackground, badgeAlpha) }}
                aria-label="Dolby Atmos"
                title={qualityDescription(quality)}
            >
                <span
                    aria-hidden="true"
                    className={styles.atmosLogo}
                    style={{
                        height: `${logoHeight}px`,
                        width: `${Math.round(logoHeight * ATMOS_ASPECT)}px`,
                        backgroundColor: palette.SpatialText,
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
    } else if (isVideoResolutionQuality(normalizedQuality)) {
        const tier = videoQualityTier(normalizedQuality);
        if (!tier) return null;
        badgeText = tier;
    } else {
        const tier = stereoQualityTier(normalizedQuality);
        badgeText = tier;
        if (tier === "MAX") {
            backgroundColor = transparentHex(palette.YellowBackground, badgeAlpha);
            color = palette.YellowText;
        } else if (tier === "HIGH") {
            backgroundColor = transparentHex(palette.TealBackground, badgeAlpha);
            color = palette.TealText;
        } else if (tier === "LOW") {
            backgroundColor = `color-mix(in srgb, ${tokens.colorNeutralForeground4} 10%, transparent)`;
            color = tokens.colorNeutralForeground4;
        }
    }

    return (
        <Badge
            shape="circular"
            appearance="tint"
            size={size}
            className={mergeClasses(styles.base, styles.label, sizeClass, className)}
            style={{ backgroundColor, color }}
            title={qualityDescription(quality)}
        >
            <span className={styles.textLabel}>{badgeText}</span>
        </Badge>
    );
};
