import { Navigate, useLocation } from "react-router-dom";
import { makeStyles, tokens } from "@fluentui/react-components";
import { useTidalConnection } from "@/hooks/useTidalConnection";
import { LoadingState } from "@/components/ui/LoadingState";

interface ProtectedRouteProps {
  children: React.ReactNode;
}

const useStyles = makeStyles({
  loading: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: tokens.spacingVerticalL,
  },
});

const ProtectedRoute = ({ children }: ProtectedRouteProps) => {
  const styles = useStyles();
  const location = useLocation();
  const { canAccessShell, isLoading } = useTidalConnection();

  if (isLoading) {
    return (
      <div className={styles.loading}>
        <LoadingState label="Checking connection..." />
      </div>
    );
  }

  if (!canAccessShell) {
    return <Navigate to="/auth" replace state={{ from: location }} />;
  }

  return <>{children}</>;
};

export default ProtectedRoute;
