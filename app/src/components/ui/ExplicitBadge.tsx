import React from "react";
import { Badge, makeStyles, mergeClasses, tokens } from "@fluentui/react-components";
import { tidalBadgeColor, tidalBadgeColorLight } from "@/theme/theme";
import { useTheme } from "@/providers/themeContext";
import { type DiscogeniusBadgeSize } from "./badgeSizes";
import { badgeGlassFill } from "./badgeChrome";

/** Square "E" is a hair smaller than the row's quality/provider chips. */
const EXPLICIT_BADGE_SIZE_PX: Record<DiscogeniusBadgeSize, number> = {
  small: 16,
  medium: 18,
  large: 22,
};

interface ExplicitBadgeProps {
  className?: string;
  /** Match the quality/provider row size when sitting next to those chips. */
  size?: DiscogeniusBadgeSize;
  /** Track titles use a neutral, high-contrast mark; offer chips keep the tinted mark. */
  appearance?: "tint" | "contrast";
}

/**
 * Explicit edition mark — Apple/Spotify-style "E".
 * Uses the same circular radius and glass fill as quality/provider chips so
 * dark and light themes stay consistent with the rest of the badge row.
 */
const useStyles = makeStyles({
  base: {
    fontWeight: tokens.fontWeightBold,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    boxSizing: "border-box",
    flexShrink: 0,
    lineHeight: 1,
    padding: 0,
    verticalAlign: "middle",
    borderRadius: tokens.borderRadiusCircular,
    "::after": {
      display: "none",
    },
  },
  label: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    lineHeight: 1,
    opacity: 1,
  },
  small: {
    height: `${EXPLICIT_BADGE_SIZE_PX.small}px`,
    width: `${EXPLICIT_BADGE_SIZE_PX.small}px`,
    minWidth: `${EXPLICIT_BADGE_SIZE_PX.small}px`,
    fontSize: tokens.fontSizeBase100,
  },
  medium: {
    height: `${EXPLICIT_BADGE_SIZE_PX.medium}px`,
    width: `${EXPLICIT_BADGE_SIZE_PX.medium}px`,
    minWidth: `${EXPLICIT_BADGE_SIZE_PX.medium}px`,
    fontSize: tokens.fontSizeBase100,
  },
  large: {
    height: `${EXPLICIT_BADGE_SIZE_PX.large}px`,
    width: `${EXPLICIT_BADGE_SIZE_PX.large}px`,
    minWidth: `${EXPLICIT_BADGE_SIZE_PX.large}px`,
    fontSize: tokens.fontSizeBase200,
  },
});

export const ExplicitBadge: React.FC<ExplicitBadgeProps> = ({ className, size = "medium", appearance = "tint" }) => {
  const styles = useStyles();
  const { isDarkMode } = useTheme();
  const palette = isDarkMode ? tidalBadgeColor : tidalBadgeColorLight;
  const sizeClass = size === "small" ? styles.small : size === "large" ? styles.large : styles.medium;

  return (
    <Badge
      appearance="tint"
      size="medium"
      className={mergeClasses(styles.base, sizeClass, className)}
      style={{
        backgroundColor: appearance === "contrast"
          ? tokens.colorNeutralForeground1
          : badgeGlassFill(palette.SpatialBackground, isDarkMode),
        color: appearance === "contrast"
          ? tokens.colorNeutralBackground1
          : palette.SpatialText,
      }}
      aria-label="Explicit"
    >
      <span className={styles.label}>E</span>
    </Badge>
  );
};
