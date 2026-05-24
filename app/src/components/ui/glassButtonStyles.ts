import { tokens } from "@fluentui/react-components";

export const glassButtonStyles = {
  backgroundColor: tokens.colorNeutralBackgroundAlpha2,
  backdropFilter: "blur(14px) saturate(140%)",
  WebkitBackdropFilter: "blur(14px) saturate(140%)",
  border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStrokeAlpha2}`,
  boxShadow: tokens.shadow2,
  transitionProperty: "background-color, border-color, box-shadow, color, transform",
  transitionDuration: tokens.durationFast,
  transitionTimingFunction: tokens.curveEasyEase,
  "&:hover": {
    backgroundColor: tokens.colorNeutralBackgroundAlpha,
    borderColor: tokens.colorNeutralStroke1Hover,
    boxShadow: tokens.shadow8,
    transform: "translateY(-1px)",
  },
  "&:active": {
    backgroundColor: tokens.colorNeutralBackgroundAlpha2,
    borderColor: tokens.colorNeutralStroke1Pressed,
    boxShadow: tokens.shadow2,
    transform: "translateY(0)",
  },
  "&:disabled": {
    transform: "none",
    boxShadow: tokens.shadow2,
  },
} as const;

export const glassPrimaryButtonStyles = {
  ...glassButtonStyles,
  backgroundColor: `color-mix(in srgb, ${tokens.colorBrandBackground} 84%, transparent)`,
  borderColor: `color-mix(in srgb, ${tokens.colorBrandStroke1} 76%, transparent)`,
  color: tokens.colorNeutralForegroundOnBrand,
  "&:hover": {
    backgroundColor: `color-mix(in srgb, ${tokens.colorBrandBackgroundHover} 90%, transparent)`,
    borderColor: tokens.colorBrandStroke1,
    boxShadow: tokens.shadow16,
    color: tokens.colorNeutralForegroundOnBrand,
    transform: "translateY(-1px)",
  },
  "&:active": {
    backgroundColor: `color-mix(in srgb, ${tokens.colorBrandBackgroundPressed} 88%, transparent)`,
    borderColor: tokens.colorBrandStroke2,
    boxShadow: tokens.shadow4,
    color: tokens.colorNeutralForegroundOnBrand,
    transform: "translateY(0)",
  },
} as const;

export const glassDangerButtonStyles = {
  ...glassButtonStyles,
  color: tokens.colorStatusDangerForeground1,
  "&:hover": {
    backgroundColor: `color-mix(in srgb, ${tokens.colorStatusDangerBackground1} 62%, transparent)`,
    borderColor: tokens.colorStatusDangerBorder1,
    boxShadow: tokens.shadow8,
    color: tokens.colorStatusDangerForeground2,
    transform: "translateY(-1px)",
  },
} as const;
