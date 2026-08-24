import { Title3, makeStyles, tokens } from "@fluentui/react-components";
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
  // The pulsing glow-backed logo IS the loading indicator on this page.
  logoContainer: {
    position: "relative",
    width: "96px",
    height: "96px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    overflow: "visible",
    animationName: {
      "0%": { transform: "scale(1)" },
      "50%": { transform: "scale(1.05)" },
      "100%": { transform: "scale(1)" },
    },
    animationDuration: "2.4s",
    animationIterationCount: "infinite",
    animationTimingFunction: "ease-in-out",
    "@media (prefers-reduced-motion: reduce)": {
      animationName: "none",
    },
  },
  logoGlow: {
    position: "absolute",
    top: "50%",
    left: "50%",
    width: "88%",
    aspectRatio: "1",
    transform: "translate(-50%, -50%)",
    backgroundImage: `url(${logo})`,
    backgroundSize: "contain",
    backgroundRepeat: "no-repeat",
    backgroundPosition: "center",
    filter: "blur(22px) saturate(1.45)",
    pointerEvents: "none",
    animationName: {
      "0%": { opacity: 0.35 },
      "50%": { opacity: 0.95 },
      "100%": { opacity: 0.35 },
    },
    animationDuration: "2.4s",
    animationIterationCount: "infinite",
    animationTimingFunction: "ease-in-out",
    "@media (prefers-reduced-motion: reduce)": {
      animationName: "none",
      opacity: 0.6,
    },
  },
  logo: {
    position: "relative",
    width: "100%",
    height: "100%",
    objectFit: "contain",
  },
});

export function BootLoadingPage() {
  const styles = useStyles();

  return (
    <div className={styles.root} role="status" aria-live="polite" aria-label="Loading Discogenius">
      <div className={styles.panel}>
        <div className={styles.logoContainer}>
          <div className={styles.logoGlow} />
          <img src={logo} alt="" className={styles.logo} />
        </div>
        <Title3 as="h1">Discogenius</Title3>
        <LoadingMessage />
      </div>
    </div>
  );
}

export default BootLoadingPage;
