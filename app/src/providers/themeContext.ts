import { createContext, useContext } from "react";

export type ThemeMode = "light" | "dark" | "system";

export type ThemeProviderState = {
  theme: ThemeMode;
  setTheme: (theme: ThemeMode) => void;
  isDarkMode: boolean;
  /** Dynamic brand accent color (hex). When set, overrides the default orange brand ramp. */
  brandKeyColor: string | null;
  /** Set a dynamic brand color for the current page. Pass null to revert to default. */
  setBrandKeyColor: (color: string | null) => void;
};

export const ThemeProviderContext = createContext<ThemeProviderState | undefined>(undefined);

export const useTheme = () => {
  const context = useContext(ThemeProviderContext);

  if (context === undefined) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }

  return context;
};
