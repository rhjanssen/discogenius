import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api, type StreamingProviderStatus } from "@/services/api";
import {
  Badge,
  Button,
  Field,
  Input,
  Spinner,
  Text,
  Textarea,
  Title3,
  Body1,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import {
  Door24Regular,
  Open24Regular,
  ArrowRight24Regular,
  WeatherMoon24Regular,
  WeatherSunny24Regular,
  DesktopMac24Regular,
  Door24Filled,
  Open24Filled,
  ArrowRight24Filled,
  WeatherMoon24Filled,
  WeatherSunny24Filled,
  DesktopMac24Filled,
  bundleIcon
} from "@fluentui/react-icons";
import { useToast } from "@/hooks/useToast";
import { useTheme } from "@/providers/themeContext";
import { useUltraBlurContext } from "@/providers/UltraBlurContext";
import { UltraBlurBackground } from "@/ultrablur/UltraBlurBackground";
import type { AuthStatusContract } from "@contracts/auth";
import { ProviderMark } from "@/components/ui/ProviderMark";

const Door24 = bundleIcon(Door24Filled, Door24Regular);
const Open24 = bundleIcon(Open24Filled, Open24Regular);
const ArrowRight24 = bundleIcon(ArrowRight24Filled, ArrowRight24Regular);
const WeatherMoon24 = bundleIcon(WeatherMoon24Filled, WeatherMoon24Regular);
const WeatherSunny24 = bundleIcon(WeatherSunny24Filled, WeatherSunny24Regular);
const DesktopMac24 = bundleIcon(DesktopMac24Filled, DesktopMac24Regular);
const logo = "/assets/images/logo.png";

const useStyles = makeStyles({
  container: {
    // The app shell clips its content area (overflow-y: hidden, 100vh), so the
    // auth page must be its own scroller: a fixed viewport height with internal
    // overflow, rather than min-height that grows past the clip and can't scroll.
    height: '100dvh',
    maxHeight: '100dvh',
    width: '100%',
    display: 'flex',
    // "safe center" keeps the card centred when it fits but falls back to
    // top-aligned (scrollable) when the content is taller than the viewport,
    // instead of clipping the top off-screen with no way to scroll to it.
    alignItems: 'safe center',
    justifyContent: 'center',
    overflowY: 'auto',
    padding: `clamp(${tokens.spacingVerticalL}, 5vw, 72px)`,
    boxSizing: 'border-box',
    position: 'relative',
    zIndex: 1,
  },
  themeToggle: {
    position: 'absolute',
    top: tokens.spacingVerticalL,
    right: tokens.spacingHorizontalL,
    display: 'flex',
    gap: tokens.spacingHorizontalS,
  },
  card: {
    width: '100%',
    maxWidth: '1260px',
    padding: 0,
    overflow: 'visible',
    backgroundColor: 'transparent',
    boxShadow: 'none',
    border: 'none',
  },
  logoContainer: {
    position: 'relative',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    width: 'clamp(150px, 20vw, 248px)',
    height: 'clamp(150px, 20vw, 248px)',
    marginLeft: 'auto',
    marginRight: 'auto',
    marginBottom: tokens.spacingVerticalS,
    overflow: 'visible',
  },
  logoGlow: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    width: '82%',
    aspectRatio: '1',
    borderRadius: tokens.borderRadiusCircular,
    zIndex: 0,
    transform: 'translate(-50%, -50%)',
    backgroundImage: `url(${logo})`,
    backgroundSize: 'contain',
    backgroundRepeat: 'no-repeat',
    backgroundPosition: 'center',
    filter: 'blur(26px) saturate(1.45)',
    opacity: 0.95,
    pointerEvents: 'none',
    '@media (max-width: 640px)': {
      filter: 'blur(20px) saturate(1.5)',
      opacity: 0.9,
    },
  },
  logo: {
    height: '100%',
    width: 'auto',
    maxWidth: '100%',
    display: 'block',
    position: 'relative',
    zIndex: 1,
    filter: `drop-shadow(0 0 2px color-mix(in srgb, ${tokens.colorNeutralForeground1} 20%, transparent))`,
  },
  header: {
    textAlign: 'center',
    marginBottom: tokens.spacingVerticalM,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: tokens.spacingVerticalS,
    '@media (max-width: 640px)': {
      marginBottom: tokens.spacingVerticalM,
    },
  },
  content: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) minmax(360px, 520px)',
    gap: `clamp(${tokens.spacingHorizontalXXL}, 7vw, 120px)`,
    alignItems: 'center',
    '@media (max-width: 980px)': {
      gridTemplateColumns: '1fr',
      gap: tokens.spacingVerticalXXL,
    },
  },
  leftColumn: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    textAlign: 'center',
    gap: tokens.spacingVerticalS,
    padding: `${tokens.spacingVerticalL} ${tokens.spacingHorizontalM}`,
    minWidth: 0,
  },
  leftCopy: {
    width: '100%',
    maxWidth: '560px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    textAlign: 'center',
  },
  brandTitle: {
    display: 'block',
    // Keep "Welcome to Discogenius" on a single line at every width. The clamp is
    // tuned so even the narrower two-column left column (~480px near the 980px
    // breakpoint) fits the ~22-char title without wrapping.
    whiteSpace: 'nowrap',
    fontSize: 'clamp(21px, 3.7vw, 46px)',
    lineHeight: 1.1,
    letterSpacing: 0,
    fontWeight: tokens.fontWeightBold,
    marginBottom: tokens.spacingVerticalS,
    textAlign: 'center',
  },
  leftBody: {
    display: 'block',
    color: tokens.colorNeutralForeground2,
    lineHeight: 1.7,
    maxWidth: '520px',
    textAlign: 'center',
  },
  rightColumn: {
    width: '100%',
    display: 'flex',
    justifyContent: 'center',
    padding: `${tokens.spacingVerticalL} 0`,
  },
  infoBox: {
    width: '100%',
    maxWidth: '520px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: tokens.spacingVerticalL,
    padding: `clamp(${tokens.spacingVerticalXL}, 4vw, 48px)`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: 'color-mix(in srgb, var(--colorNeutralBackground1) 75%, transparent)',
    border: `${tokens.strokeWidthThin} solid color-mix(in srgb, var(--colorNeutralStroke1) 50%, transparent)`,
    boxShadow: tokens.shadow16,
    backdropFilter: 'blur(28px)',
    WebkitBackdropFilter: 'blur(28px)',
    textAlign: 'center',
    '@media (max-width: 900px)': {
      padding: tokens.spacingVerticalL,
    },
  },
  stateHeader: {
    marginBottom: tokens.spacingVerticalL,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
  },
  stateBody: {
    color: tokens.colorNeutralForeground2,
  },
  centeredBody: {
    textAlign: 'center',
    marginTop: tokens.spacingVerticalM,
    color: tokens.colorNeutralForeground2,
  },
  fullWidthButton: {
    width: '100%',
  },
  codeDisplay: {
    backgroundColor: 'color-mix(in srgb, var(--colorNeutralBackground1) 52%, transparent)',
    border: `${tokens.strokeWidthThin} solid color-mix(in srgb, var(--colorBrandBackground) 58%, transparent)`,
    borderRadius: tokens.borderRadiusLarge,
    padding: tokens.spacingVerticalL,
    textAlign: 'center',
    boxShadow: tokens.shadow4,
  },
  userCode: {
    fontSize: tokens.fontSizeHero800,
    fontFamily: tokens.fontFamilyMonospace,
    fontWeight: tokens.fontWeightBold,
    letterSpacing: 0,
  },
  waitingText: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: tokens.spacingHorizontalS,
    color: tokens.colorNeutralForeground2,
  },
  providerCard: {
    width: '100%',
    maxWidth: '520px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: tokens.spacingVerticalM,
    padding: `clamp(${tokens.spacingVerticalXL}, 4vw, 48px)`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: 'color-mix(in srgb, var(--colorNeutralBackground1) 75%, transparent)',
    border: `${tokens.strokeWidthThin} solid color-mix(in srgb, var(--colorNeutralStroke1) 50%, transparent)`,
    boxShadow: tokens.shadow16,
    backdropFilter: 'blur(28px)',
    WebkitBackdropFilter: 'blur(28px)',
    '@media (max-width: 900px)': {
      padding: tokens.spacingVerticalL,
    },
  },
  providerHeader: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
    textAlign: 'left',
  },
  providerBadge: {
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase200,
    letterSpacing: 0,
    fontWeight: tokens.fontWeightSemibold,
    textTransform: 'uppercase',
  },
  providerButtonList: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
  },
  providerButtonContent: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXL,
    width: '100%',
  },
  providerButtonText: {
    flexGrow: 1,
    textAlign: 'left',
    color: tokens.colorNeutralForeground1,
  },
  providerSoonTag: {
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusSmall,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
  },
  providerIcon: {
    width: '28px',
    height: '28px',
    objectFit: 'contain',
  },
  providerIconPanel: {
    // No framed square behind the logo — the icon sits directly on the list item.
    width: '36px',
    height: '32px',
    display: 'grid',
    placeItems: 'center',
    flexShrink: 0,
  },
  actionButton: {
    width: '100%',
    minHeight: '62px',
    justifyContent: 'flex-start',
    columnGap: tokens.spacingHorizontalL,
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalL,
  },
  providerButton: {
    backgroundColor: 'color-mix(in srgb, var(--colorNeutralBackground1) 50%, transparent)',
    color: tokens.colorNeutralForeground1,
    border: `${tokens.strokeWidthThin} solid color-mix(in srgb, var(--colorNeutralStroke1) 50%, transparent)`,
    boxShadow: tokens.shadow2,
    backdropFilter: 'blur(10px)',
    transition: 'background-color 0.2s',
    '&:hover': {
      backgroundColor: 'color-mix(in srgb, var(--colorNeutralBackground1Hover) 80%, transparent)',
      color: tokens.colorNeutralForeground1,
    },
    '&:disabled': {
      backgroundColor: 'color-mix(in srgb, var(--colorNeutralBackground1) 30%, transparent)',
      border: `${tokens.strokeWidthThin} solid color-mix(in srgb, var(--colorNeutralStroke1) 30%, transparent)`,
      color: tokens.colorNeutralForegroundDisabled,
      opacity: 1,
    },
  },
  credentialForm: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
    width: '100%',
    maxWidth: '560px',
  },
  maskedTextarea: {
    // Chromium supports password-style masking for multiline credential
    // blobs while preserving paste and vertical resize behavior.
    WebkitTextSecurity: 'disc',
    minHeight: '96px',
  },
  manualTokenInstructions: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalM,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: 'color-mix(in srgb, var(--colorNeutralBackground1) 52%, transparent)',
    border: `${tokens.strokeWidthThin} solid color-mix(in srgb, var(--colorNeutralStroke1) 42%, transparent)`,
    color: tokens.colorNeutralForeground2,
    backdropFilter: 'blur(12px)',
  },
  manualTokenList: {
    margin: 0,
    paddingLeft: tokens.spacingHorizontalXL,
    display: 'grid',
    gap: tokens.spacingVerticalXS,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
  },
  manualTokenNote: {
    color: tokens.colorNeutralForeground3,
  },
  credentialActions: {
    display: 'flex',
    gap: tokens.spacingHorizontalS,
    justifyContent: 'space-between',
    flexWrap: 'wrap',
  },
  credentialStatus: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    flexWrap: 'wrap',
  },
  setupNotes: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
    padding: tokens.spacingVerticalM,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: 'color-mix(in srgb, var(--colorNeutralBackground1) 52%, transparent)',
    border: `${tokens.strokeWidthThin} solid color-mix(in srgb, var(--colorNeutralStroke1) 42%, transparent)`,
    color: tokens.colorNeutralForeground2,
    textAlign: 'left',
  },
  setupNotesList: {
    margin: 0,
    paddingLeft: tokens.spacingHorizontalXL,
    display: 'grid',
    gap: tokens.spacingVerticalXS,
  },
  inlineError: {
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorPaletteRedBackground1,
    color: tokens.colorPaletteRedForeground1,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorPaletteRedBorder1}`,
    textAlign: 'left',
  },
  inlineSuccess: {
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorPaletteGreenBackground1,
    color: tokens.colorPaletteGreenForeground1,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorPaletteGreenBorder1}`,
    textAlign: 'left',
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXS,
  },
  inlineInfo: {
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: 'color-mix(in srgb, var(--colorNeutralBackground1) 52%, transparent)',
    color: tokens.colorNeutralForeground2,
    border: `${tokens.strokeWidthThin} solid color-mix(in srgb, var(--colorNeutralStroke1) 42%, transparent)`,
    textAlign: 'left',
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXS,
  },
  tidalButton: {
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    color: tokens.colorNeutralForeground1,
    border: `${tokens.strokeWidthThin} solid rgba(255, 255, 255, 0.12)`,
    boxShadow: 'none',
    '&:hover': { backgroundColor: 'rgba(255, 255, 255, 0.08)', color: tokens.colorNeutralForeground1 },
  },
  appleButton: {
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
  },
  amazonButton: {
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
  },
  spotifyButton: {
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
  },
  youtubeButton: {
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
  },
  deezerButton: {
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
  },
  skipButton: {
    alignSelf: 'center',
    minHeight: '44px',
    color: tokens.colorBrandForegroundLink,
    fontWeight: tokens.fontWeightSemibold,
  },
  panelFooter: {
    borderTop: `${tokens.strokeWidthThin} solid rgba(255, 255, 255, 0.12)`,
    paddingTop: tokens.spacingVerticalM,
    display: 'flex',
    justifyContent: 'center',
  },
});

const getAppleCredentialValidationError = (
  mediaUserToken: string,
  appleId: string,
  applePassword: string,
  hasStoredMediaUserToken: boolean,
): string | null => {
  const hasAppleId = Boolean(appleId.trim());
  const hasApplePassword = Boolean(applePassword.trim());

  if (hasAppleId !== hasApplePassword) {
    return "Enter both the Apple ID and Apple ID password to authenticate the decryption wrapper.";
  }

  if (!mediaUserToken.trim() && !hasStoredMediaUserToken && !(hasAppleId && hasApplePassword)) {
    return "Paste the media-user-token from music.apple.com before connecting Apple Music.";
  }

  return null;
};

type AuthNotice = {
  tone: "success" | "error" | "info";
  title: string;
  description?: string;
};

const Auth = () => {
  const styles = useStyles();
  const queryClient = useQueryClient();
  const [connecting, setConnecting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [userCode, setUserCode] = useState<string | null>(null);
  const [verificationUrl, setVerificationUrl] = useState<string | null>(null);
  const [authStatus, setAuthStatus] = useState<AuthStatusContract | null>(null);
  const [manualProvider, setManualProvider] = useState<string | null>(null);
  const [streamingProviders, setStreamingProviders] = useState<StreamingProviderStatus[]>([]);
  const [providersLoading, setProvidersLoading] = useState(true);
  const [providersError, setProvidersError] = useState<string | null>(null);
  const [credentialValues, setCredentialValues] = useState<Record<string, string>>({});
  const [credentialError, setCredentialError] = useState<string | null>(null);
  const [authNotice, setAuthNotice] = useState<AuthNotice | null>(null);
  const [appleMediaUserToken, setAppleMediaUserToken] = useState("");
  const [appleWrapperAppleId, setAppleWrapperAppleId] = useState("");
  const [appleWrapperApplePassword, setAppleWrapperApplePassword] = useState("");
  const [savingCredentials, setSavingCredentials] = useState(false);
  const [wrapperLoginActive, setWrapperLoginActive] = useState(false);
  const [wrapperStatus, setWrapperStatus] = useState<{ status: string; message: string }>({ status: "idle", message: "" });
  const [wrapper2faCode, setWrapper2faCode] = useState("");
  const [submitting2fa, setSubmitting2fa] = useState(false);
  const wrapperPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const refreshPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const devicePollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);
  const navigate = useNavigate();
  const location = useLocation();
  const authNavigationState = location.state as {
    mode?: "add-provider";
    from?: { pathname?: string; search?: string; hash?: string };
  } | null;
  const isAddingProvider = authNavigationState?.mode === "add-provider";
  const { toast } = useToast();
  const { theme, setTheme, setBrandKeyColor } = useTheme();
  const { setArtwork, colors, isDarkMode } = useUltraBlurContext();

  const isLikelyNavigationAbort = (error: any) => {
    const failedFetch = String(error?.message || '').includes('Failed to fetch');
    return failedFetch && document.visibilityState !== 'visible';
  };

  const isConnectedStatus = useCallback((status?: AuthStatusContract | null) => {
    return Boolean(status?.connected) && !status?.refreshTokenExpired;
  }, []);

  const navigateAfterAuth = useCallback(() => {
    const from = authNavigationState?.from;
    const pathname = typeof from?.pathname === "string" ? from.pathname : "/";

    if (!pathname.startsWith("/") || pathname === "/auth") {
      navigate("/", { replace: true });
      return;
    }

    const search = typeof from?.search === "string" ? from.search : "";
    const hash = typeof from?.hash === "string" ? from.hash : "";
    navigate(`${pathname}${search}${hash}`, { replace: true });
  }, [authNavigationState, navigate]);

  const refreshProviderAuthStatusCache = useCallback((status: AuthStatusContract) => {
    queryClient.setQueryData(["providerAuthStatus"], status);
    void queryClient.invalidateQueries({ queryKey: ["providerAuthStatus"] });
  }, [queryClient]);

  const loadStreamingProviders = useCallback(async () => {
    setProvidersLoading(true);
    setProvidersError(null);
    try {
      const registry = await api.getStreamingProviders();
      if (!isMountedRef.current) return;
      setStreamingProviders(registry.providers);
    } catch (error: any) {
      if (!isMountedRef.current) return;
      setProvidersError(error?.message || "Could not load the registered streaming providers.");
    } finally {
      if (isMountedRef.current) setProvidersLoading(false);
    }
  }, []);

  // Clear artwork and brand color on auth page (use logo colors)
  useEffect(() => {
    setArtwork(undefined);
    setBrandKeyColor(null);
  }, [setArtwork, setBrandKeyColor]);

  useEffect(() => {
    void loadStreamingProviders();
  }, [loadStreamingProviders]);

  useEffect(() => {
    const checkExistingConnection = async () => {
      try {
        const status = await api.getAuthStatus();

        if (!isMountedRef.current) {
          return;
        }

        setAuthStatus(status);

        if (isConnectedStatus(status)) {
          // No auto-redirect when already connected — keep this page reachable so
          // more providers can be added (Apple Music, Spotify, …) without being
          // bounced straight back to the library.
          refreshProviderAuthStatusCache(status);
        }

        if (status?.refreshing) {
          setRefreshing(true);
          startRefreshPolling();
        } else {
          setRefreshing(false);
        }
      } catch (error) {
        if (!isMountedRef.current) {
          return;
        }
        if (!isLikelyNavigationAbort(error)) {
          console.error('Error checking connection:', error);
        }
      }
    };

    checkExistingConnection();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnectedStatus, navigateAfterAuth, refreshProviderAuthStatusCache]);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      if (refreshPollRef.current) {
        clearInterval(refreshPollRef.current);
        refreshPollRef.current = null;
      }
      if (devicePollTimeoutRef.current) {
        clearTimeout(devicePollTimeoutRef.current);
        devicePollTimeoutRef.current = null;
      }
      if (wrapperPollRef.current) {
        clearInterval(wrapperPollRef.current);
        wrapperPollRef.current = null;
      }
    };
  }, []);

  const startRefreshPolling = () => {
    if (refreshPollRef.current) {
      clearInterval(refreshPollRef.current);
    }

    refreshPollRef.current = setInterval(async () => {
      try {
        const status = await api.getAuthStatus();

        if (!isMountedRef.current) {
          return;
        }

        setAuthStatus(status);

        if (isConnectedStatus(status)) {
          if (refreshPollRef.current) {
            clearInterval(refreshPollRef.current);
            refreshPollRef.current = null;
          }
          setRefreshing(false);
          refreshProviderAuthStatusCache(status);
          navigateAfterAuth();
          return;
        }
        setRefreshing(Boolean(status?.refreshing));
        if (!status?.refreshing) {
          if (refreshPollRef.current) {
            clearInterval(refreshPollRef.current);
            refreshPollRef.current = null;
          }
        }
      } catch (error) {
        if (!isMountedRef.current) {
          return;
        }
        if (!isLikelyNavigationAbort(error)) {
          console.error('Error polling auth status:', error);
        }
        if (refreshPollRef.current) {
          clearInterval(refreshPollRef.current);
          refreshPollRef.current = null;
        }
        setRefreshing(false);
      }
    }, 3000);
  };

  const openAuthPopupWindow = () => {
    let popup: Window | null = null;

    try {
      popup = window.open("", "_blank", "popup=yes,width=520,height=720");
    } catch {
      popup = null;
    }

    if (!popup) {
      return null;
    }

    try {
      popup.document.title = "Discogenius TIDAL Login";
      popup.document.body.innerHTML = `
        <div style="font-family: sans-serif; display: flex; min-height: 100vh; margin: 0; align-items: center; justify-content: center; background: #0b0d10; color: #f5f7fa;">
          <div style="max-width: 320px; text-align: center; line-height: 1.5;">
            <h1 style="font-size: 20px; margin: 0 0 12px;">Opening TIDAL</h1>
            <p style="margin: 0; color: #c7ccd3;">Discogenius is requesting a device code and will redirect you automatically.</p>
          </div>
        </div>
      `;
      popup.opener = null;
    } catch {
      // Best effort only. The popup still exists and can be navigated.
    }

    return popup;
  };

  const openVerificationWindow = (url: string, existingWindow?: Window | null) => {
    if (existingWindow && !existingWindow.closed) {
      try {
        existingWindow.location.replace(url);
        existingWindow.focus();
        return existingWindow;
      } catch {
        // Fall through to a new popup if the existing handle can no longer be used.
      }
    }

    let popup: Window | null = null;
    try {
      popup = window.open(url, "_blank", "noopener,noreferrer");
    } catch {
      popup = null;
    }

    return popup;
  };

  const connectTidal = async () => {
    if (authStatus && !authStatus.canAuthenticate) {
      setAuthNotice({
        tone: "info",
        title: "Live login disabled",
        description: authStatus.message || "Provider auth bypass mode is active.",
      });
      toast({
        title: "Live login disabled",
        description: authStatus.message || "Provider auth bypass mode is active.",
        variant: "destructive",
      });
      if (authStatus.canAccessShell && !isAddingProvider) {
        navigateAfterAuth();
      }
      return;
    }

    if (refreshPollRef.current) {
      clearInterval(refreshPollRef.current);
      refreshPollRef.current = null;
    }
    if (devicePollTimeoutRef.current) {
      clearTimeout(devicePollTimeoutRef.current);
      devicePollTimeoutRef.current = null;
    }
    setConnecting(true);
    setRefreshing(false);
    setUserCode(null);
    setVerificationUrl(null);
    let authWindow = openAuthPopupWindow();
    try {
      const loginData: any = await api.startDeviceLogin("tidal");

      if (!isMountedRef.current) {
        if (authWindow && !authWindow.closed) {
          authWindow.close();
        }
        return;
      }

      // Debug removed

      // Handle already logged in case
      if (loginData.alreadyLoggedIn) {
        setConnecting(false);
        if (authWindow && !authWindow.closed) {
          authWindow.close();
        }
        const status = await api.getAuthStatus();
        setAuthStatus(status);
        refreshProviderAuthStatusCache(status);
        void loadStreamingProviders();
        setAuthNotice({
          tone: "success",
          title: "TIDAL already connected",
          description: "You are already logged in to TIDAL.",
        });
        if (!isAddingProvider) {
          navigateAfterAuth();
        }
        return;
      }

      const { userCode, url, expiresIn, interval } = loginData;

      if (!userCode || !url || !expiresIn || !interval) {
        throw new Error('Invalid device login response from TIDAL.');
      }

      const expiresInSeconds = Number(expiresIn);
      const intervalSeconds = Number(interval);
      if (!Number.isFinite(expiresInSeconds) || !Number.isFinite(intervalSeconds)) {
        throw new Error('Invalid device login timing values from TIDAL.');
      }

      // Debug removed

      setUserCode(userCode);
      setVerificationUrl(url);

      // Open verification URL in a window spawned from the user gesture.
      authWindow = openVerificationWindow(url, authWindow);

      // Poll for completion
      const pollInterval = Math.max(1, intervalSeconds) * 1000;
      const maxAttempts = Math.floor(expiresInSeconds / Math.max(1, intervalSeconds));
      let attempts = 0;

      const checkAuth = async () => {
        if (!isMountedRef.current) {
          return;
        }

        if (attempts >= maxAttempts) {
          devicePollTimeoutRef.current = null;
          setConnecting(false);
          setUserCode(null);
          setVerificationUrl(null);
          setAuthNotice({
            tone: "error",
            title: "Authorization expired",
            description: "Please try connecting again.",
          });
          toast({
            title: "Authorization Expired",
            description: "Please try connecting again",
            variant: "destructive",
          });
          return;
        }

        attempts++;

        try {
          const authData: any = await api.checkDeviceLogin("tidal");

          if (!isMountedRef.current) {
            return;
          }

          // Debug removed

          if (authData.logged_in) {
            devicePollTimeoutRef.current = null;
            setConnecting(false);
            setUserCode(null);
            setVerificationUrl(null);
            const status = await api.getAuthStatus();
            setAuthStatus(status);
            refreshProviderAuthStatusCache(status);
            void loadStreamingProviders();
            setAuthNotice({
              tone: "success",
              title: "TIDAL connected",
              description: `Welcome ${authData.user?.username || "user"}!`,
            });
            if (!isAddingProvider) {
              navigateAfterAuth();
            }
          } else {
            // Continue polling
            devicePollTimeoutRef.current = setTimeout(() => {
              void checkAuth();
            }, pollInterval);
          }
        } catch (error) {
          if (!isMountedRef.current) {
            return;
          }
          console.error('Auth check error:', error);
          devicePollTimeoutRef.current = setTimeout(() => {
            void checkAuth();
          }, pollInterval);
        }
      };

      // Start polling after a short delay
      devicePollTimeoutRef.current = setTimeout(() => {
        void checkAuth();
      }, pollInterval);

    } catch (error: any) {
      console.error('Connect error:', error);
      if (authWindow && !authWindow.closed) {
        authWindow.close();
      }
      if (!isMountedRef.current) {
        return;
      }
      setConnecting(false);
      setUserCode(null);
      setVerificationUrl(null);
      setAuthNotice({
        tone: "error",
        title: "TIDAL connection failed",
        description: error.message || "Could not start TIDAL authorization.",
      });
      toast({
        title: "Connection Failed",
        description: error.message,
        variant: "destructive",
      });
    }
  };

  const startWrapperPolling = () => {
    if (wrapperPollRef.current) {
      clearInterval(wrapperPollRef.current);
    }

    wrapperPollRef.current = setInterval(async () => {
      try {
        const data = await api.getAppleWrapperStatus();
        if (!isMountedRef.current) return;
        setWrapperStatus(data);

        if (data.status === "success") {
          clearInterval(wrapperPollRef.current!);
          wrapperPollRef.current = null;
          setAuthNotice({
            tone: "success",
            title: "Apple Music wrapper authenticated",
            description: data.message || "Decryption wrapper is ready for lossless and Atmos downloads.",
          });
          void loadStreamingProviders();
          setTimeout(() => {
            setWrapperLoginActive(false);
            setManualProvider(null);
            if (!isAddingProvider) {
              navigateAfterAuth();
            }
          }, 1500);
        } else if (data.status === "failed") {
          clearInterval(wrapperPollRef.current!);
          wrapperPollRef.current = null;
          setWrapperLoginActive(false);
          setAuthNotice({
            tone: "error",
            title: "Apple wrapper login failed",
            description: data.message || "Could not authenticate the decryption wrapper.",
          });
          setCredentialError(data.message || "Could not authenticate the decryption wrapper.");
          toast({
            title: "Wrapper Login Failed",
            description: data.message,
            variant: "destructive",
          });
        }
      } catch (error) {
        console.error("Error polling wrapper status:", error);
      }
    }, 2000);
  };

  const submitApple2fa = async () => {
    if (!wrapper2faCode.trim() || wrapper2faCode.trim().length !== 6) {
      toast({
        title: "Invalid code",
        description: "Please enter a valid 6-digit verification code.",
        variant: "destructive",
      });
      return;
    }
    setSubmitting2fa(true);
    try {
      await api.submitAppleWrapper2fa(wrapper2faCode.trim());
      setWrapper2faCode("");
      // Optimistically show loading state so the UI updates immediately
      setWrapperStatus({ status: "logging_in", message: "Verifying 2FA code with Apple..." });
      toast({
        title: "Code submitted",
        description: "Authenticating with Apple...",
      });
    } catch (error: any) {
      toast({
        title: "Failed to submit code",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setSubmitting2fa(false);
    }
  };

  const selectedProvider = streamingProviders.find((provider) => provider.id === manualProvider) ?? null;

  const openCredentialProvider = (provider: StreamingProviderStatus) => {
    setCredentialError(null);
    setAuthNotice(null);
    setCredentialValues(Object.fromEntries(
      (provider.manifest?.auth.credentialFields ?? []).map((field) => [field.key, ""]),
    ));
    setManualProvider(provider.id);
  };

  const saveGenericProviderCredentials = async () => {
    if (!selectedProvider || selectedProvider.id === "apple-music") return;

    const fields = selectedProvider.manifest?.auth.credentialFields ?? [];
    const missing = fields.filter((field) => field.required && !credentialValues[field.key]?.trim());
    if (missing.length > 0) {
      const message = `Enter ${missing.map((field) => field.label).join(", ")} before connecting.`;
      setCredentialError(message);
      setAuthNotice({ tone: "error", title: "Missing credentials", description: message });
      return;
    }

    setSavingCredentials(true);
    setCredentialError(null);
    try {
      const credentials = Object.fromEntries(
        fields.map((field) => [field.key, credentialValues[field.key]?.trim() ?? ""]),
      );
      const result = await api.saveProviderCredentials(selectedProvider.id, credentials);
      const connected = Boolean(result.status?.connected);
      setStreamingProviders((providers) => providers.map((provider) => (
        provider.id === selectedProvider.id
          ? { ...provider, authenticated: connected }
          : provider
      )));

      const aggregateStatus = await api.getAuthStatus().catch(() => null);
      if (aggregateStatus) {
        setAuthStatus(aggregateStatus);
        refreshProviderAuthStatusCache(aggregateStatus);
      }
      void loadStreamingProviders();

      const notice: AuthNotice = connected
        ? {
            tone: "success",
            title: `${selectedProvider.name} connected`,
            description: result.status?.message || "Credentials were saved and this provider is ready to use.",
          }
        : {
            tone: "error",
            title: `${selectedProvider.name} credentials were not accepted`,
            description: result.status?.message || "Credentials were saved, but the provider is still not connected. Check the values and try again.",
          };

      setAuthNotice(notice);
      if (!connected) {
        setCredentialError(notice.description || notice.title);
        toast({
          title: notice.title,
          description: notice.description,
          variant: "destructive",
        });
        return;
      }

      setCredentialValues({});
      setManualProvider(null);
    } catch (error: any) {
      const message = error?.message || `Could not save ${selectedProvider.name} credentials.`;
      setCredentialError(message);
      setAuthNotice({
        tone: "error",
        title: `${selectedProvider.name} connection failed`,
        description: message,
      });
      toast({
        title: `${selectedProvider.name} connection failed`,
        description: message,
        variant: "destructive",
      });
    } finally {
      setSavingCredentials(false);
    }
  };

  const saveAppleCredentials = async () => {
    const mediaUserToken = appleMediaUserToken.trim();
    const appleId = appleWrapperAppleId.trim();
    const applePassword = appleWrapperApplePassword.trim();
    const hasAppleId = Boolean(appleId);
    const hasApplePassword = Boolean(applePassword);
    const hasStoredMediaUserToken = Boolean(selectedProvider?.authenticated);
    const validationError = getAppleCredentialValidationError(
      mediaUserToken,
      appleId,
      applePassword,
      hasStoredMediaUserToken,
    );

    if (validationError) {
      setCredentialError(validationError);
      return;
    }

    setCredentialError(null);
    setSavingCredentials(true);
    try {
      if (mediaUserToken) {
        const result: any = await api.saveProviderCredentials("apple-music", {
          developerToken: "",
          mediaUserToken,
          storefront: "",
        });
        const status = result?.status || await api.getAuthStatus();
        setAuthStatus(status);
        refreshProviderAuthStatusCache(status);
      }

      // Wrapper decryption login is separate from catalog credentials: the
      // Apple ID + password go straight to the wrapper sidecar and are never
      // stored by Discogenius.
      if (hasAppleId && hasApplePassword) {
        await api.runAppleWrapperLogin(appleId, applePassword);
        setAppleWrapperApplePassword("");
        setWrapperLoginActive(true);
        setWrapperStatus({ status: "logging_in", message: "Login request sent to the decryption wrapper..." });
        startWrapperPolling();
      } else {
        setAuthNotice({
          tone: "success",
          title: mediaUserToken ? "Apple Music connected" : "Apple Music already connected",
          description: "Catalog access and import sources are available.",
        });
        setManualProvider(null);
        void loadStreamingProviders();
        if (!isAddingProvider) {
          navigateAfterAuth();
        }
      }
    } catch (error: any) {
      const message = error?.message || "Could not save Apple Music credentials.";
      setCredentialError(message);
      setAuthNotice({
        tone: "error",
        title: "Apple Music connection failed",
        description: message,
      });
      toast({
        title: "Apple Music connection failed",
        description: message,
        variant: "destructive",
      });
    } finally {
      setSavingCredentials(false);
    }
  };

  const selectProvider = (provider: StreamingProviderStatus) => {
    setAuthNotice(null);
    if (provider.id === "tidal") {
      void connectTidal();
      return;
    }
    if (provider.id === "apple-music") {
      setCredentialError(null);
      setManualProvider(provider.id);
      return;
    }
    if (provider.manifest?.auth.credentialFields?.length || provider.management.canAuthenticate) {
      openCredentialProvider(provider);
      return;
    }
    setAuthNotice({
      tone: "error",
      title: `${provider.name} cannot be connected here`,
      description: "This provider does not expose an app-managed connection method.",
    });
  };

  const selectedCredentialFields = selectedProvider?.manifest?.auth.credentialFields ?? [];
  const selectedSetupInstructions = selectedProvider?.manifest?.auth.setupInstructions ?? [];
  const selectedSetupIntro = selectedProvider?.manifest?.auth.setupIntro?.trim() || null;
  const selectedSetupNotes = [...new Set(
    (selectedProvider?.manifest?.downloadBackends ?? []).flatMap((backend) => (
      backend.setupNote ? [backend.setupNote] : []
    )),
  )];

  const authNoticeClassName = authNotice?.tone === "success"
    ? styles.inlineSuccess
    : authNotice?.tone === "error"
      ? styles.inlineError
      : styles.inlineInfo;

  const authNoticeBanner = authNotice ? (
    <div
      className={authNoticeClassName}
      role={authNotice.tone === "error" ? "alert" : "status"}
      data-testid="provider-auth-notice"
    >
      <Text weight="semibold" size={200}>{authNotice.title}</Text>
      {authNotice.description ? <Text size={200}>{authNotice.description}</Text> : null}
    </div>
  ) : null;

  return (
    <>
      <UltraBlurBackground colors={colors} isDarkMode={isDarkMode} />
      <div className={styles.container}>
        <div className={styles.themeToggle}>
          <Button
            appearance={theme === "light" ? "primary" : "subtle"}
            icon={<WeatherSunny24 />}
            onClick={() => setTheme("light")}
            size="small"
          />
          <Button
            appearance={theme === "dark" ? "primary" : "subtle"}
            icon={<WeatherMoon24 />}
            onClick={() => setTheme("dark")}
            size="small"
          />
          <Button
            appearance={theme === "system" ? "primary" : "subtle"}
            icon={<DesktopMac24 />}
            onClick={() => setTheme("system")}
            size="small"
          />
        </div>

        <div className={styles.card}>
          <div className={styles.content}>
            <div className={styles.leftColumn}>
              <div className={styles.logoContainer}>
                <div aria-hidden="true" className={styles.logoGlow} />
                <img src={logo} alt="Discogenius" className={styles.logo} />
              </div>
              <div className={styles.leftCopy}>
                <Text as="h1" className={styles.brandTitle}>
                  {isAddingProvider ? "Add a streaming provider" : "Welcome to Discogenius"}
                </Text>
                <Body1 className={styles.leftBody}>
                  {isAddingProvider
                    ? "Connect another service, then return to Settings to set its download priority."
                    : "Connect a streaming service to enable downloading, or skip for now and add your wanted artists first."}
                </Body1>
              </div>
            </div>

            <div className={styles.rightColumn}>
              {!connecting && !userCode && refreshing && (
                <div className={styles.infoBox}>
                  <div className={styles.stateHeader}>
                    <Title3 as="h1">Refreshing TIDAL session</Title3>
                    <Body1 className={styles.stateBody}>
                      Restoring your provider session before continuing.
                    </Body1>
                  </div>
                  <div className={styles.waitingText}>
                    <Spinner size="tiny" />
                    <Text size={200}>Checking token status...</Text>
                  </div>
                </div>
              )}

              {!connecting && !userCode && !refreshing && (
                <div className={styles.providerCard} data-test="dsp-button-list">
                  {manualProvider === "apple-music" ? (
                    wrapperLoginActive ? (
                      <div className={styles.credentialForm}>
                        <div className={styles.providerHeader}>
                          <Text weight="semibold" className={styles.providerBadge}>Apple ID Verification</Text>
                          <Body1 className={styles.stateBody}>
                            {wrapperStatus.message || "Authenticating with Apple..."}
                          </Body1>
                        </div>

                        {wrapperStatus.status === "waiting_for_2fa" ? (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginTop: '12px' }}>
                            <Field label="Verification Code" hint="Enter the 2FA code sent to your Apple device.">
                              <Input
                                value={wrapper2faCode}
                                maxLength={6}
                                placeholder="123456"
                                onChange={(_, data) => setWrapper2faCode(data.value)}
                                disabled={submitting2fa}
                              />
                            </Field>
                            <Button appearance="primary" onClick={submitApple2fa} disabled={submitting2fa}>
                              {submitting2fa ? "Submitting..." : "Submit Code"}
                            </Button>
                          </div>
                        ) : (
                          <div className={styles.waitingText} style={{ marginTop: '20px' }}>
                            <Spinner size="tiny" />
                            <Text size={200}>{wrapperStatus.message || "Checking status..."}</Text>
                          </div>
                        )}

                        <div className={styles.credentialActions} style={{ marginTop: '20px' }}>
                          <Button appearance="subtle" onClick={() => {
                            if (wrapperPollRef.current) {
                              clearInterval(wrapperPollRef.current);
                              wrapperPollRef.current = null;
                            }
                            setWrapperLoginActive(false);
                          }} disabled={submitting2fa}>
                            Cancel
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className={styles.credentialForm}>
                      <div className={styles.providerHeader}>
                        <Text weight="semibold" className={styles.providerBadge}>Apple Music credentials</Text>
                        <Body1 className={styles.stateBody}>
                          {selectedProvider?.authenticated
                            ? "A media-user-token is already stored. Leave the token field blank to keep it, or paste a replacement. Apple ID and password can be used on their own to re-authenticate the decryption wrapper."
                            : "Paste the media-user-token from music.apple.com. Discogenius stores it under the Apple Music provider config and syncs it into the downloader config."}
                        </Body1>
                      </div>
                      <div className={styles.manualTokenInstructions}>
                        <Text weight="semibold">Manual media-user-token setup</Text>
                        <ol className={styles.manualTokenList}>
                          <li>Open music.apple.com and sign in with the Apple Music account.</li>
                          <li>Open browser developer tools, then Application or Storage.</li>
                          <li>Open Cookies for music.apple.com and copy the value named media-user-token.</li>
                          <li>Paste that value below. Reconnect when Apple marks the token expired.</li>
                        </ol>
                        <Text size={200} className={styles.manualTokenNote}>
                          Automatic Apple sign-in requires a MusicKit developer token/JWT. Until that is configured, the signed-in browser cookie is the supported user-token source.
                        </Text>
                        <Button
                          appearance="outline"
                          icon={<Open24 />}
                          onClick={() => window.open("https://music.apple.com", "_blank", "noopener,noreferrer")}
                          disabled={savingCredentials}
                        >
                          Open Apple Music
                        </Button>
                      </div>
                      <Field
                        label="Media user token"
                        required={!selectedProvider?.authenticated}
                        hint={selectedProvider?.authenticated
                          ? "A token is already stored. Leave blank to keep it, or paste a replacement."
                          : "Cookie value named media-user-token from music.apple.com."}
                      >
                        <Input
                          type="password"
                          autoComplete="off"
                          value={appleMediaUserToken}
                          onChange={(_, data) => {
                            setAppleMediaUserToken(data.value);
                            if (credentialError) setCredentialError(null);
                          }}
                          disabled={savingCredentials}
                        />
                      </Field>
                      <Field label="Apple ID" hint="Required for lossless ALAC and music video downloads. Optional for standard lossy AAC.">
                        <Input
                          value={appleWrapperAppleId}
                          placeholder="email@example.com"
                          onChange={(_, data) => {
                            setAppleWrapperAppleId(data.value);
                            if (credentialError) setCredentialError(null);
                          }}
                          disabled={savingCredentials}
                        />
                      </Field>
                      <Field label="Apple ID Password" hint="The password for your Apple ID account.">
                        <Input
                          value={appleWrapperApplePassword}
                          type="password"
                          onChange={(_, data) => {
                            setAppleWrapperApplePassword(data.value);
                            if (credentialError) setCredentialError(null);
                          }}
                          disabled={savingCredentials}
                        />
                      </Field>
                      {credentialError ? (
                        <div className={styles.inlineError} role="alert">
                          <Text size={200}>{credentialError}</Text>
                        </div>
                      ) : null}
                      <div className={styles.credentialActions}>
                        <Button appearance="subtle" onClick={() => {
                          setCredentialError(null);
                          setManualProvider(null);
                        }} disabled={savingCredentials}>
                          Back
                        </Button>
                        <Button appearance="primary" onClick={saveAppleCredentials} disabled={savingCredentials}>
                          {savingCredentials ? "Connecting..." : "Connect Apple Music"}
                        </Button>
                      </div>
                    </div>
                    )
                  ) : selectedProvider ? (
                    <div className={styles.credentialForm} data-testid="provider-credential-form">
                      <div className={styles.providerHeader}>
                        <div className={styles.credentialStatus}>
                          <ProviderMark provider={selectedProvider.id} size={28} />
                          <Text weight="semibold">{selectedProvider.manifest?.displayName || selectedProvider.name}</Text>
                          <Badge
                            appearance="tint"
                            color={selectedProvider.authenticated ? "success" : "subtle"}
                          >
                            {selectedProvider.authenticated ? "Connected" : "Not connected"}
                          </Badge>
                        </div>
                        <Body1 className={styles.stateBody}>
                          {selectedSetupIntro
                            ?? (selectedSetupInstructions.length > 0
                              ? "Follow the steps below, then fill in the credential fields. Secret values stay masked and are stored only in this provider's config directory."
                              : "Enter the provider credentials below. Secret values stay masked and are stored in the provider's own configuration directory.")}
                        </Body1>
                      </div>

                      {selectedSetupInstructions.length > 0 ? (
                        <div className={styles.manualTokenInstructions}>
                          <Text weight="semibold">How to get these credentials</Text>
                          <ol className={styles.manualTokenList}>
                            {selectedSetupInstructions.map((step) => (
                              <li key={step}>{step}</li>
                            ))}
                          </ol>
                        </div>
                      ) : null}

                      {selectedSetupNotes.length > 0 ? (
                        <div className={styles.setupNotes}>
                          <Text weight="semibold" size={200}>Setup requirements</Text>
                          <ul className={styles.setupNotesList}>
                            {selectedSetupNotes.map((note) => <li key={note}><Text size={200}>{note}</Text></li>)}
                          </ul>
                        </div>
                      ) : null}

                      {selectedCredentialFields.length === 0 ? (
                        <Text size={200} className={styles.stateBody}>
                          This provider does not require credentials for public catalog access.
                        </Text>
                      ) : selectedCredentialFields.map((field) => (
                        <Field
                          key={field.key}
                          label={field.label}
                          required={field.required}
                          hint={field.helpText}
                        >
                          {field.multiline ? (
                            <Textarea
                              className={field.secret ? styles.maskedTextarea : undefined}
                              value={credentialValues[field.key] ?? ""}
                              resize="vertical"
                              disabled={savingCredentials}
                              onChange={(_, data) => {
                                setCredentialValues((values) => ({ ...values, [field.key]: data.value }));
                                if (credentialError) setCredentialError(null);
                              }}
                            />
                          ) : (
                            <Input
                              type={field.secret ? "password" : "text"}
                              value={credentialValues[field.key] ?? ""}
                              autoComplete={field.secret ? "off" : undefined}
                              disabled={savingCredentials}
                              onChange={(_, data) => {
                                setCredentialValues((values) => ({ ...values, [field.key]: data.value }));
                                if (credentialError) setCredentialError(null);
                              }}
                            />
                          )}
                        </Field>
                      ))}

                      {credentialError ? (
                        <div className={styles.inlineError} role="alert">
                          <Text size={200}>{credentialError}</Text>
                        </div>
                      ) : null}

                      <div className={styles.credentialActions}>
                        <Button
                          appearance="subtle"
                          onClick={() => {
                            setCredentialError(null);
                            setCredentialValues({});
                            setManualProvider(null);
                          }}
                          disabled={savingCredentials}
                        >
                          Back
                        </Button>
                        <Button
                          appearance="primary"
                          onClick={saveGenericProviderCredentials}
                          disabled={savingCredentials}
                        >
                          {savingCredentials ? "Saving..." : selectedProvider.authenticated ? "Update credentials" : "Save and connect"}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className={styles.providerHeader}>
                        <Text weight="semibold" className={styles.providerBadge}>Streaming service</Text>
                        <Body1 className={styles.stateBody}>
                          Choose one of the providers registered by Discogenius.
                        </Body1>
                      </div>

                      {authNoticeBanner}

                      <div className={styles.providerButtonList}>
                        {providersLoading ? (
                          <div className={styles.waitingText}>
                            <Spinner size="tiny" />
                            <Text size={200}>Loading providers...</Text>
                          </div>
                        ) : providersError ? (
                          <div className={styles.credentialForm}>
                            <div className={styles.inlineError} role="alert">
                              <Text size={200}>{providersError}</Text>
                            </div>
                            <Button appearance="outline" onClick={() => void loadStreamingProviders()}>
                              Retry
                            </Button>
                          </div>
                        ) : streamingProviders.length === 0 ? (
                          <Text size={200} className={styles.stateBody}>No streaming providers are registered.</Text>
                        ) : streamingProviders.map((provider) => (
                          <Button
                            key={provider.id}
                            appearance="outline"
                            disabled={!provider.management.canAuthenticate}
                            onClick={() => selectProvider(provider)}
                            className={mergeClasses(styles.providerButton, styles.actionButton)}
                            size="large"
                            icon={
                              <div className={styles.providerIconPanel}>
                                <ProviderMark provider={provider.id} size={28} />
                              </div>
                            }
                            iconPosition="before"
                          >
                            <div className={styles.providerButtonContent}>
                              <span className={styles.providerButtonText}>{provider.manifest?.displayName || provider.name}</span>
                              {provider.authenticated ? (
                                <Badge appearance="tint" color="success">Connected</Badge>
                              ) : provider.management.canAuthenticate ? (
                                <ArrowRight24 />
                              ) : (
                                <span className={styles.providerSoonTag}>Soon</span>
                              )}
                            </div>
                          </Button>
                        ))}
                      </div>
                    </>
                  )}

                  <div className={styles.panelFooter}>
                    <Button
                      appearance="subtle"
                      onClick={navigateAfterAuth}
                      size="large"
                      className={styles.skipButton}
                      icon={<Door24 />}
                    >
                      {isAddingProvider ? "Back to Settings" : "Skip for now"}
                    </Button>
                  </div>
                </div>
              )}

              {connecting && !userCode && (
                <div className={styles.infoBox}>
                  <div className={styles.stateHeader}>
                    <Title3 as="h1">Starting TIDAL authorization</Title3>
                    <Body1 className={styles.stateBody}>
                      Requesting a device code from TIDAL...
                    </Body1>
                  </div>
                  <div className={styles.waitingText}>
                    <Spinner size="tiny" />
                    <Text size={200}>Opening the authorization page...</Text>
                  </div>
                </div>
              )}

              {connecting && userCode && (
                <div className={styles.infoBox}>
                  <div className={styles.stateHeader}>
                    <Title3 as="h1">Authorize Discogenius</Title3>
                    <Body1 className={styles.stateBody}>
                      Visit the link below and enter this code to authorize:
                    </Body1>
                  </div>

                  <div className={styles.codeDisplay}>
                    <Text className={styles.userCode}>
                      {userCode}
                    </Text>
                  </div>

                  <Button
                    appearance="outline"
                    icon={<Open24 />}
                    onClick={() => {
                      if (verificationUrl) {
                        openVerificationWindow(verificationUrl);
                      }
                    }}
                    className={styles.fullWidthButton}
                  >
                    Open TIDAL Authorization
                  </Button>

                  <div className={styles.waitingText}>
                    <Spinner size="tiny" />
                    <Text size={200}>Waiting for authorization...</Text>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
};

export default Auth;
