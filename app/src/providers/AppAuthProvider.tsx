import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/services/api";
import {
  AppAuthContext,
  LOCALSTORAGE_APP_AUTH_REDIRECT_KEY,
  LOCALSTORAGE_APP_AUTH_TOKEN_KEY,
  type AppAuthContextValue,
} from "@/providers/appAuthContext";

export function AppAuthProvider({ children }: { children: React.ReactNode }) {
  const [isAuthActive, setIsAuthActive] = useState<boolean>();
  const [token, setToken] = useState<string | null>(() => {
    try {
      return localStorage.getItem(LOCALSTORAGE_APP_AUTH_TOKEN_KEY);
    } catch {
      return null;
    }
  });

  useEffect(() => {
    api.setAuthToken(token);
  }, [token]);

  const refresh = useCallback(async () => {
    const status: any = await api.isAppAuthActive();
    const active = Boolean(status?.isAuthActive);
    if (active && token) {
      try {
        await api.verifyAppAuth();
      } catch {
        try {
          localStorage.removeItem(LOCALSTORAGE_APP_AUTH_TOKEN_KEY);
        } catch {
          // ignore
        }
        setToken(null);
      }
    }

    setIsAuthActive(active);
  }, [token]);

  useEffect(() => {
    refresh().catch((error) => {
      console.warn("[AppAuth] Failed to check auth status:", error);
      setIsAuthActive(false);
    });
  }, [refresh]);

  const login = useCallback(async (password: string) => {
    const response: any = await api.loginAppAuth(password);
    if (response?.accessGranted && typeof response?.token === "string") {
      try {
        localStorage.setItem(LOCALSTORAGE_APP_AUTH_TOKEN_KEY, response.token);
      } catch {
        // ignore
      }
      setToken(response.token);
      return;
    }
    throw new Error("Invalid credentials");
  }, []);

  const logout = useCallback(() => {
    try {
      localStorage.removeItem(LOCALSTORAGE_APP_AUTH_TOKEN_KEY);
      localStorage.removeItem(LOCALSTORAGE_APP_AUTH_REDIRECT_KEY);
    } catch {
      // ignore
    }
    setToken(null);
  }, []);

  const isAccessGranted = useMemo(() => {
    if (isAuthActive === undefined) return false;
    if (!isAuthActive) return true;
    return !!token;
  }, [isAuthActive, token]);

  const value: AppAuthContextValue = {
    isAuthActive,
    isAccessGranted,
    token,
    refresh,
    login,
    logout,
  };

  return <AppAuthContext.Provider value={value}>{children}</AppAuthContext.Provider>;
}
