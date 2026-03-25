import type { MouseEvent, ReactElement } from "react";
import { Button, Tooltip, makeStyles, tokens } from "@fluentui/react-components";

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
  },
});

export function LibraryRowActions({ actions, className }: LibraryRowActionsProps) {
  const styles = useStyles();

  return (
    <div className={`${styles.root} ${className || ""}`.trim()}>
      {actions.filter((action) => !action.hidden).map((action) => (
        <Tooltip key={action.key} content={action.label} relationship="label">
          <Button
            appearance="subtle"
            size="small"
            icon={action.icon}
            disabled={action.disabled}
            onClick={action.onClick}
          />
        </Tooltip>
      ))}
    </div>
  );
}
