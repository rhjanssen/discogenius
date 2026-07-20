import { Router } from "express";
import { streamingProviderManager } from "../services/providers/index.js";
import {
  providerSupportsAppAuthentication,
  providerSupportsDeviceAuthentication,
} from "../services/providers/provider-auth-support.js";
import type { ProviderAuthStatus, StreamingProvider } from "../services/providers/streaming-provider.js";

const router = Router();

export async function aggregateProviderAuthStatus(
  providers: StreamingProvider[],
): Promise<ProviderAuthStatus> {
  let connected = false;
  let remoteCatalogAvailable = false;
  let canAuthenticate = false;
  let message = "Connect a provider to access remote features.";
  let user: ProviderAuthStatus["user"] = null;
  let refreshing = false;
  let hoursUntilExpiry = 0;

  for (const provider of providers) {
    canAuthenticate = canAuthenticate || providerSupportsAppAuthentication(provider);
    let status: ProviderAuthStatus;
    try {
      status = await provider.getAuthStatus();
    } catch {
      // One unavailable provider must not hide another provider's public
      // catalog or valid session from the aggregate app-shell status.
      continue;
    }

    remoteCatalogAvailable = remoteCatalogAvailable || status.remoteCatalogAvailable;
    canAuthenticate = canAuthenticate || status.canAuthenticate;
    refreshing = refreshing || Boolean(status.refreshing);
    hoursUntilExpiry = Math.max(hoursUntilExpiry, Number(status.hoursUntilExpiry) || 0);

    if (status.connected && !connected) {
      connected = true;
      message = status.message || `Connected to ${provider.name}`;
      user = status.user ?? null;
    } else if (!connected && status.remoteCatalogAvailable) {
      message = status.message || `${provider.name} public catalog is available.`;
    }
  }

  return {
    connected,
    tokenExpired: false,
    refreshTokenExpired: false,
    hoursUntilExpiry,
    canAccessShell: true,
    canAccessLocalLibrary: true,
    remoteCatalogAvailable,
    canAuthenticate,
    refreshing,
    user,
    message,
  };
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

    if (!providerSupportsDeviceAuthentication(provider) || !provider.startDeviceLogin) {
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
    if (provider.manifest?.auth.comingSoon) {
      return res.status(503).json({ detail: `${provider.name} is marked Soon and cannot accept credentials yet.` });
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

// Generic external-downloader login (e.g. the Apple Music decryption
// wrapper). The provider plugin owns the mechanics; credentials pass through
// transiently and are never persisted by the core.
router.get("/:providerId/downloader-login/status", (req, res) => {
  try {
    const provider = streamingProviderManager.getStreamingProvider(req.params.providerId);
    if (!provider.getDownloaderLoginStatus) {
      return res.status(501).json({ detail: `${provider.name} has no downloader login` });
    }
    res.json(provider.getDownloaderLoginStatus());
  } catch (error: any) {
    res.status(404).json({ detail: error.message });
  }
});

router.post("/:providerId/downloader-login", async (req, res) => {
  try {
    const provider = streamingProviderManager.getStreamingProvider(req.params.providerId);
    if (!provider.startDownloaderLogin) {
      return res.status(501).json({ detail: `${provider.name} has no downloader login` });
    }
    const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
    const credentials: Record<string, string> = {};
    for (const [key, value] of Object.entries(body)) {
      if (typeof value === "string") credentials[key] = value;
    }
    if (!Object.keys(credentials).length) {
      return res.status(400).json({ detail: "Credentials are required." });
    }
    await provider.startDownloaderLogin(credentials);
    res.json({ success: true, status: provider.getDownloaderLoginStatus?.() ?? { status: "logging_in", message: "" } });
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

router.post("/:providerId/downloader-login/code", async (req, res) => {
  try {
    const provider = streamingProviderManager.getStreamingProvider(req.params.providerId);
    if (!provider.submitDownloaderLoginCode) {
      return res.status(501).json({ detail: `${provider.name} has no downloader login` });
    }
    const body = req.body && typeof req.body === "object" ? req.body as { code?: unknown } : {};
    const code = String(body.code || "").trim();
    if (!code) {
      return res.status(400).json({ detail: "Code is required" });
    }
    await provider.submitDownloaderLoginCode(code);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
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

    res.json(await aggregateProviderAuthStatus(streamingProviderManager.getAllStreamingProviders()));
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
