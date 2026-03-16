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
    /* Thumbnail images — wide (videos, 3:2) */
    thumbnailWide: {
        width: "56px",
        height: "36px",
        borderRadius: tokens.borderRadiusSmall,
        objectFit: "cover",
        backgroundColor: tokens.colorNeutralBackground3,
        "@media (min-width: 768px)": {
            width: "64px",
            height: "40px",
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
    /* Action button cluster — flex end */
    actions: {
        display: "flex",
        justifyContent: "flex-end",
        alignItems: "center",
        gap: tokens.spacingHorizontalXXS,
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
