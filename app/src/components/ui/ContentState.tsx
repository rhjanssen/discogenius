import React, { ReactNode } from "react";
import { Card, Text, Title3, Body1, makeStyles, mergeClasses, tokens } from "@fluentui/react-components";
import { ErrorCircle48Color } from "@fluentui/react-icons";

interface ContentStateProps {
  children?: ReactNode;
  title?: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  className?: string;
  panelClassName?: string;
  minHeight?: string | number;
  align?: "center" | "left";
  role?: "status" | "alert";
  ariaLive?: "polite" | "assertive";
}

export type EmptyStateProps = ContentStateProps;

export interface ErrorStateProps extends ContentStateProps {
  error?: Error | string | null;
}

const useStyles = makeStyles({
  root: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "100%",
    alignSelf: "stretch",
    minHeight: "240px",
    padding: tokens.spacingVerticalL,
    boxSizing: "border-box",
    marginLeft: "auto",
    marginRight: "auto",
  },
  panel: {
    maxWidth: "560px",
    width: "100%",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: tokens.spacingVerticalM,
    padding: tokens.spacingHorizontalXL,
    textAlign: "center",
    backgroundColor: tokens.colorNeutralBackground1,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    boxShadow: tokens.shadow16,
    borderRadius: tokens.borderRadiusLarge,
    boxSizing: "border-box",
  },
  panelLeft: {
    alignItems: "flex-start",
    textAlign: "left",
  },
  iconShell: {
    width: "56px",
    height: "56px",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: tokens.borderRadiusCircular,
    backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground2,
    flexShrink: 0,
  },
  iconShellError: {
    color: tokens.colorPaletteRedForeground1,
    backgroundColor: tokens.colorPaletteRedBackground1,
  },
  title: {
    marginTop: tokens.spacingVerticalXS,
  },
  description: {
    color: tokens.colorNeutralForeground2,
    maxWidth: "46ch",
  },
  descriptionLeft: {
    maxWidth: "100%",
  },
  actions: {
    display: "flex",
    flexWrap: "wrap",
    gap: tokens.spacingHorizontalS,
    justifyContent: "center",
  },
  actionsLeft: {
    justifyContent: "flex-start",
  },
  emptyStateContainer: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    textAlign: "center",
    gap: tokens.spacingVerticalM,
    color: tokens.colorNeutralForeground2,
  },
  emptyStateIcon: {
    marginBottom: tokens.spacingVerticalS,
    color: tokens.colorNeutralForeground4,
    "& svg": {
      width: "48px",
      height: "48px",
    }
  },
  emptyStateTitle: {
    color: tokens.colorNeutralForeground1,
  },
  emptyStateSubtitle: {
    color: tokens.colorNeutralForeground3,
    maxWidth: "640px",
    textAlign: "center",
  },
});

function StateFrame({
  title,
  description,
  icon,
  actions,
  className,
  panelClassName,
  minHeight,
  children,
  align = "center",
  role,
  ariaLive,
}: ContentStateProps) {
  const styles = useStyles();

  return (
    <div
      className={mergeClasses(styles.root, className)}
      style={minHeight !== undefined ? { minHeight } : undefined}
    >
      <Card
        className={mergeClasses(styles.panel, align === "left" ? styles.panelLeft : undefined, panelClassName)}
        role={role}
        aria-live={ariaLive}
      >
        {children}
        {icon ? (
          <div className={mergeClasses(styles.iconShell, role === "alert" ? styles.iconShellError : undefined)}>
            {icon}
          </div>
        ) : null}
        {title ? <Title3 className={styles.title}>{title}</Title3> : null}
        {description ? (
          <Body1 className={mergeClasses(styles.description, align === "left" ? styles.descriptionLeft : undefined)}>
            {description}
          </Body1>
        ) : null}
        {actions ? (
          <div className={mergeClasses(styles.actions, align === "left" ? styles.actionsLeft : undefined)}>
            {actions}
          </div>
        ) : null}
      </Card>
    </div>
  );
}

export const EmptyState = ({
  title,
  description,
  icon,
  actions,
  className,
  minHeight = "200px",
  align = "center",
}: EmptyStateProps) => {
  const styles = useStyles();

  return (
    <div
      className={mergeClasses(styles.root, className)}
      style={minHeight !== undefined ? { minHeight, padding: tokens.spacingVerticalXXXL } : { padding: tokens.spacingVerticalXXXL }}
      role="status"
      aria-live="polite"
    >
      <div className={mergeClasses(styles.emptyStateContainer, align === "left" && styles.panelLeft)}>
        {icon ? (
          <div className={styles.emptyStateIcon}>
            {icon}
          </div>
        ) : null}
        {title ? <Text className={styles.emptyStateTitle} size={500} weight="semibold">{title}</Text> : null}
        {description ? (
          <Text className={styles.emptyStateSubtitle} size={300}>
            {description}
          </Text>
        ) : null}
        {actions ? (
          <div className={mergeClasses(styles.actions, align === "left" ? styles.actionsLeft : undefined)}>
            {actions}
          </div>
        ) : null}
      </div>
    </div>
  );
};

export const ErrorState = ({
  title = "Something went wrong",
  description,
  error,
  actions,
  className,
  panelClassName,
  minHeight,
  align = "center",
}: ErrorStateProps) => {
  const resolvedDescription = description ?? (error instanceof Error ? error.message : error ?? "An unexpected error occurred.");

  return (
    <StateFrame
      className={className}
      panelClassName={panelClassName}
      minHeight={minHeight}
      align={align}
      role="alert"
      ariaLive="assertive"
      title={title}
      description={resolvedDescription}
      icon={<ErrorCircle48Color />}
      actions={actions}
    />
  );
};
