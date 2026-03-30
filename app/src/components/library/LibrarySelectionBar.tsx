import type { ReactElement } from "react";
import { Button, Badge, makeStyles, mergeClasses, tokens, Tooltip } from "@fluentui/react-components";

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
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    backgroundColor: `color-mix(in srgb, ${tokens.colorNeutralBackground1} 72%, transparent)`,
    borderRadius: tokens.borderRadiusLarge,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    backdropFilter: "blur(18px)",
    WebkitBackdropFilter: "blur(18px)",
    "@media (min-width: 600px)": {
      gap: tokens.spacingHorizontalM,
      padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    },
  },
  meta: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
    minWidth: 0,
    flexShrink: 1,
    "@media (min-width: 600px)": {
      gap: tokens.spacingHorizontalS,
    },
  },
  metaButton: {
    display: "none",
    "@media (min-width: 480px)": {
      display: "inline-flex",
    },
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
    gap: "2px",
    flexShrink: 0,
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
          className={styles.metaButton}
          appearance="subtle"
          size="small"
          onClick={onSelectAllVisible}
          disabled={allVisibleSelected && !someVisibleSelected}
        >
          Select all
        </Button>
        <Button
          appearance="subtle"
          size="small"
          onClick={onClearSelection}
          disabled={selectedCount === 0}
        >
          Clear
        </Button>
      </div>

      <div className={styles.actionRow}>
        {actions.map((action) => (
          <Tooltip key={action.key} content={action.label} relationship="label">
            <Button
              appearance={action.appearance ?? "subtle"}
              size="small"
              icon={action.icon}
              disabled={action.disabled}
              onClick={action.onClick}
            >
              <span className={styles.actionLabel}>{action.label}</span>
            </Button>
          </Tooltip>
        ))}
      </div>
    </div>
  );
}
