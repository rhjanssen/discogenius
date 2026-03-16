import { Navigate, Outlet, useLocation } from "react-router-dom";
import { Spinner, makeStyles, tokens } from "@fluentui/react-components";
import { LOCALSTORAGE_APP_AUTH_REDIRECT_KEY, useAppAuth } from "@/providers/appAuthContext";

const useStyles = makeStyles({
  loading: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: tokens.spacingVerticalL,
  },
});

export default function AppAuthGate() {
  const { isAuthActive, isAccessGranted } = useAppAuth();
  const { pathname, search } = useLocation();
  const styles = useStyles();

  if (isAuthActive === undefined) {
    return (
      <div className={styles.loading}>
        <Spinner size="large" />
      </div>
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
