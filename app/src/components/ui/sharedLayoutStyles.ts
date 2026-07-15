import { tokens } from "@fluentui/react-components";

/** Shared collection spacing so tables, selection bars, cards, and queue rows align. */
export const collectionContentInset = {
    padding: tokens.spacingHorizontalXXS,
    "@media (min-width: 768px)": {
        padding: tokens.spacingHorizontalS,
    },
} as const;

export const collectionActionSurfacePadding = `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`;
export const collectionRowPadding = tokens.spacingHorizontalM;

