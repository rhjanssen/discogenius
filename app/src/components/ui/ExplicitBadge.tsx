import React from "react";
import { Badge, makeStyles, mergeClasses, tokens } from "@fluentui/react-components";

interface ExplicitBadgeProps {
  className?: string;
}

const useStyles = makeStyles({
  base: {
    fontWeight: tokens.fontWeightBold,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2,
    backgroundColor: `color-mix(in srgb, ${tokens.colorNeutralForeground2} 32%, transparent)`,
    height: "16px",
    width: "16px",
    minWidth: "16px",
    padding: tokens.spacingHorizontalNone,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: tokens.borderRadiusSmall,
    lineHeight: 1,
    boxSizing: "border-box",
    "::after": {
      display: "none",
    },
  },
});

export const ExplicitBadge: React.FC<ExplicitBadgeProps> = ({ className }) => {
  const styles = useStyles();

  return (
    <Badge
      appearance="tint"
      className={mergeClasses(styles.base, className)}
      aria-label="Explicit"
      title="Explicit"
    >
      E
    </Badge>
  );
};
