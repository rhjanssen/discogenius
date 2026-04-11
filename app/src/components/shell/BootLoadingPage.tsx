import { Text, Title3, makeStyles, tokens } from "@fluentui/react-components";

const logo = "/assets/images/logo.png";

const loadingMessages = [
  "Teaching the hamsters lossless audio.",
  "Calibrating the Dolby atoms.",
  "Indexing the good bits.",
  "Negotiating with the download gremlins.",
  "Polishing album art you haven't seen yet.",
  "Asking TIDAL nicely for metadata.",
  "Sorting tracks by vibes.",
  "Untangling artist aliases.",
  "Reticulating playlists.",
  "Loading a witty loading line.",
  "Making the queue look intentional.",
  "Warming up the little server that could.",
];

let bootMessage: string | null = null;

function getBootMessage() {
  if (!bootMessage) {
    const index = Math.floor(Math.random() * loadingMessages.length);
    bootMessage = loadingMessages[index];
  }

  return bootMessage;
}

const useStyles = makeStyles({
  root: {
    minHeight: "100dvh",
    width: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: tokens.spacingHorizontalXL,
    boxSizing: "border-box",
  },
  panel: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: tokens.spacingVerticalM,
    textAlign: "center",
    maxWidth: "520px",
  },
  logoShell: {
    position: "relative",
    width: "112px",
    height: "112px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: tokens.spacingVerticalS,
    "@media (min-width: 640px)": {
      width: "132px",
      height: "132px",
    },
  },
  logoGlow: {
    position: "absolute",
    inset: 0,
    borderRadius: tokens.borderRadiusCircular,
    backgroundImage: `radial-gradient(circle, color-mix(in srgb, ${tokens.colorBrandBackground} 44%, transparent), transparent 70%)`,
    filter: "blur(18px)",
    opacity: 0.9,
    transform: "scale(1.08)",
  },
  logo: {
    position: "relative",
    zIndex: 1,
    width: "100%",
    height: "100%",
    objectFit: "contain",
  },
  message: {
    color: tokens.colorNeutralForeground2,
    maxWidth: "32ch",
  },
  loadingBars: {
    display: "flex",
    alignItems: "flex-end",
    justifyContent: "center",
    gap: tokens.spacingHorizontalXS,
    height: "24px",
    marginTop: tokens.spacingVerticalS,
  },
  loadingBar: {
    width: "5px",
    borderRadius: tokens.borderRadiusCircular,
    backgroundColor: `color-mix(in srgb, ${tokens.colorBrandBackground} 72%, white 18%)`,
    animationName: {
      "0%, 100%": {
        opacity: 0.3,
        transform: "scaleY(0.45)",
      },
      "50%": {
        opacity: 1,
        transform: "scaleY(1)",
      },
    },
    animationDuration: "1.1s",
    animationIterationCount: "infinite",
    animationTimingFunction: "ease-in-out",
    transformOrigin: "bottom center",
  },
});

export function BootLoadingPage() {
  const styles = useStyles();
  const message = getBootMessage();

  return (
    <div className={styles.root} role="status" aria-live="polite" aria-label="Loading Discogenius">
      <div className={styles.panel}>
        <div className={styles.logoShell}>
          <div className={styles.logoGlow} aria-hidden="true" />
          <img src={logo} alt="Discogenius" className={styles.logo} />
        </div>
        <Title3>Discogenius</Title3>
        <Text className={styles.message}>{message}</Text>
        <div className={styles.loadingBars} aria-hidden="true">
          {[0, 1, 2, 3].map((index) => (
            <span
              key={index}
              className={styles.loadingBar}
              style={{
                height: `${12 + index * 3}px`,
                animationDelay: `${index * 120}ms`,
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

export default BootLoadingPage;
