import { useEffect } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import {
  Badge,
  Button,
  Title3,
  makeStyles,
  tokens,
  mergeClasses,
} from "@fluentui/react-components";
import {
  Settings24Regular,
  DataUsage24Regular,
  Library24Regular,
} from "@fluentui/react-icons";
const logo = "/assets/images/logo.png";
import { useQueueStatus } from "@/hooks/useQueueStatus";
import GlobalSearch from "./GlobalSearch";
import { UltraBlurBackground } from "@/ultrablur/UltraBlurBackground";
import { useUltraBlurContext } from "@/providers/UltraBlurContext";
import { hexToRgb } from "@/ultrablur/color";
import { OPEN_ACTIVITY_QUEUE_EVENT } from "@/utils/appEvents";
import { useTheme } from "@/providers/themeContext";
import { glassButtonStyles } from "@/components/ui/glassButtonStyles";

function isStandaloneDisplayMode(): boolean {
  // iOS Safari uses `navigator.standalone`, other browsers support the media query.
  const nav = navigator as Navigator & { standalone?: boolean };
  return Boolean(nav.standalone) || window.matchMedia?.("(display-mode: standalone)").matches;
}

function setThemeColor(content: string) {
  const meta = document.querySelector('meta[name="theme-color"]') as HTMLMetaElement | null;
  if (!meta) return;
  meta.setAttribute("content", content);
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function clamp255(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

function rgbToHex(rgb: { r: number; g: number; b: number }): string {
  const to2 = (n: number) => clamp255(n).toString(16).padStart(2, "0");
  return `#${to2(rgb.r)}${to2(rgb.g)}${to2(rgb.b)}`.toUpperCase();
}

function mixHex(a: string, b: string, t: number): string {
  const aa = hexToRgb(a);
  const bb = hexToRgb(b);
  const tt = clamp01(t);
  return rgbToHex({
    r: aa.r + (bb.r - aa.r) * tt,
    g: aa.g + (bb.g - aa.g) * tt,
    b: aa.b + (bb.b - aa.b) * tt,
  });
}

function deriveStatusBarColor(
  colors: { topLeft: string; topRight: string },
  isDark: boolean
): string {
  const top = mixHex(colors.topLeft, colors.topRight, 0.5);
  // Approximate the UltraBlur overlay so the system bar "blends" with the background.
  return mixHex(top, isDark ? "#0b0f1a" : "#ffffff", 0.65);
}

const useStyles = makeStyles({
  nav: {
    position: "sticky",
    top: 0,
    zIndex: 50,
    backdropFilter: "blur(30px) saturate(125%)",
    WebkitBackdropFilter: "blur(30px) saturate(125%)",
    // Fluent Design: Use elevation shadow instead of border
    boxShadow: tokens.shadow4,
    borderBottom: "none",
    // Safe area insets for PWA status bar
    paddingTop: "env(safe-area-inset-top)",
    paddingLeft: "env(safe-area-inset-left)",
    paddingRight: "env(safe-area-inset-right)",
    display: "block",
  },
  navDark: {
    backgroundColor: `color-mix(in srgb, ${tokens.colorNeutralBackground1} 70%, transparent)`,
  },
  navLight: {
    backgroundColor: `color-mix(in srgb, ${tokens.colorNeutralBackground1} 85%, transparent)`,
  },
  container: {
    maxWidth: "1320px",
    marginTop: tokens.spacingVerticalNone,
    marginBottom: tokens.spacingVerticalNone,
    marginLeft: "auto",
    marginRight: "auto",
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalS}`,
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
    boxSizing: "border-box",
    width: "100%",
    "@media (min-width: 640px)": {
      gap: tokens.spacingHorizontalM,
      padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
    },
  },
  headerRow: {
    display: "flex",
    alignItems: "center",
    flex: "0 0 auto",
    minWidth: 0,
  },
  logoSection: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
    minWidth: 0,
    "@media (min-width: 640px)": {
      gap: tokens.spacingHorizontalS,
    },
  },
  logoButton: {
    backgroundColor: tokens.colorTransparentBackground,
    border: "none",
    padding: tokens.spacingVerticalNone,
    cursor: "pointer",
    minHeight: "36px",
    minWidth: "34px",
    color: tokens.colorNeutralForeground1,
    maxWidth: "100%",
    "@media (min-width: 640px)": {
      padding: tokens.spacingVerticalNone,
      minHeight: "40px",
    },
  },
  logo: {
    display: "block",
    height: "30px",
    width: "30px",
    objectFit: "contain",
    flexShrink: 0,
    "@media (min-width: 640px)": {
      height: "36px",
      width: "36px",
    },
  },
  logoTitle: {
    display: "none",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    "@media (min-width: 640px)": {
      display: "block",
      fontSize: tokens.fontSizeBase500,
      lineHeight: tokens.lineHeightBase500,
    },
  },
  searchSection: {
    display: "flex",
    flex: "1 1 auto",
    minWidth: 0,
    justifyContent: "center",
  },
  searchContainer: {
    width: "100%",
    maxWidth: "500px",
    minWidth: 0,
    "@media (max-width: 639px)": {
      maxWidth: "none",
    },
  },
  desktopActions: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXXS,
    flex: "0 0 auto",
    "@media (min-width: 640px)": {
      gap: tokens.spacingHorizontalS,
    },
  },
  statusIndicator: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorTransparentBackground,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2,
  },
  queueButton: {
    position: "relative",
  },
  navIconButton: {
    ...glassButtonStyles,
    minWidth: "36px",
    minHeight: "36px",
    "@media (max-width: 639px)": {
      minWidth: "32px",
      minHeight: "32px",
      paddingLeft: tokens.spacingHorizontalXS,
      paddingRight: tokens.spacingHorizontalXS,
    },
  },
  queueBadge: {
    position: "absolute",
    top: "1px",
    right: "1px",
  },
  main: {
    maxWidth: "1320px",
    marginTop: tokens.spacingVerticalNone,
    marginBottom: tokens.spacingVerticalNone,
    marginLeft: "auto",
    marginRight: "auto",
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalS}`,
    // Safe area insets for PWA - left/right for notch devices, bottom for home indicator
    paddingLeft: `max(${tokens.spacingHorizontalSNudge}, env(safe-area-inset-left))`,
    paddingRight: `max(${tokens.spacingHorizontalSNudge}, env(safe-area-inset-right))`,
    paddingBottom: `max(${tokens.spacingVerticalM}, env(safe-area-inset-bottom))`,
    paddingTop: tokens.spacingVerticalM,
    boxSizing: "border-box",
    width: "100%",
    overflowX: "hidden",
    "@media (min-width: 640px)": {
      padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalM}`,
      paddingLeft: `max(${tokens.spacingHorizontalM}, env(safe-area-inset-left))`,
      paddingRight: `max(${tokens.spacingHorizontalM}, env(safe-area-inset-right))`,
      paddingBottom: `max(${tokens.spacingVerticalM}, env(safe-area-inset-bottom))`,
      paddingTop: tokens.spacingVerticalM,
    },
  },
  authMain: {
    maxWidth: "none",
    minHeight: "100dvh",
    paddingTop: "env(safe-area-inset-top)",
    paddingRight: "env(safe-area-inset-right)",
    paddingBottom: "env(safe-area-inset-bottom)",
    paddingLeft: "env(safe-area-inset-left)",
    display: "flex",
    alignItems: "stretch",
    "@media (min-width: 640px)": {
      paddingTop: "env(safe-area-inset-top)",
      paddingRight: "env(safe-area-inset-right)",
      paddingBottom: "env(safe-area-inset-bottom)",
      paddingLeft: "env(safe-area-inset-left)",
    },
  },
  wrapper: {
    minHeight: "100vh",
    position: "relative",
    zIndex: 1,
  },
  authWrapper: {
    position: "fixed",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    height: "100dvh",
    minHeight: "100dvh",
    overflow: "hidden",
  },
});

const Layout = () => {
  const styles = useStyles();
  const navigate = useNavigate();
  const location = useLocation();
  const { colors, isDarkMode: ultraBlurIsDarkMode } = useUltraBlurContext();
  const { isDarkMode } = useTheme();
  const { stats } = useQueueStatus();
  const isAuthRoute = location.pathname === "/auth";
  const showNavSearch = !isAuthRoute;
  const queueCount = stats.downloading + stats.pending;

  useEffect(() => {
    if (!isStandaloneDisplayMode()) return;
    try {
      setThemeColor(deriveStatusBarColor({ topLeft: colors.topLeft, topRight: colors.topRight }, isDarkMode));
    } catch (e) {
      console.warn("Failed to update theme-color:", e);
    }
  }, [colors.topLeft, colors.topRight, isDarkMode]);

  useEffect(() => {
    const openQueue = () => navigate("/dashboard");
    window.addEventListener(OPEN_ACTIVITY_QUEUE_EVENT, openQueue);
    return () => window.removeEventListener(OPEN_ACTIVITY_QUEUE_EVENT, openQueue);
  }, [navigate]);


  return (
    <>
      <UltraBlurBackground colors={colors} isDarkMode={ultraBlurIsDarkMode} />
      <div className={mergeClasses(styles.wrapper, isAuthRoute && styles.authWrapper)}>
        {!isAuthRoute ? (
          <nav className={mergeClasses(styles.nav, isDarkMode ? styles.navDark : styles.navLight)}>
            <div className={styles.container}>
              <div className={styles.headerRow}>
                <button
                  className={mergeClasses(styles.logoSection, styles.logoButton)}
                  onClick={() => navigate("/")}
                >
                  <img src={logo} alt="Discogenius" className={styles.logo} />
                  <Title3 className={styles.logoTitle}>Discogenius</Title3>
                </button>
              </div>

              <div className={styles.searchSection}>
                <div className={styles.searchContainer}>
                  {showNavSearch ? <GlobalSearch /> : null}
                </div>
              </div>

              <div className={styles.desktopActions}>
                <Button
                  appearance="subtle"
                  icon={<DataUsage24Regular />}
                  onClick={() => navigate("/dashboard")}
                  title="Dashboard"
                  aria-label="Dashboard"
                  className={mergeClasses(styles.navIconButton, styles.queueButton)}
                >
                  {queueCount > 0 ? (
                    <Badge
                      aria-hidden="true"
                      className={styles.queueBadge}
                      appearance="filled"
                      color="brand"
                      size="small"
                      shape="circular"
                    >
                      {queueCount}
                    </Badge>
                  ) : null}
                </Button>
                <Button
                  appearance="subtle"
                  icon={<Library24Regular />}
                  onClick={() => navigate("/")}
                  title="Library"
                  aria-label="Library"
                  className={styles.navIconButton}
                />
                <Button
                  appearance="subtle"
                  icon={<Settings24Regular />}
                  onClick={() => navigate("/settings")}
                  title="Settings"
                  aria-label="Settings"
                  className={styles.navIconButton}
                />
              </div>
            </div>
          </nav>
        ) : null}
        <main className={mergeClasses(styles.main, isAuthRoute && styles.authMain)}>
          <Outlet />
        </main>
      </div>
    </>
  );
};

export default Layout;
