import { tokens } from "@fluentui/react-components";

/** Layout writes the measured app-bar height here for sticky page chrome. */
export const appBarHeightCssVariable = "--dg-app-bar-height";

/** Layout owns page-top spacing. Desktop uses Fluent's large spacing token so
 * page content is visually separated from the elevated app bar. */
export const pageInsetTop = tokens.spacingVerticalS;
export const pageInsetTopDesktop = tokens.spacingVerticalL;

/** Top-level pages inherit the app-wide inset instead of cancelling it. */
export const compactPageTopOffset = {
    marginTop: tokens.spacingVerticalNone,
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
