import { Router } from "express";
import { streamingProviderManager } from "../services/providers/index.js";
import type { StreamingProvider } from "../services/providers/streaming-provider.js";

const router = Router();

function providerSupportsManagedAuth(provider: StreamingProvider): boolean {
  return Boolean(provider.manifest?.auth.managedByApp && provider.startDeviceLogin);
}

function getRequestedProviderId(req: { query: any; body?: any }): string {
  return (req.query.provider as string)
    || (req.body?.provider as string)
    || streamingProviderManager.getDefaultProviderId();
}

router.post("/device-login", async (req, res) => {
  try {
    const providerId = getRequestedProviderId(req);
    const provider = streamingProviderManager.getStreamingProvider(providerId);

    if (!providerSupportsManagedAuth(provider) || !provider.startDeviceLogin) {
      return res.status(400).json({ detail: `provider ${providerId} does not support device login.` });
    }

    const result = await provider.startDeviceLogin();

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

router.post("/credentials", async (req, res) => {
  try {
    const providerId = getRequestedProviderId(req);
    const provider = streamingProviderManager.getStreamingProvider(providerId);

    if (!provider.saveCredentials) {
      return res.status(400).json({ detail: `provider ${providerId} does not support credential-based authentication.` });
    }

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const credentials = body.credentials && typeof body.credentials === "object"
      ? body.credentials
      : body;
    await provider.saveCredentials(credentials as Record<string, unknown>);
    res.json({ success: true, provider: provider.id, status: await provider.getAuthStatus() });
  } catch (error: any) {
    res.status(400).json({ detail: error.message });
  }
});

router.get("/check-login", async (req, res) => {
  try {
    const providerId = getRequestedProviderId(req);
    const provider = streamingProviderManager.getStreamingProvider(providerId);

    if (!provider.manifest?.auth.managedByApp || !provider.pollDeviceLogin) {
      return res.status(400).json({ detail: `provider ${providerId} does not support device login polling.` });
    }

    res.json(await provider.pollDeviceLogin());
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

router.get("/status", async (req, res) => {
  try {
    const providerId = (req.query.provider as string);
    if (providerId) {
      const provider = streamingProviderManager.getStreamingProvider(providerId);
      return res.json(await provider.getAuthStatus());
    }

    const providers = streamingProviderManager.getAllStreamingProviders();
    let connected = false;
    let remoteCatalogAvailable = false;
    let canAuthenticate = false;
    let message = "Connect a provider to access remote features.";
    let user = null;

    for (const p of providers) {
      canAuthenticate = canAuthenticate || providerSupportsManagedAuth(p);
      const status = await p.getAuthStatus();
      if (status.connected) {
        connected = true;
        remoteCatalogAvailable = true;
        message = status.message || `Connected to ${p.name}`;
        user = status.user;
        break;
      }
    }

    res.json({
      connected,
      tokenExpired: false,
      refreshTokenExpired: false,
      hoursUntilExpiry: 12,
      canAccessShell: true,
      canAccessLocalLibrary: true,
      remoteCatalogAvailable,
      canAuthenticate,
      user,
      message,
    });
  } catch (error: any) {
    res.json({
      connected: false,
      tokenExpired: true,
      refreshTokenExpired: true,
      hoursUntilExpiry: 0,
      canAccessShell: true,
      canAccessLocalLibrary: true,
      remoteCatalogAvailable: false,
      canAuthenticate: true,
      message: error.message || "Unable to verify authentication status.",
    });
  }
});

router.post("/logout", async (req, res) => {
  try {
    const providerId = getRequestedProviderId(req);
    const provider = streamingProviderManager.getStreamingProvider(providerId);
    if (!provider.logout) {
      return res.status(501).json({ detail: `${provider.name} does not support disconnecting` });
    }
    await provider.logout();
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

export default router;
