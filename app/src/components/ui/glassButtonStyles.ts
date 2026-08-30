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
  },
  "&:active": {
    backgroundColor: tokens.colorNeutralBackgroundAlpha2,
    backdropFilter: "blur(14px) saturate(140%)",
    WebkitBackdropFilter: "blur(14px) saturate(140%)",
    ...shorthands.borderColor(tokens.colorNeutralStroke1Pressed),
    boxShadow: tokens.shadow2,
  },
  "&:disabled": { boxShadow: "none" },
  "&[aria-disabled='true'], &[aria-disabled='true']:hover, &[aria-disabled='true']:active": {
    backgroundColor: "transparent",
    backdropFilter: "none",
    WebkitBackdropFilter: "none",
    ...shorthands.borderColor("transparent"),
    boxShadow: "none",
  },
} as const;

export const glassPrimaryButtonStyles = {
  // Fluent's primary appearance owns fill, foreground, border, and interaction
  // colors. Discogenius only adds a small depth transition.
  boxShadow: tokens.shadow2,
  transitionProperty: "box-shadow",
  transitionDuration: tokens.durationFast,
  transitionTimingFunction: tokens.curveEasyEase,
  "&:hover": { boxShadow: tokens.shadow8 },
  "&:active": { boxShadow: tokens.shadow2 },
  "&:disabled": { boxShadow: "none" },
  "&[aria-disabled='true'], &[aria-disabled='true']:hover, &[aria-disabled='true']:active": {
    boxShadow: "none",
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
