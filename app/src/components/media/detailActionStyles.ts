import { tokens } from "@fluentui/react-components";
import { glassButtonStyles, glassPrimaryButtonStyles } from "@/components/ui/glassButtonStyles";

export const detailActionButtonRadiusStyles = {
  borderRadius: tokens.borderRadiusXLarge,
};

export const detailActionGlassButtonStyles = {
  ...detailActionButtonRadiusStyles,
  ...glassButtonStyles,
} as const;

export const detailActionPrimaryButtonStyles = {
  ...detailActionButtonRadiusStyles,
  ...glassPrimaryButtonStyles,
} as const;

/** Three action slots plus a reserved More control. Keep in lockstep with the row gap. */
export const detailActionMobileRowGap = tokens.spacingHorizontalXS;
export const detailActionMobileMoreWidth = "72px";
export const detailActionMobileSlotWidth = `calc((100% - 3 * ${tokens.spacingHorizontalXS} - ${detailActionMobileMoreWidth}) / 3)`;

export const detailActionMobileOverflowRowStyles = {
  overflow: "hidden",
  minWidth: 0,
  gap: detailActionMobileRowGap,
  // Hidden overflow is required for Fluent Overflow to measure. Pad so the
  // glass hover shadow is not sliced off the top/bottom of the row.
  paddingTop: tokens.spacingVerticalXXS,
  paddingBottom: tokens.spacingVerticalS,
  // More must stay narrower than an action slot, or four actions "fit" before
  // More is mounted and the row overflows by one control.
  "& > *[aria-label='More actions']": {
    flex: "0 0 auto",
    flexShrink: 0,
    minWidth: detailActionMobileMoreWidth,
    maxWidth: detailActionMobileMoreWidth,
    boxSizing: "border-box",
  },
} as const;

export const detailActionMobileOverflowItemStyles = {
  flex: "1 0 auto",
  flexShrink: 0,
  minWidth: detailActionMobileSlotWidth,
  maxWidth: detailActionMobileSlotWidth,
  boxSizing: "border-box",
} as const;

const mobileActionLabelStyles = {
  fontSize: tokens.fontSizeBase100,
  marginLeft: "0 !important",
  textAlign: "center",
  whiteSpace: "normal",
  overflowWrap: "anywhere",
  lineHeight: tokens.lineHeightBase100,
} as const;

export const standardDetailActionButtonStyles = {
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "flex-start",
  flex: "1 1 0",
  minWidth: 0,
  padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalS}`,
  gap: tokens.spacingVerticalXXS,
  "& .fui-Button__content": {
    ...mobileActionLabelStyles,
  },
  "& .fui-Button__icon": {
    marginRight: "0",
  },
  "@media (min-width: 480px)": {
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
  },
  "@media (min-width: 768px)": {
    flexDirection: "row",
    flex: "0 0 auto",
    minWidth: "auto",
    gap: tokens.spacingHorizontalNone,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    "& .fui-Button__content": {
      fontSize: tokens.fontSizeBase300,
      marginTop: "0",
      marginLeft: tokens.spacingHorizontalS,
      whiteSpace: "nowrap",
      overflowWrap: "normal",
      lineHeight: tokens.lineHeightBase300,
      textAlign: "left",
    },
    "& .fui-Button__icon": {
      marginRight: tokens.spacingHorizontalSNudge,
    },
  },
} as const;

export const compactDetailActionButtonStyles = {
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "flex-start",
  flex: "1 1 0",
  minWidth: 0,
  padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalXS}`,
  gap: tokens.spacingVerticalXXS,
  "& .fui-Button__content": {
    ...mobileActionLabelStyles,
  },
  "& .fui-Button__icon": {
    marginRight: "0",
    fontSize: tokens.fontSizeBase400,
  },
  "@media (min-width: 480px)": {
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalS}`,
    "& .fui-Button__content": {
      fontSize: tokens.fontSizeBase100,
    },
    "& .fui-Button__icon": {
      fontSize: tokens.fontSizeBase500,
    },
  },
  "@media (min-width: 768px)": {
    flexDirection: "row",
    flex: "0 0 auto",
    minWidth: "auto",
    gap: tokens.spacingHorizontalNone,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    "& .fui-Button__content": {
      fontSize: tokens.fontSizeBase300,
      marginTop: "0",
      marginLeft: tokens.spacingHorizontalS,
      whiteSpace: "nowrap",
      overflowWrap: "normal",
      lineHeight: tokens.lineHeightBase300,
      textAlign: "left",
    },
    "& .fui-Button__icon": {
      marginRight: tokens.spacingHorizontalSNudge,
      fontSize: tokens.fontSizeBase600,
    },
  },
} as const;
