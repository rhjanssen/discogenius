import { tokens } from "@fluentui/react-components";

/** Shared collection spacing so tables, selection bars, cards, and queue rows align. */
export const collectionContentInset = {
    padding: tokens.spacingHorizontalS,
    "@media (min-width: 768px)": {
        padding: tokens.spacingHorizontalM,
    },
} as const;

export const collectionActionSurfacePadding = `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`;
export const collectionRowPadding = tokens.spacingHorizontalM;

/** Pull top-level media pages one Fluent spacing step closer to the app bar. */
export const compactPageTopOffset = {
    marginTop: `calc(-1 * ${tokens.spacingVerticalS})`,
} as const;

