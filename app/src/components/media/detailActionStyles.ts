import { tokens } from "@fluentui/react-components";

export const detailActionButtonRadiusStyles = {
  borderRadius: tokens.borderRadiusXLarge,
};

export const standardDetailActionButtonStyles = {
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "flex-start",
  flex: "1 1 0",
  minWidth: 0,
  padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalS}`,
  gap: tokens.spacingVerticalXXS,
  "& .fui-Button__content": {
    fontSize: tokens.fontSizeBase100,
    marginLeft: "0 !important",
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
    fontSize: tokens.fontSizeBase100,
    marginLeft: "0 !important",
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
    },
    "& .fui-Button__icon": {
      marginRight: tokens.spacingHorizontalSNudge,
      fontSize: tokens.fontSizeBase600,
    },
  },
} as const;
