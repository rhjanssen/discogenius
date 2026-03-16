import { useNavigate, useLocation } from "react-router-dom";
import { makeStyles, tokens, Badge, mergeClasses } from "@fluentui/react-components";
import {
  Library24Regular,
  Library24Filled,
  DataUsage24Regular,
  DataUsage24Filled,
  Settings24Regular,
  Settings24Filled,
  ArrowDownload24Regular,
  ArrowDownload24Filled,
  Search24Regular,
  Search24Filled,
} from "@fluentui/react-icons";
// Queue stats passed from Layout to avoid duplicate polling/SSE connections.
import { OPEN_ACTIVITY_QUEUE_EVENT, OPEN_SEARCH_EVENT } from "@/utils/appEvents";

const useStyles = makeStyles({
  bar: {
    display: "flex",
    position: "fixed",
    bottom: 0,
    left: 0,
    right: 0,
    zIndex: 50,
    backdropFilter: "blur(30px) saturate(125%)",
    WebkitBackdropFilter: "blur(30px) saturate(125%)",
    boxShadow: tokens.shadow8,
    borderTop: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStrokeAlpha2}`,
    // Safe area for home indicator
    paddingBottom: "env(safe-area-inset-bottom)",
    paddingLeft: "env(safe-area-inset-left)",
    paddingRight: "env(safe-area-inset-right)",
    // Only show on mobile
    "@media (min-width: 640px)": {
      display: "none",
    },
  },
  barDark: {
    backgroundColor: `color-mix(in srgb, ${tokens.colorNeutralBackground1} 70%, transparent)`,
  },
  barLight: {
    backgroundColor: `color-mix(in srgb, ${tokens.colorNeutralBackground1} 85%, transparent)`,
  },
  tab: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "2px",
    paddingTop: tokens.spacingVerticalS,
    paddingBottom: tokens.spacingVerticalXS,
    cursor: "pointer",
    color: tokens.colorNeutralForeground3,
    backgroundColor: "transparent",
    border: "none",
    fontSize: tokens.fontSizeBase100,
    lineHeight: tokens.lineHeightBase100,
    fontFamily: "inherit",
    transition: `color ${tokens.durationFast} ${tokens.curveEasyEase}`,
    WebkitTapHighlightColor: "transparent",
    position: "relative",
    "&:active": {
      transform: "scale(0.92)",
    },
  },
  tabActive: {
    color: tokens.colorBrandForeground1,
  },
  icon: {
    width: "24px",
    height: "24px",
  },
  queueBadge: {
    position: "absolute",
    top: "2px",
    right: "calc(50% - 20px)",
  },
});

interface MobileBottomTabsProps {
  isDark?: boolean;
  queueCount: number;
}

export function MobileBottomTabs({ isDark = true, queueCount }: MobileBottomTabsProps) {
  const styles = useStyles();
  const navigate = useNavigate();
  const location = useLocation();
  // queueCount provided by Layout

  const currentPath = location.pathname;

  const isLibrary = currentPath === "/" || currentPath.startsWith("/artist") || currentPath.startsWith("/album");
  const isDashboard = currentPath === "/dashboard";
  const isSearch = currentPath === "/search";
  const isSettings = currentPath === "/settings";

  // queueCount already computed by Layout

  const openQueue = () => {
    navigate("/dashboard");
  };

  return (
    <div className={mergeClasses(styles.bar, isDark ? styles.barDark : styles.barLight)}>
      <button
        className={mergeClasses(styles.tab, isDashboard && styles.tabActive)}
        onClick={openQueue}
        aria-label="Dashboard"
      >
        {isDashboard ? (
          <DataUsage24Filled className={styles.icon} />
        ) : (
          <DataUsage24Regular className={styles.icon} />
        )}
        {queueCount > 0 && (
          <Badge
            className={styles.queueBadge}
            appearance="filled"
            color="brand"
            size="small"
            shape="circular"
          >
            {queueCount}
          </Badge>
        )}
        <span>Dashboard</span>
      </button>

      <button
        className={mergeClasses(styles.tab, isLibrary && styles.tabActive)}
        onClick={() => navigate("/")}
        aria-label="Library"
      >
        {isLibrary ? (
          <Library24Filled className={styles.icon} />
        ) : (
          <Library24Regular className={styles.icon} />
        )}
        <span>Library</span>
      </button>

      <button
        className={mergeClasses(styles.tab, isSearch && styles.tabActive)}
        onClick={() => navigate("/search")}
        aria-label="Search"
      >
        {isSearch ? (
          <Search24Filled className={styles.icon} />
        ) : (
          <Search24Regular className={styles.icon} />
        )}
        <span>Search</span>
      </button>

      <button
        className={mergeClasses(styles.tab, isSettings && styles.tabActive)}
        onClick={() => navigate("/settings")}
        aria-label="Settings"
      >
        {isSettings ? (
          <Settings24Filled className={styles.icon} />
        ) : (
          <Settings24Regular className={styles.icon} />
        )}
        <span>Settings</span>
      </button>
    </div>
  );
}
