/**
 * Shared DataGrid cell helper styles.
 *
 * Provides reusable makeStyles for common cell patterns:
 * thumbnail images, name/title cells, action button clusters, etc.
 */
import { makeStyles, tokens } from "@fluentui/react-components";

export const useDataGridCellStyles = makeStyles({
    /* Thumbnail images — circular (artists) */
    thumbnailCircle: {
        width: "36px",
        height: "36px",
        borderRadius: tokens.borderRadiusCircular,
        objectFit: "cover",
        backgroundColor: tokens.colorNeutralBackground3,
        "@media (min-width: 768px)": {
            width: "40px",
            height: "40px",
        },
    },
    /* Thumbnail images — square/rounded (albums, videos) */
    thumbnailSquare: {
        width: "36px",
        height: "36px",
        borderRadius: tokens.borderRadiusSmall,
        objectFit: "cover",
        backgroundColor: tokens.colorNeutralBackground3,
        "@media (min-width: 768px)": {
            width: "40px",
            height: "40px",
        },
    },
    /* Thumbnail images — wide (videos, 16:9) */
    thumbnailWide: {
        width: "72px",
        height: "40px",
        borderRadius: tokens.borderRadiusSmall,
        objectFit: "cover",
        backgroundColor: tokens.colorNeutralBackground3,
        "@media (min-width: 768px)": {
            width: "80px",
            height: "45px",
        },
    },
    /* Placeholder for missing thumbnails */
    thumbnailPlaceholder: {
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: tokens.colorNeutralForeground3,
        fontSize: tokens.fontSizeBase400,
        fontWeight: tokens.fontWeightBold,
    },
    /* Primary name/title text */
    nameCell: {
        fontWeight: tokens.fontWeightSemibold,
        fontSize: tokens.fontSizeBase300,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        minWidth: 0,
    },
    /* Secondary subtitle text under name */
    subtitleText: {
        fontSize: tokens.fontSizeBase200,
        color: tokens.colorNeutralForeground3,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        display: "block",
    },
    /* Container for name + subtitle stacked */
    nameStack: {
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
        gap: "1px",
    },
    /* Stat cell — center-aligned, subtle text */
    statCell: {
        fontSize: tokens.fontSizeBase200,
        color: tokens.colorNeutralForeground2,
        textAlign: "center",
    },
    /* Primary count in stat cell */
    statPrimary: {
        color: tokens.colorNeutralForeground1,
    },
    /* Muted part in stat cell */
    statSecondary: {
        opacity: 0.5,
    },
    /* Progress bar (Lidarr-style track completion) — value rendered inside.
     * The whole track is the accent colour: the filled (left) portion is solid,
     * the remaining (right) portion is the badge-style translucent fill, so the
     * bar reads like our provider/quality chips. Green replaces the accent when
     * the set is fully downloaded. */
    progressTrack: {
        position: "relative",
        width: "100%",
        minWidth: "56px",
        maxWidth: "120px",
        height: "18px",
        borderRadius: tokens.borderRadiusSmall,
        overflow: "hidden",
        // Remaining (unfilled) portion — translucent accent, badge glass feel.
        backgroundColor: `color-mix(in srgb, ${tokens.colorBrandBackground} 20%, transparent)`,
    },
    progressTrackComplete: {
        backgroundColor: `color-mix(in srgb, ${tokens.colorPaletteGreenBackground3} 20%, transparent)`,
    },
    /* Filled (downloaded) portion — solid accent. */
    progressFill: {
        position: "absolute",
        top: 0,
        left: 0,
        bottom: 0,
        backgroundColor: tokens.colorBrandBackground,
        transition: `width ${tokens.durationSlow} ${tokens.curveEasyEase}`,
    },
    progressFillComplete: {
        backgroundColor: tokens.colorPaletteGreenBackground3,
    },
    progressLabel: {
        position: "relative",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: "100%",
        paddingInline: tokens.spacingHorizontalXXS,
        fontSize: tokens.fontSizeBase100,
        fontWeight: tokens.fontWeightSemibold,
        fontVariantNumeric: "tabular-nums",
        color: tokens.colorNeutralForeground1,
        whiteSpace: "nowrap",
        textShadow: "0 1px 2px rgba(0,0,0,0.35)",
    },
    /* Action button cluster — flex end */
    actions: {
        display: "flex",
        justifyContent: "flex-end",
        alignItems: "center",
        gap: tokens.spacingHorizontalXXS,
    },
    /* Secondary caption under the primary name — used for mobile-stacked meta
     * (Fluent List / TableCellLayout description pattern). */
    mobileMetaLine: {
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        columnGap: tokens.spacingHorizontalXS,
        rowGap: tokens.spacingVerticalXXS,
        minWidth: 0,
        "@media (min-width: 768px)": {
            display: "none",
        },
    },
    mobileMetaText: {
        fontSize: tokens.fontSizeBase200,
        color: tokens.colorNeutralForeground3,
        whiteSpace: "nowrap",
    },
    mobileQuality: {
        display: "flex",
        minWidth: 0,
        maxWidth: "100%",
        "@media (min-width: 768px)": {
            display: "none",
        },
    },
    showOnMobileOnly: {
        "@media (min-width: 768px)": {
            display: "none !important",
        },
    },
    badgeContainer: {
        display: "flex",
        alignItems: "center",
        gap: "4px",
        minHeight: "24px",
        whiteSpace: "nowrap",
    },
    /* Responsive hide below 768px */
    hideOnMobile: {
        display: "none !important",
        "@media (min-width: 768px)": {
            display: "block !important",
        },
    },
    /* Responsive hide below 1024px */
    hideOnTablet: {
        display: "none !important",
        "@media (min-width: 1024px)": {
            display: "block !important",
        },
    },
});
