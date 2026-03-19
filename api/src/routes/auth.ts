import { Router } from "express";
import type { AuthStatusContract } from "../contracts/auth.js";
import { getUserInfo, logout as clearAuthData, loadToken, refreshTidalToken } from "../services/tidal.js";
import { pollTidalDeviceLogin, startTidalDeviceLogin } from "../services/tidal-auth.js";
import {
  buildBypassedAuthStatus,
  getProviderAuthMode,
  isProviderAuthBypassed,
} from "../services/provider-auth-mode.js";

const router = Router();

function buildLiveAuthStatus(
  overrides: Partial<AuthStatusContract> & Pick<AuthStatusContract, "connected" | "tokenExpired" | "refreshTokenExpired" | "hoursUntilExpiry">,
): AuthStatusContract {
  const connected = overrides.connected && !overrides.refreshTokenExpired;

  return {
    connected: overrides.connected,
    tokenExpired: overrides.tokenExpired,
    refreshTokenExpired: overrides.refreshTokenExpired,
    hoursUntilExpiry: overrides.hoursUntilExpiry,
    mode: "live",
    canAccessShell: connected,
    canAccessLocalLibrary: connected,
    remoteCatalogAvailable: connected,
    authBypassed: false,
    canAuthenticate: true,
    refreshing: overrides.refreshing,
    user: overrides.user ?? null,
    message: overrides.message,
  };
}

function getBypassedAuthModeMessage() {
  const mode = getProviderAuthMode();
  if (mode === "mock") {
    return "Mock provider auth mode is active. Set DISCOGENIUS_PROVIDER_AUTH_MODE=live to authenticate with TIDAL.";
  }

  return "Disconnected local-library mode is active. Set DISCOGENIUS_PROVIDER_AUTH_MODE=live to authenticate with TIDAL.";
}

router.post("/device-login", async (_, res) => {
  if (isProviderAuthBypassed()) {
    return res.status(409).json({ detail: getBypassedAuthModeMessage() });
  }

  try {
    const result = await startTidalDeviceLogin();

    if (result.alreadyLoggedIn) {
      return res.json({
        alreadyLoggedIn: true,
        message: "Already logged in"
      });
    }

    res.json({
      userCode: result.userCode,
      url: result.verificationUrl,
      expiresIn: result.expiresIn || 300,
      interval: result.interval || 3,
    });
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

router.get("/check-login", async (_, res) => {
  if (isProviderAuthBypassed()) {
    return res.status(409).json({ detail: getBypassedAuthModeMessage() });
  }

  try {
    res.json(await pollTidalDeviceLogin());
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

router.get("/status", async (_, res) => {
  const bypassedStatus = buildBypassedAuthStatus();
  if (bypassedStatus) {
    return res.json(bypassedStatus);
  }

  try {
    // Check token expiration
    let token = loadToken();

    let tokenExpired = false;
    let refreshTokenExpired = false;
    let hoursUntilExpiry = 0;

    if (token?.expires_at) {
      const nowInSeconds = Math.floor(Date.now() / 1000);
      hoursUntilExpiry = (token.expires_at - nowInSeconds) / 3600;
      tokenExpired = hoursUntilExpiry < 0;

      // If token is expired, attempt to refresh it
      if (tokenExpired) {
        console.log('[AUTH STATUS] Token expired, attempting refresh...');
        await refreshTidalToken(true);

        // Reload token after refresh attempt
        token = loadToken();
        if (token?.expires_at) {
          const newHoursUntilExpiry = (token.expires_at - nowInSeconds) / 3600;

          // If still expired after refresh, the refresh token is dead
          if (newHoursUntilExpiry < 0) {
            console.log('[AUTH STATUS] Token still expired after refresh - refresh token is invalid');
            refreshTokenExpired = true;
          } else {
            // Refresh succeeded!
            tokenExpired = false;
            hoursUntilExpiry = newHoursUntilExpiry;
            console.log(`[AUTH STATUS] Token refreshed! New expiry: ${newHoursUntilExpiry.toFixed(1)}h`);
          }
        } else {
          refreshTokenExpired = true;
        }
      }
    }

    // Avoid forcing a refresh when just checking status on page load (we already tried above if needed)
    const userInfo = await getUserInfo({ refreshOn401: false });

    if (userInfo) {
      return res.json(buildLiveAuthStatus({
        connected: true,
        user: { username: userInfo.username },
        tokenExpired,
        refreshTokenExpired,
        hoursUntilExpiry,
      }));
    }

    // If we failed to get user info, check if it's because refresh token is expired
    res.json(buildLiveAuthStatus({
      connected: false,
      tokenExpired,
      refreshTokenExpired: refreshTokenExpired || !token?.refresh_token,
      hoursUntilExpiry,
      message: refreshTokenExpired || !token?.refresh_token
        ? "Your TIDAL session has expired. Reconnect to access remote catalog features."
        : "Connect your TIDAL account to access remote catalog features.",
    }));
  } catch (error: any) {
    res.json(buildLiveAuthStatus({
      connected: false,
      tokenExpired: true,
      refreshTokenExpired: true,
      hoursUntilExpiry: 0,
      message: "Unable to verify TIDAL authentication status.",
    }));
  }
});

router.post("/logout", async (_, res) => {
  if (isProviderAuthBypassed()) {
    return res.json({
      success: true,
      message: "Provider auth bypass mode is active; no live TIDAL session was cleared.",
    });
  }

  try {
    clearAuthData();
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

export default router;
