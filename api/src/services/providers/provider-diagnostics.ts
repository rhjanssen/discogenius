import { downloadBackendRegistry } from "../download/download-backend.js";
import type {
  ProviderAuthStatus,
  ProviderDiagnosticKind,
  ProviderDiagnosticResult,
  StreamingProvider,
} from "./streaming-provider.js";

async function readAuthStatus(provider: StreamingProvider): Promise<ProviderAuthStatus | null> {
  try {
    return await provider.getAuthStatus();
  } catch (error) {
    return {
      connected: false,
      tokenExpired: true,
      refreshTokenExpired: true,
      hoursUntilExpiry: 0,
      canAccessShell: true,
      canAccessLocalLibrary: true,
      remoteCatalogAvailable: false,
      canAuthenticate: Boolean(provider.manifest?.auth.managedByApp && provider.startDeviceLogin),
      message: error instanceof Error ? error.message : "Unable to read provider authentication status.",
    };
  }
}

function buildAuthDiagnostic(
  provider: StreamingProvider,
  authStatus: ProviderAuthStatus | null,
  checkedAt: string,
): ProviderDiagnosticResult {
  if (!authStatus) {
    return {
      kind: "auth",
      status: "unknown",
      message: "Provider authentication status is not available.",
      checkedAt,
    };
  }

  const status = authStatus.tokenExpired || authStatus.refreshTokenExpired
    ? "error"
    : authStatus.connected
      ? "ok"
      : "warning";

  return {
    kind: "auth",
    status,
    message: authStatus.message || (authStatus.connected
      ? `${provider.name} authentication is active.`
      : `${provider.name} is not connected.`),
    checkedAt,
    details: {
      authKind: provider.manifest?.auth.kind ?? "unknown",
      managedByApp: Boolean(provider.manifest?.auth.managedByApp),
      connected: authStatus.connected,
      tokenExpired: authStatus.tokenExpired,
      refreshTokenExpired: authStatus.refreshTokenExpired,
      remoteCatalogAvailable: authStatus.remoteCatalogAvailable,
      canAuthenticate: authStatus.canAuthenticate,
    },
  };
}

function buildCatalogDiagnostic(
  provider: StreamingProvider,
  authStatus: ProviderAuthStatus | null,
  checkedAt: string,
): ProviderDiagnosticResult {
  const catalog = provider.manifest?.catalog;
  const hasCatalog = Boolean(catalog?.search || catalog?.artistCatalog || catalog?.releaseOffers || catalog?.videos);
  if (!hasCatalog) {
    return {
      kind: "catalog",
      status: "disabled",
      message: `${provider.name} does not declare catalog capabilities.`,
      checkedAt,
    };
  }

  const remoteCatalogAvailable = authStatus?.remoteCatalogAvailable ?? Boolean(provider.isAuthenticated?.());
  return {
    kind: "catalog",
    status: remoteCatalogAvailable ? "ok" : "warning",
    message: remoteCatalogAvailable
      ? `${provider.name} catalog access is available.`
      : `${provider.name} catalog access is not currently available.`,
    checkedAt,
    details: {
      search: Boolean(catalog?.search),
      artistCatalog: Boolean(catalog?.artistCatalog),
      releaseOffers: Boolean(catalog?.releaseOffers),
      videos: Boolean(catalog?.videos),
      remoteCatalogAvailable,
    },
  };
}

function buildDownloadBackendDiagnostic(provider: StreamingProvider, checkedAt: string): ProviderDiagnosticResult {
  const declaredBackends = provider.manifest?.downloadBackends ?? [];
  if (declaredBackends.length === 0) {
    return {
      kind: "download-backend",
      status: "disabled",
      message: `${provider.name} does not declare a download backend.`,
      checkedAt,
    };
  }

  const backends = declaredBackends.map((declared) => {
    const registered = downloadBackendRegistry.get(declared.id);
    const supportsProvider = Boolean(registered?.supportedProviders.includes(provider.id));
    const supportsCapabilities = declared.capabilities.every((capability) => registered?.capabilities.includes(capability));
    return {
      id: declared.id,
      enabled: declared.enabled,
      registered: Boolean(registered),
      supportsProvider,
      supportsCapabilities,
      declaredCapabilities: declared.capabilities,
      registeredCapabilities: registered?.capabilities ?? [],
      setupNote: declared.setupNote,
    };
  });

  const enabledBackends = backends.filter((backend) => backend.enabled);
  const readyBackends = enabledBackends.filter(
    (backend) => backend.registered && backend.supportsProvider && backend.supportsCapabilities,
  );

  const status = readyBackends.length > 0
    ? "ok"
    : enabledBackends.length > 0
      ? "error"
      : "disabled";

  return {
    kind: "download-backend",
    status,
    message: readyBackends.length > 0
      ? `${provider.name} download backend is registered.`
      : enabledBackends.length > 0
        ? `${provider.name} download backend is enabled but not registered correctly.`
        : `${provider.name} download backend is disabled.`,
    checkedAt,
    details: { backends },
  };
}

function buildRateLimitDiagnostic(provider: StreamingProvider, checkedAt: string): ProviderDiagnosticResult {
  const metrics = provider.getRateLimitMetrics?.();
  if (!metrics) {
    return {
      kind: "rate-limit",
      status: "unknown",
      message: `${provider.name} does not expose rate-limit metrics.`,
      checkedAt,
    };
  }

  const rateLimitUntil = typeof metrics.rateLimitUntil === "string" && metrics.rateLimitUntil
    ? Date.parse(metrics.rateLimitUntil)
    : 0;
  const isThrottled = Number.isFinite(rateLimitUntil) && rateLimitUntil > Date.now();
  return {
    kind: "rate-limit",
    status: isThrottled ? "warning" : "ok",
    message: isThrottled
      ? `${provider.name} is temporarily rate limited.`
      : `${provider.name} rate-limit state is normal.`,
    checkedAt,
    details: metrics,
  };
}

export async function getProviderDiagnostics(provider: StreamingProvider): Promise<ProviderDiagnosticResult[]> {
  if (provider.getDiagnostics) {
    return provider.getDiagnostics();
  }

  const kinds = provider.manifest?.diagnostics ?? [];
  if (kinds.length === 0) {
    return [];
  }

  const checkedAt = new Date().toISOString();
  const authStatus = kinds.includes("auth") || kinds.includes("catalog")
    ? await readAuthStatus(provider)
    : null;

  return kinds.map((kind: ProviderDiagnosticKind) => {
    if (kind === "auth") {
      return buildAuthDiagnostic(provider, authStatus, checkedAt);
    }
    if (kind === "catalog") {
      return buildCatalogDiagnostic(provider, authStatus, checkedAt);
    }
    if (kind === "download-backend") {
      return buildDownloadBackendDiagnostic(provider, checkedAt);
    }
    if (kind === "rate-limit") {
      return buildRateLimitDiagnostic(provider, checkedAt);
    }
    return {
      kind,
      status: "unknown",
      message: `${provider.name} declares an unknown diagnostic kind.`,
      checkedAt,
    };
  });
}
