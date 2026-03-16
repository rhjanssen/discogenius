import { useQuery } from "@tanstack/react-query";
import { api } from "@/services/api";

type AuthStatus = {
  connected?: boolean;
  refreshTokenExpired?: boolean;
  tokenExpired?: boolean;
  hoursUntilExpiry?: number;
  user?: {
    username?: string;
  } | null;
};

export function useTidalConnection() {
  const query = useQuery({
    queryKey: ["tidalAuthStatus"],
    queryFn: async () => {
      return await api.getAuthStatus() as AuthStatus;
    },
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    retry: 1,
  });

  const status = query.data;
  const isConnected = Boolean(status?.connected) && !status?.refreshTokenExpired;

  return {
    ...query,
    status,
    isConnected,
    isSessionExpired: Boolean(status?.refreshTokenExpired || status?.tokenExpired),
  };
}
