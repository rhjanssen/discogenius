import { shorthands, tokens } from "@fluentui/react-components";

/**
 * Shared glass panel surface for Settings/Status/Dashboard cards.
 * WinUI content layer (LayerFillColorDefaultBrush) over Mica → Fluent
 * `colorNeutralBackgroundAlpha`. Theme owns light vs dark opacity.
 */
export const glassSurfaceStyles = {
  backgroundColor: tokens.colorNeutralBackgroundAlpha,
  backdropFilter: "blur(20px) saturate(120%)",
  WebkitBackdropFilter: "blur(20px) saturate(120%)",
  ...shorthands.border(tokens.strokeWidthThin, "solid", tokens.colorNeutralStroke1),
  ...shorthands.borderRadius(tokens.borderRadiusLarge),
  boxShadow: tokens.shadow4,
} as const;
