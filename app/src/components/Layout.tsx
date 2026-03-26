import { useEffect } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import {
  Button,
  Text,
  Title3,
  makeStyles,
  tokens,
  Badge,
  mergeClasses,
} from "@fluentui/react-components";
import {
  Settings24Regular,
  DataUsage24Regular,
  Library24Regular,
} from "@fluentui/react-icons";
const logo = "/assets/images/logo.png";
import { useDownloadQueue } from "@/hooks/useDownloadQueue";
import { useTidalConnection } from "@/hooks/useTidalConnection";
import GlobalSearch from "./GlobalSearch";
import { UltraBlurBackground } from "@/ultrablur/UltraBlurBackground";
import { useUltraBlurContext } from "@/providers/UltraBlurContext";
import { MobileBottomTabs } from "./MobileBottomTabs";
import { hexToRgb } from "@/ultrablur/color";
import { OPEN_ACTIVITY_QUEUE_EVENT } from "@/utils/appEvents";
import { useTheme } from "@/providers/themeContext";

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
    display: "none",
    "@media (min-width: 640px)": {
      display: "block",
    },
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
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
    boxSizing: "border-box",
    width: "100%",
    "@media (min-width: 640px)": {
      flexDirection: "row",
      alignItems: "center",
      gap: tokens.spacingHorizontalM,
      padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
    },
  },
  headerRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    width: "100%",
    "@media (min-width: 640px)": {
      width: "auto",
    },
  },
  logoSection: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    minWidth: 0,
    "@media (min-width: 640px)": {
      gap: tokens.spacingHorizontalM,
    },
  },
  logoButton: {
    backgroundColor: tokens.colorTransparentBackground,
    border: "none",
    padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalXXS}`,
    cursor: "pointer",
    minHeight: "36px",
    color: tokens.colorNeutralForeground1,
    maxWidth: "100%",
    "@media (min-width: 640px)": {
      padding: tokens.spacingVerticalNone,
      minHeight: "40px",
    },
  },
  logo: {
    display: "block",
    height: "24px",
    width: "24px",
    objectFit: "contain",
    flexShrink: 0,
    "@media (min-width: 640px)": {
      height: "40px",
      width: "40px",
    },
  },
  logoTitle: {
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    "@media (min-width: 640px)": {
      fontSize: tokens.fontSizeBase500,
      lineHeight: tokens.lineHeightBase500,
    },
  },
  searchSection: {
    display: "none",
    "@media (min-width: 640px)": {
      display: "flex",
      flex: 1,
      justifyContent: "center",
      width: "100%",
    },
  },
  searchContainer: {
    width: "100%",
    maxWidth: "500px",
  },
  desktopActions: {
    display: "none",
    "@media (min-width: 640px)": {
      display: "flex",
      alignItems: "center",
      gap: tokens.spacingHorizontalS,
    },
  },
  mobileActions: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    "@media (min-width: 640px)": {
      display: "none",
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
    minWidth: "36px",
    minHeight: "36px",
    "@media (max-width: 639px)": {
      minWidth: "40px",
      minHeight: "40px",
    },
  },
  queueBadge: {
    position: "absolute",
    top: `calc(-1 * ${tokens.spacingVerticalXS})`,
    right: `calc(-1 * ${tokens.spacingHorizontalXS})`,
  },
  main: {
    maxWidth: "1320px",
    marginTop: tokens.spacingVerticalNone,
    marginBottom: tokens.spacingVerticalNone,
    marginLeft: "auto",
    marginRight: "auto",
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalS}`,
    // Safe area insets for PWA - left/right for notch devices, bottom for home indicator
    paddingLeft: `max(${tokens.spacingHorizontalS}, env(safe-area-inset-left))`,
    paddingRight: `max(${tokens.spacingHorizontalS}, env(safe-area-inset-right))`,
    // Extra bottom padding on mobile for bottom tab bar (56px tab bar + safe area)
    paddingBottom: `max(calc(64px + env(safe-area-inset-bottom)), ${tokens.spacingVerticalM})`,
    paddingTop: `max(${tokens.spacingVerticalM}, env(safe-area-inset-top))`,
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
  tidalBannerWrap: {
    maxWidth: "1320px",
    marginTop: tokens.spacingVerticalS,
    marginBottom: tokens.spacingVerticalNone,
    marginLeft: "auto",
    marginRight: "auto",
    paddingLeft: `max(${tokens.spacingHorizontalS}, env(safe-area-inset-left))`,
    paddingRight: `max(${tokens.spacingHorizontalS}, env(safe-area-inset-right))`,
    "@media (min-width: 640px)": {
      paddingLeft: `max(${tokens.spacingHorizontalM}, env(safe-area-inset-left))`,
      paddingRight: `max(${tokens.spacingHorizontalM}, env(safe-area-inset-right))`,
    },
  },
  tidalBanner: {
    display: "flex",
    flexDirection: "column",
    alignItems: "stretch",
    gap: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusLarge,
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalM}`,
    border: `${tokens.strokeWidthThin} solid color-mix(in srgb, ${tokens.colorPaletteMarigoldBorder2} 55%, ${tokens.colorNeutralStroke2})`,
    backgroundColor: `color-mix(in srgb, ${tokens.colorPaletteMarigoldBackground2} 65%, ${tokens.colorNeutralBackground1})`,
    boxShadow: tokens.shadow4,
    "@media (min-width: 640px)": {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
  },
  tidalBannerInfo: {
    display: "flex",
    flexDirection: "column",
    alignItems: "stretch",
    gap: tokens.spacingVerticalS,
    flex: 1,
    minWidth: 0,
    "@media (min-width: 640px)": {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: tokens.spacingHorizontalM,
    },
  },
  tidalBannerIcon: {
    flexShrink: 0,
    color: tokens.colorPaletteGoldForeground2,
    alignSelf: "center",
    "@media (min-width: 640px)": {
      alignSelf: "flex-start",
      marginTop: "2px",
    },
  },
  tidalBannerText: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXXS,
    minWidth: 0,
    textAlign: "center",
    "@media (min-width: 640px)": {
      textAlign: "left",
    },
  },
  tidalBannerTitleRow: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    "@media (min-width: 640px)": {
      flexDirection: "row",
      alignItems: "center",
      flexWrap: "wrap",
    },
  },
  tidalBannerActions: {
    display: "grid",
    gridTemplateColumns: "1fr",
    gap: tokens.spacingHorizontalS,
    width: "100%",
    "@media (min-width: 640px)": {
      display: "flex",
      alignItems: "center",
      width: "auto",
      marginLeft: "auto",
    },
  },
  tidalBannerBody: {
    color: tokens.colorNeutralForeground2,
  },
  tidalBannerPrimaryButton: {
    width: "100%",
    justifyContent: "center",
    "@media (min-width: 640px)": {
      width: "auto",
    },
  },
});

const Layout = () => {
  const styles = useStyles();
  const navigate = useNavigate();
  const location = useLocation();
  const { colors } = useUltraBlurContext();
  const { isDarkMode } = useTheme();
  const { stats } = useDownloadQueue();
  const { status } = useTidalConnection();
  const isAuthRoute = location.pathname === "/auth";

  const showProviderModeBanner = Boolean(status?.canAccessShell && !status?.remoteCatalogAvailable);
  const providerModeLabel = status?.mode === "mock" ? "Mock auth" : "Local only";
  const providerModeTitle = status?.mode === "mock"
    ? "Mock provider auth mode"
    : "Disconnected local-library mode";
  const providerModeMessage = status?.message
    || "Remote provider access is unavailable. Library pages and search are limited to indexed local content.";

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
      <UltraBlurBackground colors={colors} />
      <div className={styles.wrapper}>
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

                <div className={styles.mobileActions}>
                  <Button
                    appearance="subtle"
                    icon={<DataUsage24Regular />}
                    onClick={() => navigate("/dashboard")}
                    title="Dashboard"
                    className={styles.navIconButton}
                  />

                  <Button
                    appearance="subtle"
                    icon={<Settings24Regular />}
                    onClick={() => navigate("/settings")}
                    title="Settings"
                    className={styles.navIconButton}
                  />
                </div>
              </div>

              <div className={styles.searchSection}>
                <div className={styles.searchContainer}>
                  <GlobalSearch />
                </div>
              </div>

              <div className={styles.desktopActions}>
                <Button
                  appearance="subtle"
                  icon={<DataUsage24Regular />}
                  onClick={() => navigate("/dashboard")}
                  title="Dashboard"
                  className={styles.navIconButton}
                />
                <Button
                  appearance="subtle"
                  icon={<Library24Regular />}
                  onClick={() => navigate("/")}
                  title="Library"
                  className={styles.navIconButton}
                />
                <Button
                  appearance="subtle"
                  icon={<Settings24Regular />}
                  onClick={() => navigate("/settings")}
                  title="Settings"
                  className={styles.navIconButton}
                />
              </div>
            </div>
          </nav>
        ) : null}
        {!isAuthRoute && showProviderModeBanner ? (
          <div className={styles.tidalBannerWrap}>
            <div className={styles.tidalBanner}>
              <div className={styles.tidalBannerInfo}>
                <div className={styles.tidalBannerText}>
                  <div className={styles.tidalBannerTitleRow}>
                    <Title3>{providerModeTitle}</Title3>
                    <Badge appearance="filled" color="warning">
                      {providerModeLabel}
                    </Badge>
                  </div>
                  <Text className={styles.tidalBannerBody}>{providerModeMessage}</Text>
                </div>
              </div>
              <div className={styles.tidalBannerActions}>
                <Button
                  appearance="secondary"
                  className={styles.tidalBannerPrimaryButton}
                  onClick={() => navigate("/search")}
                >
                  Search local library
                </Button>
              </div>
            </div>
          </div>
        ) : null}
        <main className={mergeClasses(styles.main, isAuthRoute && styles.authMain)}>
          <Outlet />
        </main>

        {!isAuthRoute ? (
          <MobileBottomTabs isDark={isDarkMode} queueCount={stats.downloading + stats.pending} />
        ) : null}
      </div>
    </>
  );
};

export default Layout;
