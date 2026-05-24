import {
  Button,
  Menu,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  makeStyles,
  mergeClasses,
  useIsOverflowItemVisible,
  useOverflowMenu,
} from "@fluentui/react-components";
import { MoreHorizontal24Regular } from "@fluentui/react-icons";
import { glassButtonStyles } from "@/components/ui/glassButtonStyles";

export interface OverflowAction {
  key: string;
  label: string;
  icon?: JSX.Element;
  disabled?: boolean;
  onClick: () => void;
  priority?: number;
}

const OverflowMenuItem = ({ action }: { action: OverflowAction }) => {
  const isVisible = useIsOverflowItemVisible(action.key);
  if (isVisible) return null;
  return (
    <MenuItem disabled={action.disabled} onClick={action.onClick}>
      {action.label}
    </MenuItem>
  );
};

const useStyles = makeStyles({
  moreButton: {
    ...glassButtonStyles,
  },
});

export const ActionOverflowMenu = ({ actions, className }: { actions: OverflowAction[]; className?: string }) => {
  const styles = useStyles();
  const { ref, isOverflowing } = useOverflowMenu<HTMLButtonElement>();
  if (!isOverflowing) return null;
  return (
    <Menu>
      <MenuTrigger disableButtonEnhancement>
        <Button ref={ref} appearance="subtle" icon={<MoreHorizontal24Regular />} className={mergeClasses(styles.moreButton, className)}>
          More
        </Button>
      </MenuTrigger>
      <MenuPopover>
        <MenuList>
          {actions.map((action) => (
            <OverflowMenuItem key={action.key} action={action} />
          ))}
        </MenuList>
      </MenuPopover>
    </Menu>
  );
};
