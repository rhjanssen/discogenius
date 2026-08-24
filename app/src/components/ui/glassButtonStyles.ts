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
    // Avoid translateY lift — Layout <main> clips overflow-x; a raised hover
    // would still look like a flat pill against the clip edge.
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
    backgroundColor: tokens.colorBrandBackground2Hover,
    backdropFilter: "blur(14px) saturate(140%)",
    WebkitBackdropFilter: "blur(14px) saturate(140%)",
    ...shorthands.borderColor(tokens.colorBrandStroke2Hover),
    boxShadow: tokens.shadow8,
    color: tokens.colorBrandForeground1,
  },
  "&:active": {
    backgroundColor: tokens.colorBrandBackground2Pressed,
    backdropFilter: "blur(14px) saturate(140%)",
    WebkitBackdropFilter: "blur(14px) saturate(140%)",
    ...shorthands.borderColor(tokens.colorBrandStroke2Pressed),
    boxShadow: tokens.shadow2,
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
