import { Navigate, Outlet, useLocation } from "react-router-dom";
import { Button } from "@fluentui/react-components";
import {
  LOCALSTORAGE_APP_AUTH_REDIRECT_KEY,
  useAppAuth,
} from "@/providers/appAuthContext";
import { BootLoadingPage } from "@/components/shell/BootLoadingPage";
import { ErrorState } from "@/components/ui/ContentState";

export default function AppBootstrapGate() {
  const { isAuthActive, isAccessGranted, bootstrapError, refresh } = useAppAuth();
  const location = useLocation();

  if (bootstrapError) {
    return (
      <ErrorState
        title="Discogenius could not verify app access"
        description={bootstrapError}
        actions={(
          <Button appearance="primary" onClick={() => { void refresh().catch(() => undefined); }}>
            Retry
          </Button>
        )}
        minHeight="100vh"
      />
    );
  }

  if (isAuthActive === undefined) {
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
