/**
 * Shared card styles used across Library, ArtistPage, and AlbumPage.
 * Single source of truth for card visual design.
 */
import { makeStyles, tokens } from "@fluentui/react-components";

export const useCardStyles = makeStyles({
    // Card container
    card: {
        display: "flex",
        flexDirection: "column",
        height: "100%",
        backgroundColor: tokens.colorNeutralBackgroundAlpha2,
        backdropFilter: "blur(10px)",
        border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStrokeAlpha2}`,
        borderRadius: tokens.borderRadiusMedium,
        overflow: "hidden",
        cursor: "pointer",
        boxShadow: tokens.shadow8,
        transition: `all ${tokens.durationFast} ${tokens.curveEasyEase}`,
        padding: tokens.spacingVerticalNone,
        minWidth: 0,
        width: "100%",
        maxWidth: "100%",
        "&:hover": {
            transform: "translateY(-2px)",
            boxShadow: tokens.shadow28,
            backgroundColor: tokens.colorNeutralBackgroundAlpha,
            border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke1Hover}`,
        },
        "&:active": {
            transform: "translateY(0px)",
            boxShadow: tokens.shadow8,
        },
    },

    // Mini card variant (e.g. similar albums) — less visual weight
    cardMini: {
        display: "flex",
        flexDirection: "column",
        height: "100%",
        backgroundColor: tokens.colorNeutralBackgroundAlpha2,
        backdropFilter: "blur(10px)",
        border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStrokeAlpha2}`,
        borderRadius: tokens.borderRadiusMedium,
        overflow: "hidden",
        cursor: "pointer",
        transition: `all ${tokens.durationFast} ${tokens.curveEasyEase}`,
        padding: tokens.spacingVerticalNone,
        minWidth: 0,
        width: "100%",
        maxWidth: "100%",
        "&:hover": {
            transform: "translateY(-2px)",
            backgroundColor: tokens.colorNeutralBackgroundAlpha,
            border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke1Hover}`,
        },
    },

    // Image preview area (1:1 aspect ratio)
    cardPreview: {
        position: "relative",
        aspectRatio: "1/1",
        width: "100%",
        backgroundColor: tokens.colorNeutralBackground3,
        margin: tokens.spacingVerticalNone,
        padding: tokens.spacingVerticalNone,
        overflow: "hidden",
    },

    // Video preview area (3:2 aspect ratio)
    videoPreview: {
        position: "relative",
        aspectRatio: "3/2",
        width: "100%",
        backgroundColor: tokens.colorNeutralBackground3,
        margin: tokens.spacingVerticalNone,
        padding: tokens.spacingVerticalNone,
        overflow: "hidden",
    },

    // Image within card preview
    cardImage: {
        width: "100%",
        height: "100%",
        objectFit: "cover",
        display: "block",
        borderRadius: tokens.borderRadiusNone,
    },

    // Text content below the preview
    cardContent: {
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalXXS,
        padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    },

    // Title row (title + badges)
    cardTitleRow: {
        display: "flex",
        alignItems: "center",
        gap: tokens.spacingHorizontalXS,
    },

    // Truncated title text
    cardTitle: {
        flex: 1,
        minWidth: 0,
        fontSize: tokens.fontSizeBase300,
        fontWeight: tokens.fontWeightSemibold,
        color: tokens.colorNeutralForeground1,
        lineHeight: tokens.lineHeightBase300,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
    },

    // Center-aligned title (for artist cards in related sections)
    cardTitleCenter: {
        flex: 1,
        minWidth: 0,
        fontSize: tokens.fontSizeBase300,
        fontWeight: tokens.fontWeightSemibold,
        color: tokens.colorNeutralForeground1,
        lineHeight: tokens.lineHeightBase300,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        textAlign: "center",
    },

    // Subtitle text
    cardSubtitle: {
        fontSize: tokens.fontSizeBase200,
        color: tokens.colorNeutralForeground3,
        lineHeight: tokens.lineHeightBase200,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
    },

    // Explicit badge positioning in title row
    explicitBadge: {
        marginLeft: "auto",
        flexShrink: 0,
    },

    // Quality badge overlay (top-left of preview)
    qualityBadge: {
        position: "absolute",
        top: tokens.spacingVerticalS,
        left: tokens.spacingHorizontalS,
        zIndex: 2,
    },

    // Monitor indicator overlay (bottom-right of preview)
    monitorIndicator: {
        position: "absolute",
        bottom: tokens.spacingVerticalS,
        right: tokens.spacingHorizontalS,
        zIndex: 2,
        width: "24px",
        height: "24px",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: tokens.borderRadiusCircular,
        backdropFilter: "blur(20px)",
        backgroundColor: tokens.colorNeutralBackgroundAlpha,
    },

    // Status badge overlay (top-right of preview)
    statusBadge: {
        position: "absolute",
        top: tokens.spacingVerticalS,
        right: tokens.spacingHorizontalS,
        zIndex: 2,
    },

    // Monitor icon styles
    monitorIcon: {
        width: "16px",
        height: "16px",
        color: tokens.colorNeutralForeground2,
    },
    monitorIconMuted: {
        width: "16px",
        height: "16px",
        color: tokens.colorNeutralForegroundDisabled,
    },

    // Placeholder background and initial
    placeholderBg: {
        width: "100%",
        height: "100%",
        backgroundColor: tokens.colorNeutralBackground3,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
    },
    placeholderInitial: {
        fontSize: "48px",
        fontWeight: tokens.fontWeightBold,
        color: tokens.colorNeutralForeground4,
        userSelect: "none",
    },
});

/** Shared responsive grid layout for card lists */
export const useGridStyles = makeStyles({
    grid: {
        display: "grid",
        gap: tokens.spacingHorizontalM,
        // Mobile: 3 columns
        gridTemplateColumns: "repeat(3, 1fr)",
        // Tablet: 4 columns
        "@media (min-width: 640px)": {
            gridTemplateColumns: "repeat(4, 1fr)",
        },
        // Small desktop: 5 columns
        "@media (min-width: 900px)": {
            gridTemplateColumns: "repeat(5, 1fr)",
        },
        // Desktop: 6 columns
        "@media (min-width: 1200px)": {
            gridTemplateColumns: "repeat(6, 1fr)",
        },
        // Wide: 7 columns
        "@media (min-width: 1536px)": {
            gridTemplateColumns: "repeat(7, 1fr)",
        },
    },
    // Horizontal carousel for related content sections
    carousel: {
        display: "flex",
        gap: tokens.spacingHorizontalM,
        overflowX: "auto",
        scrollBehavior: "smooth",
        paddingBottom: tokens.spacingVerticalS,
        // Scroll snap
        scrollSnapType: "x mandatory",
        "& > *": {
            scrollSnapAlign: "start",
            // Card widths in carousel
            minWidth: "160px",
            maxWidth: "200px",
            flexShrink: 0,
        },
        // Hide scrollbar
        scrollbarWidth: "none",
        "&::-webkit-scrollbar": {
            display: "none",
        },
    },
});
