import { api } from "@/services/api";
import { useTidalConnection } from "@/hooks/useTidalConnection";
import { useToast } from "@/hooks/useToast";

export const useTidalAuth = () => {
  const {
    status,
    isLoading,
    isConnected,
    canAuthenticate,
    canAccessShell,
    isAuthBypassed,
    refetch,
  } = useTidalConnection();
  const { toast } = useToast();

  const connectTidal = async () => {
    toast({
      title: "Please use the auth page",
      description: "Redirecting...",
    });
  };

  const disconnectTidal = async () => {
    try {
      await api.logoutTidal();
      await refetch();
      toast({
        title: "Disconnected",
        description: "Successfully logged out from Tidal",
      });
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    }
  };

  return {
    tidalConnected: isConnected,
    tidalUsername: status?.user?.username ?? null,
    loading: isLoading,
    authMode: status?.mode ?? "live",
    canAuthenticate,
    canAccessShell,
    authBypassed: isAuthBypassed,
    connectTidal,
    disconnectTidal,
    checkTidalConnection: refetch,
  };
};
