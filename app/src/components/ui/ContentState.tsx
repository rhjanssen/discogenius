import React, { ReactNode } from "react";
import { Card, Spinner, Text, Title3, Body1, makeStyles, mergeClasses, tokens } from "@fluentui/react-components";
import { ErrorCircle24Filled } from "@fluentui/react-icons";

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

export interface LoadingStateProps {
  label?: string;
  size?: "extra-tiny" | "tiny" | "extra-small" | "small" | "medium" | "large" | "huge";
  className?: string;
  panelClassName?: string;
  minHeight?: string | number;
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
    minHeight: "240px",
    padding: tokens.spacingVerticalL,
  },
  panel: {
    width: "100%",
    maxWidth: "560px",
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
  loadingRow: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: tokens.spacingVerticalM,
  },
  loadingLabel: {
    color: tokens.colorNeutralForeground2,
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

export const LoadingState = ({
  label = "Loading...",
  size = "large",
  className,
  panelClassName,
  minHeight = "180px",
}: LoadingStateProps) => {
  const styles = useStyles();

  return (
    <StateFrame className={className} panelClassName={panelClassName} minHeight={minHeight} role="status" ariaLive="polite">
      <div className={styles.loadingRow}>
        <Spinner size={size} />
        <Text className={styles.loadingLabel} size={300}>
          {label}
        </Text>
      </div>
    </StateFrame>
  );
};

export const EmptyState = ({
  title,
  description,
  icon,
  actions,
  className,
  panelClassName,
  minHeight,
  align = "center",
}: EmptyStateProps) => {
  return (
    <StateFrame
      className={className}
      panelClassName={panelClassName}
      minHeight={minHeight}
      align={align}
      role="status"
      ariaLive="polite"
      title={title}
      description={description}
      icon={icon}
      actions={actions}
    />
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
      icon={<ErrorCircle24Filled />}
      actions={actions}
    />
  );
};
