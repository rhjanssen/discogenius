import { Router } from "express";
import { getUserInfo, logout as clearAuthData, loadToken, refreshTidalToken } from "../services/tidal.js";
import { pollTidalDeviceLogin, startTidalDeviceLogin } from "../services/tidal-auth.js";

const router = Router();

router.post("/device-login", async (_, res) => {
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
  try {
    res.json(await pollTidalDeviceLogin());
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

router.get("/status", async (_, res) => {
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
      return res.json({
        connected: true,
        user: userInfo,
        tokenExpired,
        refreshTokenExpired,
        hoursUntilExpiry
      });
    }

    // If we failed to get user info, check if it's because refresh token is expired
    res.json({
      connected: false,
      tokenExpired: true,
      refreshTokenExpired: refreshTokenExpired || !token?.refresh_token,
      hoursUntilExpiry
    });
  } catch (error: any) {
    res.json({
      connected: false,
      tokenExpired: true,
      refreshTokenExpired: true,
      hoursUntilExpiry: 0
    });
  }
});

router.post("/logout", async (_, res) => {
  try {
    clearAuthData();
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

export default router;
