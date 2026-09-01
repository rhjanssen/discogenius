import { makeStyles, tokens } from "@fluentui/react-components";
import { collectionRowPadding } from "@/components/ui/sharedLayoutStyles";
import { glassSurfaceStyles } from "@/components/ui/glassSurfaceStyles";

export const useDashboardStyles = makeStyles({
    brandHeader: {
        display: "flex",
        alignItems: "center",
        gap: tokens.spacingHorizontalS,
    },
    brandLogo: {
        width: "32px",
        height: "32px",
        objectFit: "contain",
    },
    statHeader: {
        display: "flex",
        alignItems: "center",
        gap: tokens.spacingHorizontalXS,
    },
    statIcon: {
        width: "16px",
        height: "16px",
        flexShrink: 0,
        color: tokens.colorBrandForeground1,
    },
    emptyState: {
        ...glassSurfaceStyles,
        textAlign: "center",
        padding: tokens.spacingVerticalXXL,
        color: tokens.colorNeutralForeground3,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: tokens.spacingVerticalM,
        borderRadius: tokens.borderRadiusMedium,
        border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
        overflow: "hidden",
    },
    emptyStateIcon: {
        width: "64px",
        height: "64px",
        color: tokens.colorNeutralForeground4,
        opacity: 0.6,
    },
    emptyStateTitle: {
        color: tokens.colorNeutralForeground1,
        fontWeight: tokens.fontWeightBold,
        textAlign: "center",
    },
    emptyStateSubtitle: {
        color: tokens.colorNeutralForeground3,
        textAlign: "center",
        maxWidth: "560px",
    },
    tabSection: {
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalS,
    },
    queueColumnsWrapper: {
        display: "flex",
        flexDirection: "column" as const,
        gap: tokens.spacingVerticalS,
        "@media (min-width: 960px)": {
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: tokens.spacingHorizontalL,
            alignItems: "start",
        },
    },
    queueSection: {
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalS,
        minWidth: 0,
    },
    queueSectionHeader: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: tokens.spacingHorizontalM,
        flexWrap: "wrap",
    },
    queueSectionHeading: {
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalXXS,
        minWidth: 0,
    },
    queueSectionTitle: {
        color: tokens.colorNeutralForeground2,
        margin: 0,
    },
    queueSectionActions: {
        display: "flex",
        alignItems: "center",
        justifyContent: "flex-end",
        gap: tokens.spacingHorizontalS,
        flexWrap: "wrap",
        minWidth: 0,
    },
    queueSectionSelectionCount: {
        color: tokens.colorNeutralForeground3,
        whiteSpace: "nowrap",
    },
    queueSectionHint: {
        color: tokens.colorNeutralForeground3,
    },
    syncNotice: {
        display: "flex",
        alignItems: "center",
        gap: tokens.spacingHorizontalS,
        padding: collectionRowPadding,
        borderRadius: tokens.borderRadiusMedium,
        border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
        backgroundColor: `color-mix(in srgb, ${tokens.colorNeutralBackground3} 70%, transparent)`,
        color: tokens.colorNeutralForeground2,
    },
    syncNoticeError: {
        borderTopColor: tokens.colorPaletteRedBorder2,
        borderRightColor: tokens.colorPaletteRedBorder2,
        borderBottomColor: tokens.colorPaletteRedBorder2,
        borderLeftColor: tokens.colorPaletteRedBorder2,
        backgroundColor: `color-mix(in srgb, ${tokens.colorPaletteRedBackground1} 24%, ${tokens.colorNeutralBackground3})`,
    },
    syncNoticeText: {
        color: tokens.colorNeutralForeground2,
    },

    // Queue styles
    queueCard: {
        ...glassSurfaceStyles,
        padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalS,
        borderRadius: tokens.borderRadiusMedium,
        border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    },
    downloadList: {
        ...glassSurfaceStyles,
        display: "flex",
        flexDirection: "column",
        borderRadius: tokens.borderRadiusMedium,
        border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
        // `overflow: hidden` makes this tall, growing list its own scroll
        // container even though it has no scrollbars. When another queue page
        // is appended, Chromium may anchor that inner container and clamp the
        // document back toward the top. `clip` keeps the rounded-edge clipping
        // without creating a competing scroll container.
        overflow: "clip",
        overflowAnchor: "auto",
    },
    downloadGroup: {
        display: "flex",
        flexDirection: "column",
        position: "relative",
    },
    downloadItem: {
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: tokens.spacingHorizontalS,
        padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalS}`,
        borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
        cursor: "default",
        transitionProperty: "background-color",
        transitionDuration: tokens.durationFaster,
        ":hover": {
            backgroundColor: tokens.colorNeutralBackground1Hover,
        },
        ":last-child": {
            borderBottom: "none",
        },
    },
    downloadItemReorderable: {
        userSelect: "none",
    },
    downloadItemSelected: {
        backgroundColor: `color-mix(in srgb, ${tokens.colorBrandBackground2} 32%, ${tokens.colorNeutralBackground1})`,
        ":hover": {
            backgroundColor: `color-mix(in srgb, ${tokens.colorBrandBackground2} 44%, ${tokens.colorNeutralBackground1Hover})`,
        },
    },
    downloadItemBusy: {
        opacity: 0.68,
    },
    downloadItemDragging: {
        opacity: 0.58,
    },
    downloadItemDropBefore: {
        boxShadow: `inset 0 ${tokens.strokeWidthThick} 0 ${tokens.colorBrandStroke1}`,
    },
    downloadItemDropAfter: {
        boxShadow: `inset 0 calc(-1 * ${tokens.strokeWidthThick}) 0 ${tokens.colorBrandStroke1}`,
    },
    downloadSubItem: {
        display: "flex",
        alignItems: "center",
        gap: tokens.spacingHorizontalS,
        padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalS}`,
        borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
        backgroundColor: `color-mix(in srgb, ${tokens.colorNeutralBackground1} 20%, transparent)`,
        cursor: "default",
        transitionProperty: "background-color",
        transitionDuration: tokens.durationFaster,
        ":hover": {
            backgroundColor: tokens.colorNeutralBackground1Hover,
        },
        ":last-child": {
            borderBottom: "none",
        },
    },
    downloadTrackLead: {
        display: "flex",
        alignItems: "center",
        gap: tokens.spacingHorizontalXS,
        flexShrink: 0,
    },
    downloadSelectionCell: {
        display: "flex",
        alignItems: "center",
        gap: tokens.spacingHorizontalXXS,
        flexShrink: 0,
    },
    downloadDragHandle: {
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: "20px",
        minWidth: "20px",
        borderRadius: tokens.borderRadiusSmall,
        color: tokens.colorNeutralForeground3,
        fontSize: tokens.fontSizeBase300,
        lineHeight: tokens.lineHeightBase300,
        letterSpacing: "-0.08em",
        cursor: "grab",
        transitionProperty: "background-color, color, opacity",
        transitionDuration: tokens.durationFaster,
        ":hover": {
            backgroundColor: tokens.colorSubtleBackgroundHover,
            color: tokens.colorNeutralForeground2,
        },
        ":active": {
            cursor: "grabbing",
        },
    },
    downloadDragHandleDragging: {
        opacity: 0.6,
    },
    downloadStatusLead: {
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
    },
    downloadStatusText: {
        fontSize: tokens.fontSizeBase200,
        color: tokens.colorNeutralForeground2,
        whiteSpace: "nowrap",
        textTransform: "lowercase",
    },
    downloadStatusPendingIcon: {
        color: tokens.colorNeutralForeground3,
        flexShrink: 0,
    },
    downloadStatusCompleteIcon: {
        color: tokens.colorBrandForeground1,
        flexShrink: 0,
    },
    downloadCover: {
        width: "40px",
        height: "40px",
        borderRadius: tokens.borderRadiusSmall,
        objectFit: "cover",
        backgroundColor: tokens.colorNeutralBackground3,
        flexShrink: 0,
    },
    downloadCoverVideo: {
        width: "64px",
        height: "36px",
        borderRadius: tokens.borderRadiusSmall,
        objectFit: "cover",
        backgroundColor: tokens.colorNeutralBackground3,
        flexShrink: 0,
    },
    downloadCoverPlaceholder: {
        width: "40px",
        height: "40px",
        borderRadius: tokens.borderRadiusSmall,
        backgroundColor: tokens.colorNeutralBackground3,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        color: tokens.colorNeutralForeground4,
    },
    downloadCoverPlaceholderVideo: {
        width: "64px",
        height: "36px",
        borderRadius: tokens.borderRadiusSmall,
        backgroundColor: tokens.colorNeutralBackground3,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        color: tokens.colorNeutralForeground4,
    },
    downloadInfo: {
        flex: 1,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalXXS,
    },
    downloadHeaderRow: {
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalXXS,
        minWidth: 0,
    },
    downloadHeaderRowInline: {
        "@media (min-width: 700px)": {
            flexDirection: "row",
            alignItems: "center",
            gap: tokens.spacingHorizontalM,
        },
    },
    downloadTitleRow: {
        display: "flex",
        alignItems: "center",
        gap: tokens.spacingHorizontalXS,
        flex: "1 1 auto",
        minWidth: 0,
    },
    // Desktop single-line header: title shrinks to content so the artist sits
    // right after it; badges are pushed to the trailing edge.
    downloadTitleRowInline: {
        "@media (min-width: 700px)": {
            flex: "0 1 auto",
            maxWidth: "60%",
        },
    },
    downloadTitle: {
        fontWeight: tokens.fontWeightSemibold,
        fontSize: tokens.fontSizeBase300,
        flex: 1,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
    },
    downloadSubtleText: {
        color: tokens.colorNeutralForeground2,
    },
    downloadTitleLink: {
        color: "inherit",
        textDecorationLine: "none",
        borderRadius: tokens.borderRadiusSmall,
        "&:hover": {
            color: tokens.colorBrandForegroundLinkHover,
            textDecorationLine: "underline",
        },
        "&:focus-visible": {
            outline: `2px solid ${tokens.colorStrokeFocus2}`,
            outlineOffset: "2px",
        },
    },
    downloadArtist: {
        fontSize: tokens.fontSizeBase200,
        color: tokens.colorNeutralForeground3,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        minWidth: 0,
    },
    downloadArtistMetaRow: {
        display: "flex",
        alignItems: "center",
        gap: tokens.spacingHorizontalXS,
        flex: "0 1 auto",
        flexWrap: "wrap",
        minWidth: 0,
    },
    downloadArtistMetaRowInline: {
        "@media (min-width: 700px)": {
            flexWrap: "nowrap",
            gap: tokens.spacingHorizontalM,
            flex: "1 1 auto",
        },
    },
    downloadBadgeRow: {
        display: "flex",
        alignItems: "center",
        gap: tokens.spacingHorizontalXS,
        flexShrink: 0,
        flexWrap: "wrap",
        minWidth: "max-content",
        width: "max-content",
    },
    downloadBadgeRowInline: {
        "@media (min-width: 700px)": {
            flexWrap: "nowrap",
            marginLeft: "auto",
        },
    },
    downloadProgress: {
        display: "flex",
        alignItems: "center",
        gap: tokens.spacingHorizontalS,
    },
    progressBarWrapper: {
        flex: 1,
        minWidth: "60px",
    },
    progressText: {
        fontSize: tokens.fontSizeBase200,
        color: tokens.colorNeutralForeground2,
        whiteSpace: "nowrap",
        minWidth: "40px",
        textAlign: "right",
    },
    downloadMeta: {
        fontSize: tokens.fontSizeBase100,
        color: tokens.colorNeutralForeground3,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        maxWidth: "100%",
        lineHeight: tokens.lineHeightBase100,
        minHeight: tokens.lineHeightBase100,
    },
    downloadErrorText: {
        fontSize: tokens.fontSizeBase100,
        color: tokens.colorPaletteRedForeground1,
        overflow: "hidden",
        textOverflow: "ellipsis",
        display: "-webkit-box",
        WebkitLineClamp: 2,
        WebkitBoxOrient: "vertical",
        whiteSpace: "normal",
        maxWidth: "100%",
        lineHeight: tokens.lineHeightBase100,
        flexBasis: "100%",
        order: 10,
        marginTop: tokens.spacingVerticalXXS,
    },
    downloadActions: {
        display: "flex",
        gap: tokens.spacingHorizontalXS,
        flexWrap: "wrap",
        justifyContent: "flex-end",
        alignItems: "center",
        flexShrink: 0,
        // Keep reorder/remove buttons out from under the sticky app bar.
        scrollMarginTop: "72px",
    },
    queueHistoryItem: {
        outlineStyle: "none",
        alignItems: "center",
        flexWrap: "wrap",
    },
    queueHistoryItemStatic: {
        cursor: "default",
        ":hover": {
            backgroundColor: tokens.colorNeutralBackground1,
        },
    },
    queueHistoryTrailing: {
        display: "flex",
        alignItems: "center",
        gap: tokens.spacingHorizontalS,
        flexShrink: 0,
        marginLeft: "auto",
    },
    queueHistoryStatus: {
        display: "flex",
        alignItems: "center",
        gap: tokens.spacingHorizontalXS,
        flexShrink: 0,
        justifyContent: "flex-end",
    },
    queueHistoryTime: {
        fontSize: tokens.fontSizeBase200,
        color: tokens.colorNeutralForeground3,
        whiteSpace: "nowrap",
    },
    queueHistoryErrorText: {
        fontSize: tokens.fontSizeBase100,
        color: tokens.colorPaletteRedForeground1,
        overflow: "hidden",
        textOverflow: "ellipsis",
        display: "-webkit-box",
        WebkitLineClamp: 2,
        WebkitBoxOrient: "vertical",
        whiteSpace: "normal",
        maxWidth: "100%",
        lineHeight: tokens.lineHeightBase100,
        flexBasis: "100%",
        order: 10,
        marginTop: tokens.spacingVerticalXXS,
        overflowWrap: "anywhere",
    },
    downloadReorderActions: {
        display: "flex",
        alignItems: "center",
        gap: tokens.spacingHorizontalXXS,
        flexShrink: 0,
    },
    reorderDesktopOnly: {
        display: "none",
        "@media (min-width: 640px)": {
            display: "inline-flex",
        },
    },
    reorderMobileOnly: {
        display: "inline-flex",
        "@media (min-width: 640px)": {
            display: "none",
        },
    },
    downloadStateIndicator: {
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: tokens.spacingHorizontalXS,
        flexShrink: 0,
    },
    downloadTrackNumber: {
        minWidth: "20px",
        textAlign: "right",
        fontSize: tokens.fontSizeBase200,
        color: tokens.colorNeutralForeground2,
        flexShrink: 0,
    },

    // Activity styles
    activityList: {
        ...glassSurfaceStyles,
        display: "flex",
        flexDirection: "column",
        borderRadius: tokens.borderRadiusMedium,
        border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
        overflow: "hidden",
    },
    activitySection: {
        display: "flex",
        flexDirection: "column",
        ":not(:first-child)": {
            borderTop: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
        },
    },
    activitySectionHeader: {
        display: "flex",
        alignItems: "center",
        gap: tokens.spacingHorizontalS,
        padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalM} ${tokens.spacingVerticalXS}`,
    },
    activitySectionItems: {
        display: "flex",
        flexDirection: "column",
    },
    activitySectionLabel: {
        color: tokens.colorNeutralForeground2,
        fontSize: tokens.fontSizeBase200,
    },
    activitySectionCount: {
        color: tokens.colorNeutralForeground3,
    },
    activityItem: {
        display: "flex",
        alignItems: "center",
        gap: tokens.spacingHorizontalS,
        padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
        borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
        cursor: "default",
        transitionProperty: "background-color",
        transitionDuration: tokens.durationFaster,
        ":hover": {
            backgroundColor: tokens.colorSubtleBackgroundHover,
        },
        ":last-child": {
            borderBottom: "none",
        },
    },
    activityLeading: {
        // Two 24 px Fluent icons plus the 4 px XS gap. The previous 28 px
        // column centered 52 px of content and the list's overflow clipped it.
        width: "52px",
        textAlign: "center",
        flexShrink: 0,
        paddingTop: 0,
    },
    activityLeadingContent: {
        display: "flex",
        alignItems: "center",
        justifyContent: "flex-start",
        gap: tokens.spacingHorizontalXS,
    },
    activityLeadingContentCompact: {
        display: "flex",
        alignItems: "center",
        justifyContent: "flex-start",
        gap: tokens.spacingHorizontalXS,
    },
    activityIconOffset: {
        display: "inline-flex",
    },
    activityContent: {
        flex: 1,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalXXS,
    },
    activitySummaryRow: {
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "space-between",
        gap: tokens.spacingHorizontalM,
        minWidth: 0,
        "@media (max-width: 699px)": {
            gap: tokens.spacingHorizontalS,
        },
    },
    activityTitleStack: {
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalXXS,
        flex: 1,
        minWidth: 0,
        "@media (min-width: 700px)": {
            flexDirection: "row",
            alignItems: "baseline",
            flexWrap: "wrap",
            columnGap: tokens.spacingHorizontalXS,
            rowGap: tokens.spacingVerticalXXS,
        },
    },
    activityTitleText: {
        minWidth: 0,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "normal",
        overflowWrap: "anywhere",
        "@media (min-width: 700px)": {
            flexShrink: 0,
            maxWidth: "100%",
        },
    },
    activityInlineDescription: {
        color: tokens.colorNeutralForeground2,
        whiteSpace: "normal",
        overflowWrap: "anywhere",
        minWidth: 0,
        "@media (min-width: 700px)": {
            flex: "1 1 16rem",
        },
    },
    activitySecondaryText: {
        color: tokens.colorNeutralForeground2,
        marginTop: tokens.spacingVerticalSNudge,
    },
    activityLoadingRow: {
        display: "flex",
        alignItems: "center",
        gap: tokens.spacingHorizontalS,
        padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalM}`,
    },
    activityErrorText: {
        color: tokens.colorPaletteRedForeground1,
        whiteSpace: "normal",
        overflowWrap: "anywhere",
        "@media (min-width: 700px)": {
            flexBasis: "100%",
        },
    },
    activityTimeActions: {
        display: "flex",
        alignItems: "center",
        justifyContent: "flex-end",
        gap: tokens.spacingHorizontalXS,
        flexShrink: 0,
        marginLeft: "auto",
        "@media (max-width: 699px)": {
            alignSelf: "flex-start",
            minWidth: "52px",
        },
    },
    activityTime: {
        fontSize: tokens.fontSizeBase100,
        color: tokens.colorNeutralForeground3,
        whiteSpace: "nowrap",
    },
    loadMoreRow: {
        display: "flex",
        justifyContent: "center",
        padding: tokens.spacingVerticalM,
    },
});
