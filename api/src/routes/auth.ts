import { Router } from "express";
import type { AuthStatusContract } from "../contracts/auth.js";
import { logout as clearAuthData, loadToken, refreshTidalToken } from "../services/tidal.js";
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
    connected,
    tokenExpired: overrides.tokenExpired,
    refreshTokenExpired: overrides.refreshTokenExpired,
    hoursUntilExpiry: overrides.hoursUntilExpiry,
    mode: "live",
    canAccessShell: true,
    canAccessLocalLibrary: true,
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
    let token = loadToken();
    let tokenExpired = false;
    let refreshTokenExpired = false;
    let hoursUntilExpiry = 0;

    if (!token?.access_token) {
      return res.json(buildLiveAuthStatus({
        connected: false,
        tokenExpired: false,
        refreshTokenExpired: false,
        hoursUntilExpiry: 0,
        user: null,
        message: "Connect your TIDAL account to access remote catalog features.",
      }));
    }

    if (token.expires_at) {
      const nowInSeconds = Math.floor(Date.now() / 1000);
      hoursUntilExpiry = (token.expires_at - nowInSeconds) / 3600;
      tokenExpired = hoursUntilExpiry < 0;

      if (tokenExpired) {
        await refreshTidalToken(true);
        token = loadToken();

        if (token?.expires_at && token.access_token) {
          const newHoursUntilExpiry = (token.expires_at - nowInSeconds) / 3600;
          if (newHoursUntilExpiry < 0) {
            refreshTokenExpired = true;
          } else {
            tokenExpired = false;
            hoursUntilExpiry = newHoursUntilExpiry;
          }
        } else {
          refreshTokenExpired = true;
        }
      }
    }

    if (token?.access_token && !tokenExpired && !refreshTokenExpired) {
      return res.json(buildLiveAuthStatus({
        connected: true,
        user: token.user?.username ? { username: token.user.username } : null,
        tokenExpired,
        refreshTokenExpired,
        hoursUntilExpiry,
      }));
    }

    res.json(buildLiveAuthStatus({
      connected: false,
      tokenExpired,
      refreshTokenExpired: refreshTokenExpired || !token?.refresh_token,
      hoursUntilExpiry,
      user: token?.user?.username ? { username: token.user.username } : null,
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
