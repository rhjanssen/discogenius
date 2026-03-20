import { Navigate, Outlet, useLocation } from "react-router-dom";
import { makeStyles, tokens } from "@fluentui/react-components";
import { useTidalConnection } from "@/hooks/useTidalConnection";
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

const ProtectedRoute = () => {
  const styles = useStyles();
  const location = useLocation();
  const { canAccessShell, isLoading } = useTidalConnection();

  if (isLoading) {
    return (
      <LoadingState
        className={styles.loading}
        panelClassName={styles.loadingPanel}
        label="Checking connection..."
      />
    );
  }

  if (!canAccessShell) {
    return <Navigate to="/auth" replace state={{ from: location }} />;
  }

  return <Outlet />;
};

export default ProtectedRoute;
