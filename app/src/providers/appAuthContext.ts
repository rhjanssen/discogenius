import { createContext, useContext } from "react";

export const LOCALSTORAGE_APP_AUTH_TOKEN_KEY = "discogenius-app-auth-token";
export const LOCALSTORAGE_APP_AUTH_REDIRECT_KEY = "discogenius-app-auth-redirect";

export type AppAuthType = "password" | null;

export type AppAuthContextValue = {
  isAuthActive: boolean | undefined;
  authType: AppAuthType;
  isAccessGranted: boolean;
  token: string | null;
  bootstrapError: string | null;
  refresh: () => Promise<void>;
  login: (password: string) => Promise<void>;
  signOut: () => void;
};

export const AppAuthContext = createContext<AppAuthContextValue | undefined>(undefined);

export function useAppAuth() {
  const value = useContext(AppAuthContext);
  if (!value) throw new Error("useAppAuth must be used within an AppAuthProvider");
  return value;
}
