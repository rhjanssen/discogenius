import {
  Button,
  Menu,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  useIsOverflowItemVisible,
  useOverflowMenu,
} from "@fluentui/react-components";
import { MoreHorizontal24Regular } from "@fluentui/react-icons";

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

export const ActionOverflowMenu = ({ actions }: { actions: OverflowAction[] }) => {
  const { ref, overflowCount, isOverflowing } = useOverflowMenu<HTMLButtonElement>();
  if (!isOverflowing) return null;
  return (
    <Menu>
      <MenuTrigger disableButtonEnhancement>
        <Button ref={ref} appearance="subtle" icon={<MoreHorizontal24Regular />}>
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
