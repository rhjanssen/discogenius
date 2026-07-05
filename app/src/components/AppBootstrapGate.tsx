import { Navigate, Outlet, useLocation } from "react-router-dom";
import {
  LOCALSTORAGE_APP_AUTH_REDIRECT_KEY,
  useAppAuth,
} from "@/providers/appAuthContext";
import { BootLoadingPage } from "@/components/shell/BootLoadingPage";

export default function AppBootstrapGate() {
  const { isAuthActive, isAccessGranted, isBootstrapping } = useAppAuth();
  const location = useLocation();

  // Branded boot screen only while the first (short, non-fatal) auth check is
  // in flight — it never blocks the app on API failure.
  if (isBootstrapping) {
    return <BootLoadingPage />;
  }

  if (isAuthActive && !isAccessGranted) {
    try {
      localStorage.setItem(
        LOCALSTORAGE_APP_AUTH_REDIRECT_KEY,
        `${location.pathname}${location.search}`,
      );
    } catch {
      // ignore storage errors
    }

    return <Navigate to="/login" replace />;
  }

  return <Outlet />;
}
