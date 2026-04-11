import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Button,
  Card,
  Input,
  Text,
  Title2,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { LockClosed24Regular } from "@fluentui/react-icons";
import { useToast } from "@/hooks/useToast";
import { BootLoadingPage } from "@/components/shell/BootLoadingPage";
import { ErrorState } from "@/components/ui/ContentState";
import {
  LOCALSTORAGE_APP_AUTH_REDIRECT_KEY,
  useAppAuth,
} from "@/providers/appAuthContext";

const useStyles = makeStyles({
  container: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: tokens.spacingVerticalL,
  },
  card: {
    width: "100%",
    maxWidth: "420px",
    padding: tokens.spacingVerticalXXL,
    borderRadius: tokens.borderRadiusLarge,
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalL,
  },
  header: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXS,
    textAlign: "center",
  },
  inputRow: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
  },
  hint: {
    color: tokens.colorNeutralForeground2,
    textAlign: "center",
  },
  loading: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: tokens.spacingVerticalL,
  },
});

export default function AdminLogin() {
  const styles = useStyles();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { isAuthActive, isAccessGranted, login, bootstrapError, refresh } = useAppAuth();

  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const redirectUrl = useMemo(() => {
    try {
      return localStorage.getItem(LOCALSTORAGE_APP_AUTH_REDIRECT_KEY);
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    if (isAuthActive === false) {
      navigate("/", { replace: true });
    }
  }, [isAuthActive, navigate]);

  useEffect(() => {
    if (isAuthActive !== true) return;
    if (!isAccessGranted) return;

    try {
      localStorage.removeItem(LOCALSTORAGE_APP_AUTH_REDIRECT_KEY);
    } catch {
      // ignore
    }

    navigate(redirectUrl || "/", { replace: true });
  }, [isAuthActive, isAccessGranted, navigate, redirectUrl]);

  const submit = async () => {
    if (!password.trim()) {
      toast({ title: "Password required", variant: "destructive" });
      return;
    }

    setSubmitting(true);
    try {
      await login(password);
      navigate(redirectUrl || "/", { replace: true });
    } catch (error: any) {
      toast({
        title: "Login failed",
        description: error?.message || "Invalid credentials",
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  };

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

  if (isAuthActive === false) return null;

  return (
    <div className={styles.container}>
      <Card className={styles.card}>
        <div className={styles.header}>
          <Title2>
            <span style={{ display: "inline-flex", gap: tokens.spacingHorizontalS, alignItems: "center" }}>
              <LockClosed24Regular /> Password Required
            </span>
          </Title2>
          <Text className={styles.hint}>
            This Discogenius instance is protected by an admin password.
          </Text>
        </div>

        <div className={styles.inputRow}>
          <Input
            type="password"
            placeholder="Admin password"
            value={password}
            onChange={(_, data) => setPassword(data.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            disabled={submitting}
          />
          <Button appearance="primary" onClick={submit} disabled={submitting}>
            {submitting ? "Signing in…" : "Sign in"}
          </Button>
        </div>
      </Card>
    </div>
  );
}
