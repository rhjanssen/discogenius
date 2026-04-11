import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/services/api";
import {
  AppAuthContext,
  type AppAuthType,
  LOCALSTORAGE_APP_AUTH_REDIRECT_KEY,
  LOCALSTORAGE_APP_AUTH_TOKEN_KEY,
  type AppAuthContextValue,
} from "@/providers/appAuthContext";

export function AppAuthProvider({ children }: { children: React.ReactNode }) {
  const [isAuthActive, setIsAuthActive] = useState<boolean>();
  const [authType, setAuthType] = useState<AppAuthType>(null);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
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
    try {
      setBootstrapError(null);
      const status = await api.isAppAuthActive();
      const active = Boolean(status.isAuthActive);
      setAuthType(status.authType);
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
    } catch (error) {
      setBootstrapError(error instanceof Error ? error.message : "Unable to verify app authentication status.");
      setIsAuthActive(undefined);
      throw error;
    }
  }, [token]);

  useEffect(() => {
    setIsAuthActive(undefined);
    refresh().catch((error) => {
      console.warn("[AppAuth] Failed to check auth status:", error);
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

  const signOut = useCallback(() => {
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
    authType,
    isAccessGranted,
    token,
    bootstrapError,
    refresh,
    login,
    signOut,
  };

  return <AppAuthContext.Provider value={value}>{children}</AppAuthContext.Provider>;
}
