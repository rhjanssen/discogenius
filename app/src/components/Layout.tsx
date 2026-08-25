import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import {
  Badge,
  makeStyles,
  tokens,
  mergeClasses,
} from "@fluentui/react-components";
import {
  Settings24Regular,
  DataUsage24Regular,
  Library24Regular,
  Settings24Filled,
  DataUsage24Filled,
  Library24Filled,
} from "@fluentui/react-icons";
const logo = "/assets/images/logo.png";
import { useQueueStatus } from "@/hooks/useQueueStatus";
import GlobalSearch from "./GlobalSearch";
import ScrollRestoration from "./ScrollRestoration";
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
    "@media (forced-colors: active)": {
      backdropFilter: "none",
      WebkitBackdropFilter: "none",
      borderBottom: "1px solid CanvasText",
      boxShadow: "none",
    },
  },
  // WinUI commanding layer on Mica Alt → Fluent colorNeutralBackgroundAlpha2.
  // Content cards use Alpha; UltraBlur is the opaque foundation.
  navSurface: {
    backgroundColor: tokens.colorNeutralBackgroundAlpha2,
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
  logoLink: {
    backgroundColor: tokens.colorTransparentBackground,
    border: "none",
    padding: tokens.spacingVerticalNone,
    cursor: "pointer",
    minHeight: "36px",
    minWidth: "34px",
    color: tokens.colorNeutralForeground1,
    maxWidth: "100%",
    textDecorationLine: "none",
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
  navIconLink: {
    ...glassButtonStyles,
    position: "relative",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    boxSizing: "border-box",
    minWidth: "36px",
    minHeight: "36px",
    borderRadius: tokens.borderRadiusMedium,
    color: tokens.colorNeutralForeground1,
    textDecorationLine: "none",
    "& .dg-nav-icon-filled": {
      display: "none",
    },
    "&:hover": {
      color: tokens.colorBrandForeground1,
    },
    "&:hover .dg-nav-icon-regular": {
      display: "none",
    },
    "&:hover .dg-nav-icon-filled": {
      display: "block",
    },
    "&[aria-current='page'] .dg-nav-icon-regular": {
      display: "none",
    },
    "&[aria-current='page'] .dg-nav-icon-filled": {
      display: "block",
    },
    "&:focus-visible": {
      outline: `2px solid ${tokens.colorStrokeFocus2}`,
      outlineOffset: "2px",
    },
    "@media (max-width: 639px)": {
      minWidth: "32px",
      minHeight: "32px",
    },
  },
  navIconLinkActive: {
    color: tokens.colorBrandForeground1,
    backgroundColor: "transparent",
    "@media (forced-colors: active)": {
      color: "HighlightText",
      backgroundColor: "Highlight",
      border: "1px solid Highlight",
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
    paddingLeft: `max(${tokens.spacingHorizontalS}, env(safe-area-inset-left))`,
    paddingRight: `max(${tokens.spacingHorizontalS}, env(safe-area-inset-right))`,
    paddingBottom: `max(${tokens.spacingVerticalM}, env(safe-area-inset-bottom))`,
    paddingTop: tokens.spacingVerticalS,
    boxSizing: "border-box",
    width: "100%",
    // `overflow-x: hidden` forces overflow-y to compute to `auto`, which makes
    // <main> a sticky containing block as tall as its content — so sticky
    // descendants (e.g. Settings category TabList) scroll away with the page.
    // `clip` still suppresses horizontal bleed without creating a scrollport.
    overflowX: "clip",
    "@media (min-width: 640px)": {
      padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
      paddingLeft: `max(${tokens.spacingHorizontalM}, env(safe-area-inset-left))`,
      paddingRight: `max(${tokens.spacingHorizontalM}, env(safe-area-inset-right))`,
      paddingBottom: `max(${tokens.spacingVerticalM}, env(safe-area-inset-bottom))`,
      paddingTop: tokens.spacingVerticalS,
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
  skipLink: {
    position: "fixed",
    top: tokens.spacingVerticalS,
    left: tokens.spacingHorizontalS,
    zIndex: 1000,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusMedium,
    color: tokens.colorNeutralForegroundOnBrand,
    backgroundColor: tokens.colorBrandBackground,
    transform: "translateY(-160%)",
    transitionProperty: "transform",
    transitionDuration: tokens.durationFast,
    "&:focus": {
      transform: "translateY(0)",
    },
    "@media (prefers-reduced-motion: reduce)": {
      transitionDuration: "0.01ms",
    },
  },
  visuallyHidden: {
    position: "absolute",
    width: "1px",
    height: "1px",
    padding: 0,
    margin: "-1px",
    overflow: "hidden",
    clip: "rect(0, 0, 0, 0)",
    whiteSpace: "nowrap",
    border: 0,
  },
});

function routeLabel(pathname: string): string {
  if (pathname === "/" || pathname === "/library") return "Library";
  if (pathname === "/dashboard") return "Dashboard";
  if (pathname === "/settings") return "Settings";
  if (pathname === "/system/status") return "System status";
  if (pathname === "/auth") return "Provider authorization";
  if (pathname === "/login") return "Sign in";
  if (pathname.startsWith("/artist/")) return "Artist";
  if (pathname.startsWith("/album/")) return "Album";
  if (pathname.startsWith("/video/")) return "Video";
  return "Page not found";
}

const Layout = () => {
  const styles = useStyles();
  const navigate = useNavigate();
  const location = useLocation();
  const mainRef = useRef<HTMLElement | null>(null);
  const previousPathRef = useRef<string | null>(null);
  const [routeAnnouncement, setRouteAnnouncement] = useState("");
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

  useEffect(() => {
    const label = routeLabel(location.pathname);
    document.title = label === "Library" ? "Discogenius" : `${label} | Discogenius`;
    setRouteAnnouncement(`${label} page`);

    const isInitialRoute = previousPathRef.current === null;
    previousPathRef.current = location.pathname;
    if (isInitialRoute) return;

    const main = mainRef.current;
    if (!main) return;

    let focused = false;
    const focusPage = () => {
      const heading = main.querySelector<HTMLElement>("h1");
      if (!heading) return false;
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
      focused = true;
      return true;
    };

    const observer = new MutationObserver(() => {
      if (focusPage()) observer.disconnect();
    });
    observer.observe(main, { childList: true, subtree: true });
    // Lazy routes briefly remove the old page before mounting the next one.
    // Give that commit a chance to finish so focus never lands on a heading
    // that is about to be detached.
    const headingTimer = window.setTimeout(focusPage, 100);
    const fallbackTimer = window.setTimeout(() => {
      if (!focused) main.focus({ preventScroll: true });
    }, 1200);
    const observerTimer = window.setTimeout(() => observer.disconnect(), 10_000);

    return () => {
      observer.disconnect();
      window.clearTimeout(headingTimer);
      window.clearTimeout(fallbackTimer);
      window.clearTimeout(observerTimer);
    };
  }, [location.pathname]);


  return (
    <>
      <ScrollRestoration />
      <UltraBlurBackground colors={colors} isDarkMode={ultraBlurIsDarkMode} />
      {!isAuthRoute ? <a className={styles.skipLink} href="#main-content">Skip to main content</a> : null}
      <div className={mergeClasses(styles.wrapper, isAuthRoute && styles.authWrapper)}>
        {!isAuthRoute ? (
          <nav className={mergeClasses(styles.nav, styles.navSurface)} aria-label="Primary navigation">
            <div className={styles.container}>
              <div className={styles.headerRow}>
                <NavLink
                  to="/"
                  end
                  className={mergeClasses(styles.logoSection, styles.logoLink)}
                  aria-label="Discogenius library"
                >
                  <img src={logo} alt="" className={styles.logo} />
                  <span className={styles.logoTitle}>Discogenius</span>
                </NavLink>
              </div>

              <div className={styles.searchSection}>
                <div className={styles.searchContainer}>
                  {showNavSearch ? <GlobalSearch /> : null}
                </div>
              </div>

              <div className={styles.desktopActions}>
                <NavLink
                  to="/dashboard"
                  title="Dashboard"
                  aria-label="Dashboard"
                  className={({ isActive }) => mergeClasses(
                    styles.navIconLink,
                    styles.queueButton,
                    isActive && styles.navIconLinkActive,
                  )}
                >
                  <DataUsage24Regular className="dg-nav-icon-regular" aria-hidden="true" />
                  <DataUsage24Filled className="dg-nav-icon-filled" aria-hidden="true" />
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
                </NavLink>
                <NavLink
                  to="/"
                  end
                  title="Library"
                  aria-label="Library"
                  className={({ isActive }) => mergeClasses(
                    styles.navIconLink,
                    isActive && styles.navIconLinkActive,
                  )}
                >
                  <Library24Regular className="dg-nav-icon-regular" aria-hidden="true" />
                  <Library24Filled className="dg-nav-icon-filled" aria-hidden="true" />
                </NavLink>
                <NavLink
                  to="/settings"
                  title="Settings"
                  aria-label="Settings"
                  className={({ isActive }) => mergeClasses(
                    styles.navIconLink,
                    isActive && styles.navIconLinkActive,
                  )}
                >
                  <Settings24Regular className="dg-nav-icon-regular" aria-hidden="true" />
                  <Settings24Filled className="dg-nav-icon-filled" aria-hidden="true" />
                </NavLink>
              </div>
            </div>
          </nav>
        ) : null}
        <main
          id="main-content"
          ref={mainRef}
          tabIndex={-1}
          className={mergeClasses(styles.main, isAuthRoute && styles.authMain)}
        >
          <Outlet />
        </main>
        <div className={styles.visuallyHidden} role="status" aria-live="polite" aria-atomic="true">
          {routeAnnouncement}
        </div>
      </div>
    </>
  );
};

export default Layout;
