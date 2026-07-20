import { shorthands, tokens } from "@fluentui/react-components";

export const glassButtonStyles = {
  backgroundColor: "transparent",
  backdropFilter: "none",
  WebkitBackdropFilter: "none",
  ...shorthands.border(tokens.strokeWidthThin, "solid", "transparent"),
  boxShadow: "none",
  transitionProperty: "background-color, border-color, box-shadow, backdrop-filter, color",
  transitionDuration: tokens.durationFast,
  transitionTimingFunction: tokens.curveEasyEase,
  "&:hover": {
    backgroundColor: tokens.colorNeutralBackgroundAlpha,
    backdropFilter: "blur(14px) saturate(140%)",
    WebkitBackdropFilter: "blur(14px) saturate(140%)",
    ...shorthands.borderColor(tokens.colorNeutralStroke1Hover),
    boxShadow: tokens.shadow8,
    // Avoid translateY lift — parents with overflow-x:hidden (Layout main)
    // clip the raised button top into a flat hover pill.
  },
  "&:active": {
    backgroundColor: tokens.colorNeutralBackgroundAlpha2,
    backdropFilter: "blur(14px) saturate(140%)",
    WebkitBackdropFilter: "blur(14px) saturate(140%)",
    ...shorthands.borderColor(tokens.colorNeutralStroke1Pressed),
    boxShadow: tokens.shadow2,
  },
  "&:disabled": {
    boxShadow: "none",
  },
} as const;

export const glassPrimaryButtonStyles = {
  ...glassButtonStyles,
  backgroundColor: "transparent",
  ...shorthands.borderColor("transparent"),
  color: tokens.colorBrandForeground1,
  "&:hover": {
    backgroundColor: `color-mix(in srgb, ${tokens.colorBrandBackgroundHover} 28%, transparent)`,
    backdropFilter: "blur(14px) saturate(140%)",
    WebkitBackdropFilter: "blur(14px) saturate(140%)",
    ...shorthands.borderColor(tokens.colorBrandStroke1),
    boxShadow: tokens.shadow16,
    color: tokens.colorBrandForeground1,
  },
  "&:active": {
    backgroundColor: `color-mix(in srgb, ${tokens.colorBrandBackgroundPressed} 36%, transparent)`,
    backdropFilter: "blur(14px) saturate(140%)",
    WebkitBackdropFilter: "blur(14px) saturate(140%)",
    ...shorthands.borderColor(tokens.colorBrandStroke2),
    boxShadow: tokens.shadow4,
    color: tokens.colorBrandForeground1,
  },
} as const;

export const glassDangerButtonStyles = {
  ...glassButtonStyles,
  color: tokens.colorStatusDangerForeground1,
  "&:hover": {
    backgroundColor: `color-mix(in srgb, ${tokens.colorStatusDangerBackground1} 62%, transparent)`,
    ...shorthands.borderColor(tokens.colorStatusDangerBorder1),
    boxShadow: tokens.shadow8,
    color: tokens.colorStatusDangerForeground2,
  },
} as const;
