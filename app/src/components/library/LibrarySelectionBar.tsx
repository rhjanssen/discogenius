import type { ReactElement } from "react";
import { Button, Badge, Overflow, OverflowItem, makeStyles, mergeClasses, tokens } from "@fluentui/react-components";
import { ActionOverflowMenu } from "@/components/overflow/ActionOverflowMenu";
import { AppTooltip } from "@/components/ui/AppTooltip";
import { glassButtonStyles, glassPrimaryButtonStyles } from "@/components/ui/glassButtonStyles";
import { collectionActionSurfacePadding } from "@/components/ui/sharedLayoutStyles";

export interface LibrarySelectionAction {
  key: string;
  label: string;
  icon: ReactElement;
  onClick: () => void;
  disabled?: boolean;
  appearance?: "subtle" | "outline" | "primary";
}

interface LibrarySelectionBarProps {
  selectedCount: number;
  allVisibleSelected: boolean;
  someVisibleSelected: boolean;
  onSelectAllVisible: () => void;
  onClearSelection: () => void;
  actions: LibrarySelectionAction[];
  className?: string;
}

const useStyles = makeStyles({
  root: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: tokens.spacingHorizontalS,
    flexWrap: "nowrap",
    padding: collectionActionSurfacePadding,
    backgroundColor: `color-mix(in srgb, ${tokens.colorNeutralBackground1} 72%, transparent)`,
    borderRadius: tokens.borderRadiusLarge,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    backdropFilter: "blur(18px)",
    WebkitBackdropFilter: "blur(18px)",
    "@media (min-width: 600px)": {
      gap: tokens.spacingHorizontalM,
    },
  },
  meta: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
    minWidth: 0,
    flexShrink: 0,
    "@media (min-width: 600px)": {
      gap: tokens.spacingHorizontalS,
    },
  },
  metaButton: {
    whiteSpace: "nowrap",
  },
  summary: {
    color: tokens.colorNeutralForeground3,
  },
  controls: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
    flexWrap: "wrap",
    justifyContent: "flex-end",
  },
  actionRow: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXXS,
    minWidth: 0,
    flex: "1 1 0px",
    overflow: "hidden",
    justifyContent: "flex-end",
    "@media (min-width: 600px)": {
      gap: tokens.spacingHorizontalXS,
    },
  },
  actionLabel: {
    display: "none",
    "@media (min-width: 600px)": {
      display: "inline",
    },
  },
  glassButton: {
    ...glassButtonStyles,
  },
  primaryButton: {
    ...glassPrimaryButtonStyles,
  },
});

export function LibrarySelectionBar({
  selectedCount,
  allVisibleSelected,
  someVisibleSelected,
  onSelectAllVisible,
  onClearSelection,
  actions,
  className,
}: LibrarySelectionBarProps) {
  const styles = useStyles();

  return (
    <div className={mergeClasses(styles.root, className)}>
      <div className={styles.meta}>
        <Badge appearance="filled" color={selectedCount > 0 ? "brand" : "subtle"} size="medium">
          {selectedCount}
        </Badge>
        <Button
          className={mergeClasses(styles.metaButton, styles.glassButton)}
          appearance="subtle"
          size="small"
          onClick={onSelectAllVisible}
          disabled={allVisibleSelected && !someVisibleSelected}
        >
          Select all
        </Button>
        <Button
          className={styles.glassButton}
          appearance="subtle"
          size="small"
          onClick={onClearSelection}
          disabled={selectedCount === 0}
        >
          Clear
        </Button>
      </div>

      <Overflow padding={40}>
      <div className={styles.actionRow}>
        {actions.map((action) => (
          <OverflowItem key={action.key} id={action.key}>
          <AppTooltip key={action.key} content={action.label} relationship="label">
            <Button
              appearance={action.appearance ?? "subtle"}
              size="small"
              icon={action.icon}
              disabled={action.disabled}
              onClick={action.onClick}
              className={action.appearance === "primary" ? styles.primaryButton : styles.glassButton}
            >
              <span className={styles.actionLabel}>{action.label}</span>
            </Button>
          </AppTooltip>
          </OverflowItem>
        ))}
        <ActionOverflowMenu actions={actions} iconOnly />
      </div>
      </Overflow>
    </div>
  );
}
