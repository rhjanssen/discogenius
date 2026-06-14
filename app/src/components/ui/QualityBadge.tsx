import React from "react";
import { Badge, makeStyles, mergeClasses, tokens, shorthands } from "@fluentui/react-components";
import { tidalBadgeColor } from "@/theme/theme";
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
const ATMOS_LOGO_HEIGHT: Record<BadgeSize, number> = { small: 10, medium: 13, large: 15 };

const useStyles = makeStyles({
    base: {
        fontWeight: tokens.fontWeightBold,
        ...shorthands.border("none"),
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
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
    hiRes: {
        backgroundColor: tidalBadgeColor.YellowBackground,
        color: tidalBadgeColor.YellowText,
    },
    lossless: {
        backgroundColor: tidalBadgeColor.TealBackground,
        color: tidalBadgeColor.TealText,
    },
    spatial: {
        backgroundColor: "#000000",
        color: "#ffffff",
    },
    high: {
        backgroundColor: tokens.colorNeutralBackground3,
        color: tokens.colorNeutralForeground3,
    },
    default: {
        backgroundColor: tokens.colorNeutralBackground3,
        color: tokens.colorNeutralForeground3,
    },
    // Consistent heights for ALL variants (text and Atmos) so a row of badges
    // lines up. Slightly larger than before for legibility.
    small: {
        height: "20px",
        fontSize: tokens.fontSizeBase200,
        ...shorthands.padding(0, tokens.spacingHorizontalSNudge),
    },
    medium: {
        height: "24px",
        fontSize: tokens.fontSizeBase200,
        ...shorthands.padding(0, tokens.spacingHorizontalS),
    },
    large: {
        height: "28px",
        fontSize: tokens.fontSizeBase300,
        ...shorthands.padding(0, tokens.spacingHorizontalM),
    },
    // Dolby Atmos: the canonical white-on-black lockup. Always white-on-black in
    // both themes (no theme flip); a faint light border keeps the chip defined
    // when it sits on a dark page.
    atmos: {
        backgroundColor: "#0a0a0a",
        ...shorthands.border(tokens.strokeWidthThin, "solid", "rgba(255, 255, 255, 0.16)"),
        lineHeight: 0,
    },
    atmosLogo: {
        display: "block",
        flexShrink: 0,
        backgroundColor: "#ffffff",
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

    // Normalize input string
    const normalizedQuality = normalizeQualityTag(quality);

    const sizeClass = size === "small" ? styles.small : size === "large" ? styles.large : styles.medium;

    if (normalizedQuality === "DOLBY_ATMOS") {
        const logoHeight = ATMOS_LOGO_HEIGHT[size];
        return (
            <Badge
                shape="circular"
                appearance="tint"
                className={mergeClasses(styles.base, styles.atmos, sizeClass, className)}
                aria-label="Dolby Atmos"
                title="Dolby Atmos"
            >
                <span
                    aria-hidden="true"
                    className={styles.atmosLogo}
                    style={{ height: `${logoHeight}px`, width: `${Math.round(logoHeight * ATMOS_ASPECT)}px` }}
                />
            </Badge>
        );
    }

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
