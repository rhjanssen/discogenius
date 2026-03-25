import type { ReactElement } from "react";
import { Button, Badge, makeStyles, mergeClasses, tokens } from "@fluentui/react-components";

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
    gap: tokens.spacingHorizontalM,
    flexWrap: "wrap",
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    backgroundColor: `color-mix(in srgb, ${tokens.colorNeutralBackground1} 72%, transparent)`,
    borderRadius: tokens.borderRadiusLarge,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    backdropFilter: "blur(18px)",
    WebkitBackdropFilter: "blur(18px)",
  },
  meta: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    flexWrap: "wrap",
    minWidth: 0,
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
    gap: tokens.spacingHorizontalXS,
    flexWrap: "wrap",
    justifyContent: "flex-end",
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
        <Badge appearance="filled" color={selectedCount > 0 ? "brand" : "subtle"} size="large">
          {selectedCount} selected
        </Badge>
        <Button
          appearance="subtle"
          size="small"
          onClick={onSelectAllVisible}
          disabled={allVisibleSelected && !someVisibleSelected}
        >
          Select all visible
        </Button>
        <Button
          appearance="subtle"
          size="small"
          onClick={onClearSelection}
          disabled={selectedCount === 0}
        >
          Deselect all
        </Button>
      </div>

      <div className={styles.actionRow}>
        {actions.map((action) => (
          <Button
            key={action.key}
            appearance={action.appearance ?? "subtle"}
            size="small"
            icon={action.icon}
            disabled={action.disabled}
            onClick={action.onClick}
          >
            {action.label}
          </Button>
        ))}
      </div>
    </div>
  );
}
