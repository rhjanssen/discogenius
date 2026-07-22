import type { MouseEvent, ReactElement } from "react";
import { Button, makeStyles, mergeClasses, tokens } from "@fluentui/react-components";
import { glassButtonStyles } from "@/components/ui/glassButtonStyles";
import { AppTooltip } from "@/components/ui/AppTooltip";

export interface LibraryRowActionItem {
  key: string;
  label: string;
  icon: ReactElement;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  hidden?: boolean;
}

interface LibraryRowActionsProps {
  actions: LibraryRowActionItem[];
  className?: string;
}

const useStyles = makeStyles({
  root: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXXS,
    justifyContent: "flex-end",
    flexWrap: "nowrap",
    // Content-sized strip — do not artificially cap width or Fluent Overflow will
    // park the last action alone behind a "more" menu even when it fits.
    width: "max-content",
    maxWidth: "100%",
  },
  actionButton: {
    ...glassButtonStyles,
  },
});

export function LibraryRowActions({ actions, className }: LibraryRowActionsProps) {
  const styles = useStyles();

  return (
    <div className={mergeClasses(styles.root, className)}>
      {actions.filter((action) => !action.hidden).map((action) => (
        <AppTooltip key={action.key} content={action.label} relationship="label">
          <Button
            appearance="subtle"
            size="small"
            icon={action.icon}
            disabled={action.disabled}
            onClick={action.onClick}
            className={styles.actionButton}
          />
        </AppTooltip>
      ))}
    </div>
  );
}
