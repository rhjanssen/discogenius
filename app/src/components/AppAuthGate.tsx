import { Navigate, Outlet, useLocation } from "react-router-dom";
import { makeStyles, tokens } from "@fluentui/react-components";
import { LOCALSTORAGE_APP_AUTH_REDIRECT_KEY, useAppAuth } from "@/providers/appAuthContext";
import { LoadingState } from "@/components/ui/LoadingState";

const useStyles = makeStyles({
  loading: {
    width: "100%",
    minHeight: "40vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: tokens.spacingVerticalL,
  },
  loadingPanel: {
    width: "100%",
    maxWidth: "420px",
    textAlign: "center",
  },
});

export default function AppAuthGate() {
  const { isAuthActive, isAccessGranted } = useAppAuth();
  const { pathname, search } = useLocation();
  const styles = useStyles();

  if (isAuthActive === undefined) {
    return (
      <LoadingState
        className={styles.loading}
        panelClassName={styles.loadingPanel}
        label="Checking app access..."
      />
    );
  }

  if (isAuthActive && !isAccessGranted) {
    try {
      localStorage.setItem(LOCALSTORAGE_APP_AUTH_REDIRECT_KEY, `${pathname}${search}`);
    } catch {
      // ignore
    }
    return <Navigate to="/login" replace />;
  }

  return <Outlet />;
}
