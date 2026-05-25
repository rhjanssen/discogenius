import React from "react";
import { Badge, makeStyles, mergeClasses, tokens } from "@fluentui/react-components";
import { tidalBadgeColor } from "@/theme/theme";
import { useTheme } from "@/providers/themeContext";
import { isSpatialAudioQuality, normalizeQualityTag } from "@/utils/spatialAudio";

// Standard quality values we store in DB (no underscore in HIRES)
export type AudioQuality = string;

interface QualityBadgeProps {
    quality: string;
    className?: string;
    size?: "small" | "medium" | "large";
}

const useStyles = makeStyles({
    base: {
        fontWeight: tokens.fontWeightBold,
        border: "none",
        "::after": {
            display: "none",
        },
    },
    spatial: {
        backgroundColor: "#000000",
        color: "#ffffff",
    },
    hiRes: {
        backgroundColor: tidalBadgeColor.YellowBackground,
        color: tidalBadgeColor.YellowText,
    },
    lossless: {
        backgroundColor: tidalBadgeColor.TealBackground,
        color: tidalBadgeColor.TealText,
    },
    high: {
        backgroundColor: tokens.colorNeutralBackground3,
        color: tokens.colorNeutralForeground3,
    },
    default: {
        backgroundColor: tokens.colorNeutralBackground3,
        color: tokens.colorNeutralForeground3,
    },
    label: {
        textTransform: "uppercase",
    },
    // Sizes
    small: {
        height: "16px",
        fontSize: tokens.fontSizeBase100,
        padding: `0 ${tokens.spacingHorizontalXS}`,
    },
    medium: {
        height: "20px",
        fontSize: tokens.fontSizeBase100,
        padding: `0 ${tokens.spacingHorizontalSNudge}`,
    },
    large: {
        height: "24px",
        fontSize: tokens.fontSizeBase200,
        padding: `0 ${tokens.spacingHorizontalS}`,
    },
    atmosBadge: {
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        borderStyle: "solid",
        borderWidth: tokens.strokeWidthThin,
        lineHeight: 0,
        textTransform: "none",
    },
    atmosBadgeDark: {
        backgroundColor: "#ffffff",
        borderColor: "rgba(255, 255, 255, 0.82)",
        color: "#020202",
    },
    atmosBadgeLight: {
        backgroundColor: "#111111",
        borderColor: "rgba(0, 0, 0, 0.72)",
        color: "#ffffff",
    },
    atmosLogo: {
        display: "block",
        flexShrink: 0,
        backgroundColor: "currentColor",
        WebkitMaskImage: 'url("/assets/images/dolby_atmos_logo.svg")',
        maskImage: 'url("/assets/images/dolby_atmos_logo.svg")',
        WebkitMaskRepeat: "no-repeat",
        maskRepeat: "no-repeat",
        WebkitMaskPosition: "center",
        maskPosition: "center",
        WebkitMaskSize: "contain",
        maskSize: "contain",
    },
    atmosSmall: {
        height: tokens.lineHeightBase300,
        minWidth: "46px",
        padding: `0 ${tokens.spacingHorizontalXS}`,
        borderRadius: tokens.borderRadiusMedium,
    },
    atmosMedium: {
        height: tokens.lineHeightBase400,
        minWidth: "56px",
        padding: `0 ${tokens.spacingHorizontalSNudge}`,
        borderRadius: tokens.borderRadiusMedium,
    },
    atmosLarge: {
        height: "28px",
        minWidth: "68px",
        padding: `0 ${tokens.spacingHorizontalS}`,
        borderRadius: tokens.borderRadiusLarge,
    },
    atmosLogoSmall: {
        width: "36px",
        height: "14px",
    },
    atmosLogoMedium: {
        width: "48px",
        height: "18px",
    },
    atmosLogoLarge: {
        width: "57px",
        height: "21px",
    },
});

export const QualityBadge: React.FC<QualityBadgeProps> = ({ quality, className, size = "medium" }) => {
    const styles = useStyles();
    const { isDarkMode } = useTheme();

    // Normalize input string
    const normalizedQuality = normalizeQualityTag(quality);

    let badgeClass = styles.default;
    let badgeText = quality;

    if (isSpatialAudioQuality(normalizedQuality)) {
        badgeClass = styles.spatial;
        badgeText = "Spatial";
    } else if (normalizedQuality === "HIRES_LOSSLESS") {
        badgeClass = styles.hiRes;
        badgeText = "24-BIT";
    } else if (normalizedQuality === "LOSSLESS") {
        badgeClass = styles.lossless;
        badgeText = "16-BIT";
    } else if (normalizedQuality?.includes("HIGH")) {
        badgeClass = styles.high;
        badgeText = "High";
    } else if (normalizedQuality?.startsWith("MP4_")) {
        badgeClass = styles.high; // Use standard badge colors for video
        badgeText = normalizedQuality.replace("MP4_", "").toLowerCase();
    }

    const sizeClass = size === "small" ? styles.small : size === "large" ? styles.large : styles.medium;

    if (normalizedQuality === "DOLBY_ATMOS") {
        const atmosSizeClass = size === "small" ? styles.atmosSmall : size === "large" ? styles.atmosLarge : styles.atmosMedium;
        const atmosLogoSizeClass = size === "small" ? styles.atmosLogoSmall : size === "large" ? styles.atmosLogoLarge : styles.atmosLogoMedium;

        return (
            <Badge
                shape="rounded"
                appearance="tint"
                className={mergeClasses(
                    styles.base,
                    styles.atmosBadge,
                    isDarkMode ? styles.atmosBadgeDark : styles.atmosBadgeLight,
                    atmosSizeClass,
                    className
                )}
                aria-label="Dolby Atmos"
                title="Dolby Atmos"
            >
                <span
                    aria-hidden="true"
                    className={mergeClasses(styles.atmosLogo, atmosLogoSizeClass)}
                />
            </Badge>
        );
    }

    return (
        <Badge
            shape="rounded"
            appearance="tint"
            className={mergeClasses(styles.base, styles.label, badgeClass, sizeClass, className)}
        >
            {badgeText}
        </Badge>
    );
};
