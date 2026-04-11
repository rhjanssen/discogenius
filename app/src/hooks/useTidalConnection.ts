import { useQuery } from "@tanstack/react-query";
import { api } from "@/services/api";
import type { AuthStatusContract } from "@contracts/auth";

export function useTidalConnection() {
  const query = useQuery({
    queryKey: ["tidalAuthStatus"],
    queryFn: () => api.getAuthStatus(),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    placeholderData: (previousData) => previousData,
    retry: 1,
  });

  const status: AuthStatusContract | undefined = query.data;
  const isConnected = Boolean(status?.connected) && !status?.refreshTokenExpired;
  const canAccessShell = Boolean(status?.canAccessShell ?? isConnected);
  const canAccessLocalLibrary = Boolean(status?.canAccessLocalLibrary ?? canAccessShell);
  const remoteCatalogAvailable = Boolean(status?.remoteCatalogAvailable ?? isConnected);
  const providerAuthMode = status?.mode ?? "live";

  return {
    ...query,
    status,
    isConnected,
    canAccessShell,
    canAccessLocalLibrary,
    remoteCatalogAvailable,
    providerAuthMode,
    isAuthBypassed: Boolean(status?.authBypassed),
    canAuthenticate: Boolean(status?.canAuthenticate ?? true),
    isSessionExpired: Boolean(status?.refreshTokenExpired || status?.tokenExpired),
  };
}
