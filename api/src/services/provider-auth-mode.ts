import type { AuthStatusContract, ProviderAuthMode } from "../contracts/auth.js";

const DEFAULT_MOCK_USERNAME = "discogenius-dev";

export function getProviderAuthMode(): ProviderAuthMode {
  const rawMode = String(process.env.DISCOGENIUS_PROVIDER_AUTH_MODE || "live").trim().toLowerCase();
  if (rawMode === "mock" || rawMode === "disconnected") {
    return rawMode;
  }

  return "live";
}

export function isProviderAuthBypassed(mode: ProviderAuthMode = getProviderAuthMode()): boolean {
  return mode !== "live";
}

export function buildBypassedAuthStatus(mode: ProviderAuthMode = getProviderAuthMode()): AuthStatusContract | null {
  if (mode === "live") {
    return null;
  }

  if (mode === "mock") {
    return {
      connected: true,
      tokenExpired: false,
      refreshTokenExpired: false,
      hoursUntilExpiry: 24,
      mode,
      canAccessShell: true,
      canAccessLocalLibrary: true,
      remoteCatalogAvailable: false,
      authBypassed: true,
      canAuthenticate: false,
      user: {
        username: String(process.env.DISCOGENIUS_PROVIDER_AUTH_USERNAME || DEFAULT_MOCK_USERNAME).trim() || DEFAULT_MOCK_USERNAME,
      },
      message: "Mock provider auth mode is active. Shell access is enabled without a live TIDAL session.",
    };
  }

  return {
    connected: false,
    tokenExpired: false,
    refreshTokenExpired: false,
    hoursUntilExpiry: 0,
    mode,
    canAccessShell: true,
    canAccessLocalLibrary: true,
    remoteCatalogAvailable: false,
    authBypassed: true,
    canAuthenticate: false,
    user: null,
    message: "Disconnected local-library mode is active. Live TIDAL login and remote catalog access are disabled.",
  };
}
