import { tokens } from "@fluentui/react-components";

/** Layout writes the measured app-bar height here for sticky page chrome. */
export const appBarHeightCssVariable = "--dg-app-bar-height";

/** Layout owns page-top spacing. Keep this one step so headers are not a second empty band. */
export const pageInsetTop = tokens.spacingVerticalS;
export const pageInsetTopDesktop = tokens.spacingVerticalS;

/** Pull top-level media pages flush with the app bar's content inset. */
export const compactPageTopOffset = {
    marginTop: `calc(-1 * ${tokens.spacingVerticalS})`,
} as const;

/** Shared collection spacing so tables, selection bars, cards, and queue rows align. */
export const collectionContentInset = {
    padding: tokens.spacingHorizontalS,
    "@media (min-width: 768px)": {
        padding: tokens.spacingHorizontalM,
    },
} as const;

export const collectionActionSurfacePadding = `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`;
export const collectionRowPadding = tokens.spacingHorizontalM;
