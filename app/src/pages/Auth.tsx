import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/services/api";
import {
  Button,
  Spinner,
  Text,
  Title2,
  Title3,
  Body1,
  Link,
  makeStyles,
  tokens,
  shorthands,
} from "@fluentui/react-components";
import {
  Door24Regular,
  Open24Regular,
  WeatherMoon24Regular,
  WeatherSunny24Regular,
  DesktopMac24Regular,
} from "@fluentui/react-icons";
import { useToast } from "@/hooks/useToast";
import { useTheme } from "@/providers/themeContext";
import { useUltraBlurContext } from "@/providers/UltraBlurContext";
import { UltraBlurBackground } from "@/ultrablur/UltraBlurBackground";
const logo = "/assets/images/logo.png";
const tidalIcon = "/assets/images/tidal_icon.svg";

const useStyles = makeStyles({
  container: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: tokens.spacingVerticalL,
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
    maxWidth: '500px',
    paddingTop: tokens.spacingVerticalXXL,
    paddingRight: tokens.spacingVerticalXXL,
    paddingBottom: tokens.spacingVerticalXXL,
    paddingLeft: tokens.spacingVerticalXXL,
    overflow: 'visible',
    backgroundColor: tokens.colorTransparentBackground,
    boxShadow: 'none',
    border: 'none',
    borderRadius: tokens.borderRadiusLarge,
    '@media (max-width: 640px)': {
      padding: tokens.spacingVerticalL,
    },
  },
  logoContainer: {
    position: 'relative',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: tokens.spacingVerticalXXL,
    overflow: 'visible',
    '@media (max-width: 640px)': {
      marginBottom: tokens.spacingVerticalL,
    },
  },
  // Uses a blurred clone of the logo behind the main logo
  logoGlow: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    zIndex: 0,
    filter: 'blur(22px) saturate(1.8) opacity(0.80)',
    transform: 'scale(1.1)',
    pointerEvents: 'none',
    '@media (max-width: 640px)': {
      filter: 'blur(18px) saturate(1.8) opacity(0.80)',
    },
  },
  logo: {
    height: '320px',
    width: 'auto',
    display: 'block',
    position: 'relative',
    zIndex: 1,
    // Add contour glow as well for better definition
    filter: `drop-shadow(0 0 1px color-mix(in srgb, ${tokens.colorNeutralForeground1} 15%, transparent))`,
    '@media (max-width: 640px)': {
      height: '180px',
    },
  },
  header: {
    textAlign: 'center',
    marginBottom: tokens.spacingVerticalXL,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    '@media (max-width: 640px)': {
      marginBottom: tokens.spacingVerticalL,
    },
  },
  content: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalL,
  },
  infoBox: {
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingVerticalXL,
    textAlign: 'center',
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
    letterSpacing: '0.2em',
  },
  waitingText: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: tokens.spacingHorizontalS,
    color: tokens.colorNeutralForeground2,
  },
  tidalIcon: {
    width: '20px',
    height: '20px',
    borderRadius: tokens.borderRadiusSmall,
    objectFit: 'cover',
  },
});

const Auth = () => {
  const styles = useStyles();
  const queryClient = useQueryClient();
  const [connecting, setConnecting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [userCode, setUserCode] = useState<string | null>(null);
  const [verificationUrl, setVerificationUrl] = useState<string | null>(null);
  const refreshPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const devicePollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);
  const navigate = useNavigate();
  const location = useLocation();
  const { toast } = useToast();
  const { theme, setTheme, setBrandKeyColor } = useTheme();
  const { setArtwork, colors } = useUltraBlurContext();

  const isLikelyNavigationAbort = (error: any) => {
    const failedFetch = String(error?.message || '').includes('Failed to fetch');
    return failedFetch && document.visibilityState !== 'visible';
  };

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

  const refreshTidalAuthStatusCache = useCallback((status?: { user?: { username?: string } | null }) => {
    queryClient.setQueryData(["tidalAuthStatus"], (previous: any) => ({
      ...(previous ?? {}),
      connected: true,
      refreshTokenExpired: false,
      tokenExpired: false,
      user: status?.user ?? previous?.user ?? null,
    }));
    void queryClient.invalidateQueries({ queryKey: ["tidalAuthStatus"] });
  }, [queryClient]);

  // Clear artwork and brand color on auth page (use logo colors)
  useEffect(() => {
    setArtwork(undefined);
    setBrandKeyColor(null);
  }, [setArtwork, setBrandKeyColor]);

  useEffect(() => {
    const checkExistingConnection = async () => {
      try {
        const status: any = await api.getAuthStatus();

        if (!isMountedRef.current) {
          return;
        }

        const isConnected = Boolean(status?.connected) && !status?.refreshTokenExpired;

        if (isConnected) {
          refreshTidalAuthStatusCache(status);
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
  }, [navigateAfterAuth, refreshTidalAuthStatusCache]);

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
        const status: any = await api.getAuthStatus();

        if (!isMountedRef.current) {
          return;
        }

        const isConnected = Boolean(status?.connected) && !status?.refreshTokenExpired;

        if (isConnected) {
          if (refreshPollRef.current) {
            clearInterval(refreshPollRef.current);
            refreshPollRef.current = null;
          }
          setRefreshing(false);
          refreshTidalAuthStatusCache(status);
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

  const connectTidal = async () => {
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
    let authWindow: Window | null = null;
    try {
      authWindow = window.open("about:blank", "_blank", "noopener,noreferrer");
    } catch {
      authWindow = null;
    }
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
        toast({
          title: "Already Connected!",
          description: "You are already logged in to TIDAL.",
        });
        refreshTidalAuthStatusCache(loginData);
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
      if (authWindow && !authWindow.closed) {
        authWindow.location.href = url;
      } else {
        window.open(url, '_blank', 'noopener,noreferrer');
      }

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
            toast({
              title: "Connected!",
              description: `Welcome ${authData.user?.username || 'user'}!`,
            });
            refreshTidalAuthStatusCache(authData);
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

  return (
    <>
      <UltraBlurBackground colors={colors} />
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
          {!connecting && !userCode && (
            <div className={styles.content}>
              <div className={styles.header}>
                <div className={styles.logoContainer}>
                  {/* Dynamic glow using blurred copy of logo */}
                  <img src={logo} alt="" role="presentation" className={styles.logoGlow} />
                  <img src={logo} alt="Discogenius" className={styles.logo} />
                </div>
                <Title2>Welcome to Discogenius</Title2>
                <Body1 style={{ textAlign: "center", marginTop: tokens.spacingVerticalM, color: tokens.colorNeutralForeground2 }}>
                  Connect your TIDAL account to start downloading and managing your library.
                </Body1>
              </div>

              <Button
                appearance="primary"
                icon={<img src={tidalIcon} alt="Tidal" className={styles.tidalIcon} />}
                onClick={connectTidal}
                size="large"
                style={{ width: '100%' }}
              >
                Connect with TIDAL
              </Button>
            </div>
          )}

          {connecting && !userCode && (
            <div className={styles.infoBox}>
              <div style={{ marginBottom: tokens.spacingVerticalL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
                <Title3>Starting TIDAL authorization</Title3>
                <Body1 style={{ color: tokens.colorNeutralForeground2 }}>
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
              <div style={{ marginBottom: tokens.spacingVerticalL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
                <Title3>Authorize Discogenius</Title3>
                <Body1 style={{ color: tokens.colorNeutralForeground2 }}>
                  Visit the link below and enter this code to authorize:
                </Body1>
              </div>

              <div className={styles.codeDisplay} style={{ marginBottom: tokens.spacingVerticalM }}>
                <Text className={styles.userCode}>
                  {userCode}
                </Text>
              </div>

              <Button
                appearance="outline"
                icon={<Open24Regular />}
                onClick={() => {
                  if (verificationUrl) {
                    window.open(verificationUrl, '_blank', 'noopener,noreferrer');
                  }
                }}
                style={{ width: '100%', marginBottom: tokens.spacingVerticalM }}
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
