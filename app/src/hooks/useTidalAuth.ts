import { useState, useEffect } from "react";
import { api } from "@/services/api";
import { useToast } from "@/hooks/useToast";

export const useTidalAuth = () => {
  const [tidalConnected, setTidalConnected] = useState(false);
  const [tidalUsername, setTidalUsername] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const { toast } = useToast();

  useEffect(() => {
    checkTidalConnection();
  }, []);

  const checkTidalConnection = async () => {
    try {
      const status: any = await api.getAuthStatus();

      if (status?.connected && status.user) {
        setTidalConnected(true);
        setTidalUsername(status.user.username);
      }
    } catch (error) {
      console.error('Error checking Tidal connection:', error);
    } finally {
      setLoading(false);
    }
  };

  const connectTidal = async () => {
    toast({
      title: "Please use the auth page",
      description: "Redirecting...",
    });
  };

  const disconnectTidal = async () => {
    try {
      await api.logout();
      setTidalConnected(false);
      setTidalUsername(null);
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
    tidalConnected,
    tidalUsername,
    loading,
    connectTidal,
    disconnectTidal,
    checkTidalConnection,
  };
};
