import React from "react";
import { Badge, makeStyles, mergeClasses, tokens } from "@fluentui/react-components";
import { tidalBadgeColor } from "@/theme/theme";

// Standard quality values we store in DB (no underscore in HIRES)
export type AudioQuality = "LOSSLESS" | "HIRES_LOSSLESS" | "DOLBY_ATMOS";

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
    atmos: {
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
    }
});

export const QualityBadge: React.FC<QualityBadgeProps> = ({ quality, className, size = "medium" }) => {
    const styles = useStyles();

    // Normalize input string
    const normalizedQuality = quality?.toUpperCase();

    let badgeClass = styles.default;
    let badgeText = quality;

    // Tidal only returns three quality tags: LOSSLESS, HIRES_LOSSLESS, DOLBY_ATMOS
    if (normalizedQuality === "DOLBY_ATMOS") {
        badgeClass = styles.atmos;
        badgeText = "Atmos";
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
        const logoHeightPx = size === "small" ? 9 : size === "large" ? 13 : 11;
        const logoAspect = 110.7599945 / 15.6427517; // viewBox width/height
        const logoWidthPx = Math.round(logoHeightPx * logoAspect);

        return (
            <Badge
                shape="circular"
                appearance="tint"
                className={mergeClasses(styles.base, badgeClass, sizeClass, className)}
                style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                }}
                aria-label="Dolby Atmos"
                title="Dolby Atmos"
            >
                <span
                    aria-hidden="true"
                    style={{
                        height: `${logoHeightPx}px`,
                        width: `${logoWidthPx}px`,
                        display: "block",
                        backgroundColor: tokens.colorNeutralForegroundOnBrand,
                        WebkitMaskImage: 'url("/assets/images/dolby_atmos_logo.svg")',
                        maskImage: 'url("/assets/images/dolby_atmos_logo.svg")',
                        WebkitMaskRepeat: "no-repeat",
                        maskRepeat: "no-repeat",
                        WebkitMaskPosition: "center",
                        maskPosition: "center",
                        WebkitMaskSize: "contain",
                        maskSize: "contain",
                        flexShrink: 0,
                    }}
                />
            </Badge>
        );
    }

    return (
        <Badge
            shape="circular"
            appearance="tint"
            className={mergeClasses(styles.base, styles.label, badgeClass, sizeClass, className)}
        >
            {badgeText}
        </Badge>
    );
};
