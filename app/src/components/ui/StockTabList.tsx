import {
  Button,
  makeStyles,
  Menu,
  MenuItemRadio,
  MenuList,
  MenuPopover,
  MenuTrigger,
  Tab,
  TabList,
  tokens,
} from "@fluentui/react-components";
import {
  ChevronDown24Filled,
  ChevronDown24Regular,
  bundleIcon,
} from "@fluentui/react-icons";
import type { ReactElement } from "react";
import { glassButtonStyles } from "@/components/ui/glassButtonStyles";

const ChevronDown24 = bundleIcon(ChevronDown24Filled, ChevronDown24Regular);

const useResponsiveStyles = makeStyles({
  mobile: {
    display: "block",
    "@media (min-width: 640px)": { display: "none" },
  },
  desktop: {
    display: "none",
    overflow: "visible",
    "@media (min-width: 640px)": { display: "block" },
  },
  menuButton: {
    ...glassButtonStyles,
    minHeight: "40px",
    minWidth: "40px",
    paddingLeft: tokens.spacingHorizontalS,
    paddingRight: tokens.spacingHorizontalS,
  },
  menuLabel: {
    display: "inline-flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
  },
});

export type StockTabItem = {
  key: string;
  label: string;
  icon?: ReactElement;
  title?: string;
};

type StockTabListProps = {
  idBase: string;
  ariaLabel: string;
  items: readonly StockTabItem[];
  selectedValue: string;
  onSelect: (value: string) => void;
  className?: string;
};

/**
 * The app-wide content-view tab treatment. Layout, focus, hover, selected
 * indicator, and bundled icon state are intentionally left to Fluent UI.
 */
export function StockTabList({
  idBase,
  ariaLabel,
  items,
  selectedValue,
  onSelect,
  className,
}: StockTabListProps): ReactElement {
  return (
    <TabList
      aria-label={ariaLabel}
      className={className}
      size="small"
      selectedValue={selectedValue}
      onTabSelect={(_, data) => onSelect(String(data.value))}
    >
      {items.map((item) => (
        <Tab
          key={item.key}
          id={`${propsId(idBase)}-tab-${item.key}`}
          aria-controls={`${propsId(idBase)}-panel-${item.key}`}
          value={item.key}
          icon={item.icon}
          title={item.title}
        >
          {item.label}
        </Tab>
      ))}
    </TabList>
  );
}

function propsId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}

/** Stock tabs on wider layouts, and an equivalent radio menu where tabs would be squeezed. */
export function ResponsiveStockTabList(props: StockTabListProps): ReactElement {
  const styles = useResponsiveStyles();
  const selected = props.items.find((item) => item.key === props.selectedValue) ?? props.items[0];

  return (
    <>
      <div className={styles.mobile}>
        <Menu checkedValues={{ view: [props.selectedValue] }}>
          <MenuTrigger disableButtonEnhancement>
            <Button
              appearance="subtle"
              className={styles.menuButton}
              icon={<ChevronDown24 />}
              iconPosition="after"
            >
              <span className={styles.menuLabel}>
                {selected?.icon}
                {selected?.label ?? "Choose view"}
              </span>
            </Button>
          </MenuTrigger>
          <MenuPopover>
            <MenuList>
              {props.items.map((item) => (
                <MenuItemRadio
                  key={item.key}
                  name="view"
                  value={item.key}
                  icon={item.icon}
                  onClick={() => props.onSelect(item.key)}
                >
                  {item.label}
                </MenuItemRadio>
              ))}
            </MenuList>
          </MenuPopover>
        </Menu>
      </div>
      <div className={styles.desktop}>
        <StockTabList {...props} />
      </div>
    </>
  );
}
