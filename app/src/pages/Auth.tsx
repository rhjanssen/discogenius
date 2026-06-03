import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/services/api";
import {
  Button,
  Spinner,
  Text,
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
} from "@fluentui/react-icons";
import { useToast } from "@/hooks/useToast";
import { useTheme } from "@/providers/themeContext";
import { useUltraBlurContext } from "@/providers/UltraBlurContext";
import { UltraBlurBackground } from "@/ultrablur/UltraBlurBackground";
import type { AuthStatusContract } from "@contracts/auth";
const logo = "/assets/images/logo.png";
const tidalIcon = "/assets/images/tidal_icon.svg";
const appleIcon = "/assets/images/apple_music_icon.svg";
const amazonIcon = "/assets/images/amazon_icon.svg";
const spotifyIcon = "/assets/images/spotify_icon.svg";
const youtubeIcon = "/assets/images/youtube_icon.svg";
const deezerIcon = "/assets/images/deezer_icon.svg";

const useStyles = makeStyles({
  container: {
    minHeight: '100vh',
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
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
    width: '64%',
    aspectRatio: '1',
    borderRadius: tokens.borderRadiusCircular,
    zIndex: 0,
    transform: 'translate(-50%, -50%)',
    backgroundImage: 'radial-gradient(circle at 45% 45%, rgba(37, 222, 236, 0.62), rgba(117, 38, 245, 0.46) 34%, rgba(255, 122, 24, 0.42) 58%, transparent 74%)',
    filter: 'blur(22px) saturate(1.25)',
    opacity: 0.68,
    pointerEvents: 'none',
    '@media (max-width: 640px)': {
      filter: 'blur(18px) saturate(1.3)',
      opacity: 0.62,
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
  },
  brandTitle: {
    display: 'block',
    fontSize: 'clamp(36px, 4.8vw, 56px)',
    lineHeight: 1.08,
    letterSpacing: 0,
    fontWeight: tokens.fontWeightBold,
    marginBottom: tokens.spacingVerticalS,
  },
  leftBody: {
    display: 'block',
    color: tokens.colorNeutralForeground2,
    lineHeight: 1.7,
    maxWidth: '520px',
    marginLeft: 'auto',
    marginRight: 'auto',
  },
  rightColumn: {
    width: '100%',
    display: 'flex',
    justifyContent: 'center',
    padding: `${tokens.spacingVerticalL} 0`,
  },
  infoBox: {
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingVerticalXL,
    textAlign: 'center',
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
    backgroundColor: tokens.colorNeutralBackground2,
    border: `${tokens.strokeWidthThick} solid ${tokens.colorBrandBackground}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingVerticalL,
    textAlign: 'center',
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
    backgroundColor: 'rgba(13, 14, 26, 0.72)',
    border: `${tokens.strokeWidthThin} solid rgba(168, 131, 255, 0.32)`,
    boxShadow: '0 34px 90px rgba(0,0,0,0.36)',
    backdropFilter: 'blur(28px) saturate(1.25)',
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
    gap: tokens.spacingHorizontalL,
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
    width: '42px',
    height: '42px',
    display: 'grid',
    placeItems: 'center',
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
  },
  actionButton: {
    width: '100%',
    minHeight: '62px',
    justifyContent: 'flex-start',
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
  },
  providerButton: {
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    color: tokens.colorNeutralForeground1,
    border: `1px solid rgba(255, 255, 255, 0.12)`,
    boxShadow: 'none',
    '&:hover': {
      backgroundColor: 'rgba(255, 255, 255, 0.08)',
      color: tokens.colorNeutralForeground1,
    },
    '&:disabled': {
      backgroundColor: 'rgba(255, 255, 255, 0.035)',
      border: `1px solid rgba(255, 255, 255, 0.1)`,
      color: tokens.colorNeutralForeground2,
      opacity: 1,
    },
  },
  tidalButton: {
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    color: tokens.colorNeutralForeground1,
    border: `1px solid rgba(255, 255, 255, 0.12)`,
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
    borderTop: '1px solid rgba(255, 255, 255, 0.12)',
    paddingTop: tokens.spacingVerticalM,
    display: 'flex',
    justifyContent: 'center',
  },
});

const Auth = () => {
  const styles = useStyles();
  const queryClient = useQueryClient();
  const [connecting, setConnecting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [userCode, setUserCode] = useState<string | null>(null);
  const [verificationUrl, setVerificationUrl] = useState<string | null>(null);
  const [authStatus, setAuthStatus] = useState<AuthStatusContract | null>(null);
  const refreshPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const devicePollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);
  const navigate = useNavigate();
  const location = useLocation();
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
    const state = location.state as { from?: { pathname?: string; search?: string; hash?: string } } | null;
    const from = state?.from;
    const pathname = typeof from?.pathname === "string" ? from.pathname : "/";

    if (!pathname.startsWith("/") || pathname === "/auth") {
      navigate("/", { replace: true });
      return;
    }

    const search = typeof from?.search === "string" ? from.search : "";
    const hash = typeof from?.hash === "string" ? from.hash : "";
    navigate(`${pathname}${search}${hash}`, { replace: true });
  }, [location.state, navigate]);

  const refreshProviderAuthStatusCache = useCallback((status: AuthStatusContract) => {
    queryClient.setQueryData(["providerAuthStatus"], status);
    void queryClient.invalidateQueries({ queryKey: ["providerAuthStatus"] });
  }, [queryClient]);

  // Clear artwork and brand color on auth page (use logo colors)
  useEffect(() => {
    setArtwork(undefined);
    setBrandKeyColor(null);
  }, [setArtwork, setBrandKeyColor]);

  useEffect(() => {
    const checkExistingConnection = async () => {
      try {
        const status = await api.getAuthStatus();

        if (!isMountedRef.current) {
          return;
        }

        setAuthStatus(status);

        if (isConnectedStatus(status)) {
          refreshProviderAuthStatusCache(status);
          navigateAfterAuth();
          return;
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
      toast({
        title: "Live login disabled",
        description: authStatus.message || "Provider auth bypass mode is active.",
      });
      if (authStatus.canAccessShell) {
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
      const loginData: any = await api.startDeviceLogin();

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
        toast({
          title: "Already Connected!",
          description: "You are already logged in to TIDAL.",
        });
        refreshProviderAuthStatusCache(status);
        navigateAfterAuth();
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
          toast({
            title: "Authorization Expired",
            description: "Please try connecting again",
            variant: "destructive",
          });
          return;
        }

        attempts++;

        try {
          const authData: any = await api.checkDeviceLogin();

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
            toast({
              title: "Connected!",
              description: `Welcome ${authData.user?.username || 'user'}!`,
            });
            refreshProviderAuthStatusCache(status);
            navigateAfterAuth();
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
      toast({
        title: "Connection Failed",
        description: error.message,
        variant: "destructive",
      });
    }
  };

  const providerButtons = [{
    key: "tidal",
    name: "TIDAL",
    className: styles.tidalButton,
    logoUrl: tidalIcon,
    available: true,
    onClick: connectTidal,
  }, {
    key: "apple",
    name: "Apple Music",
    className: styles.appleButton,
    logoUrl: appleIcon,
    available: false,
  }, {
    key: "amazon", name: "Amazon Music", className: styles.amazonButton, logoUrl: amazonIcon, available: false,
  }, {
    key: "spotify", name: "Spotify", className: styles.spotifyButton, logoUrl: spotifyIcon, available: false,
  }, {
    key: "youtube", name: "YouTube Music", className: styles.youtubeButton, logoUrl: youtubeIcon, available: false,
  }, {
    key: "deezer", name: "Deezer", className: styles.deezerButton, logoUrl: deezerIcon, available: false,
  }];

  return (
    <>
      <UltraBlurBackground colors={colors} isDarkMode={isDarkMode} />
      <div className={styles.container}>
        <div className={styles.themeToggle}>
          <Button
            appearance={theme === "light" ? "primary" : "subtle"}
            icon={<WeatherSunny24Regular />}
            onClick={() => setTheme("light")}
            size="small"
          />
          <Button
            appearance={theme === "dark" ? "primary" : "subtle"}
            icon={<WeatherMoon24Regular />}
            onClick={() => setTheme("dark")}
            size="small"
          />
          <Button
            appearance={theme === "system" ? "primary" : "subtle"}
            icon={<DesktopMac24Regular />}
            onClick={() => setTheme("system")}
            size="small"
          />
        </div>

        <div className={styles.card}>
          {!connecting && !userCode && refreshing && (
            <div className={styles.infoBox}>
              <div className={styles.stateHeader}>
                <Title3>Refreshing TIDAL session</Title3>
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
            <div className={styles.content}>
              <div className={styles.leftColumn}>
                <div className={styles.logoContainer}>
                  <div aria-hidden="true" className={styles.logoGlow} />
                  <img src={logo} alt="Discogenius" className={styles.logo} />
                </div>
                <div className={styles.leftCopy}>
                  <Text as="h1" className={styles.brandTitle}>Welcome to Discogenius</Text>
                  <Body1 className={styles.leftBody}>
                    Connect a streaming service to enable downloading, or skip for now and add your wanted artists first.
                  </Body1>
                </div>
              </div>

              <div className={styles.rightColumn}>
                <div className={styles.providerCard} data-test="dsp-button-list">
                  <div className={styles.providerHeader}>
                    <Text weight="semibold" className={styles.providerBadge}>Streaming service</Text>
                  </div>

                  <div className={styles.providerButtonList}>
                    {providerButtons.map((providerButton) => (
                      <Button
                        key={providerButton.key}
                        appearance="outline"
                        disabled={!providerButton.available}
                        onClick={providerButton.available ? providerButton.onClick : undefined}
                        className={mergeClasses(styles.providerButton, providerButton.className, styles.actionButton)}
                        size="large"
                        icon={
                          <div className={styles.providerIconPanel}>
                            <img src={providerButton.logoUrl} alt="" className={styles.providerIcon} />
                          </div>
                        }
                        iconPosition="before"
                      >
                        <div className={styles.providerButtonContent}>
                          <span className={styles.providerButtonText}>{providerButton.name}</span>
                          {providerButton.available ? <ArrowRight24Regular /> : <span className={styles.providerSoonTag}>Soon</span>}
                        </div>
                      </Button>
                    ))}
                  </div>

                  <div className={styles.panelFooter}>
                    <Button
                      appearance="subtle"
                      onClick={navigateAfterAuth}
                      size="large"
                      className={styles.skipButton}
                      icon={<Door24Regular />}
                    >
                      Skip for now
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {connecting && !userCode && (
            <div className={styles.infoBox}>
              <div className={styles.stateHeader}>
                <Title3>Starting TIDAL authorization</Title3>
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
                <Title3>Authorize Discogenius</Title3>
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
                icon={<Open24Regular />}
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
    </>
  );
};

export default Auth;
