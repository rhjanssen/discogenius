import { Title3, makeStyles, tokens } from "@fluentui/react-components";
import LoadingIndicator from "@/components/loading/LoadingIndicator";
import LoadingMessage from "@/components/loading/LoadingMessage";

const logo = "/assets/images/logo.png";

const useStyles = makeStyles({
  root: {
    minHeight: "100dvh",
    width: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: tokens.spacingHorizontalXL,
    boxSizing: "border-box",
    backgroundColor: tokens.colorNeutralBackground1,
  },
  panel: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: tokens.spacingVerticalM,
    textAlign: "center",
  },
  logo: {
    width: "48px",
    height: "48px",
    objectFit: "contain",
    opacity: 0.8,
  },
});

export function BootLoadingPage() {
  const styles = useStyles();

  return (
    <div className={styles.root} role="status" aria-live="polite" aria-label="Loading Discogenius">
      <div className={styles.panel}>
        <img src={logo} alt="" className={styles.logo} />
        <Title3>Discogenius</Title3>
        <LoadingMessage />
        <LoadingIndicator />
      </div>
    </div>
  );
}

export default BootLoadingPage;
