import { Warning24Regular } from "@fluentui/react-icons";
import { makeStyles, tokens } from "@fluentui/react-components";
import { Link } from "react-router-dom";

export interface ProviderAuthBannerItem {
  provider: string;
  banner: string;
  held: number;
  href: string;
  settingsLabel: string;
}

interface ProviderAuthBannerProps {
  items: ProviderAuthBannerItem[];
  onRetry: () => void;
  retrying?: boolean;
}

const useStyles = makeStyles({
  banner: {
    display: "flex",
    flexDirection: "column",
    gap: "12px",
    margin: "12px",
    padding: "16px 20px",
    borderTopWidth: "3px",
    borderRightWidth: "3px",
    borderBottomWidth: "3px",
    borderLeftWidth: "3px",
    borderTopStyle: "solid",
    borderRightStyle: "solid",
    borderBottomStyle: "solid",
    borderLeftStyle: "solid",
    borderTopColor: tokens.colorPaletteDarkOrangeBorderActive,
    borderRightColor: tokens.colorPaletteDarkOrangeBorderActive,
    borderBottomColor: tokens.colorPaletteDarkOrangeBorderActive,
    borderLeftColor: tokens.colorPaletteDarkOrangeBorderActive,
    backgroundColor: tokens.colorPaletteDarkOrangeBackground2,
    color: tokens.colorNeutralForeground1,
    borderRadius: tokens.borderRadiusMedium,
    "@media (forced-colors: active)": {
      forcedColorAdjust: "none",
      borderTopColor: "CanvasText",
      borderRightColor: "CanvasText",
      borderBottomColor: "CanvasText",
      borderLeftColor: "CanvasText",
      backgroundColor: "Canvas",
      color: "CanvasText",
    },
  },
  title: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    margin: 0,
    fontSize: "1.5rem",
    fontWeight: 700,
    lineHeight: 1.3,
  },
  item: {
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  action: {
    margin: 0,
    fontSize: "1.25rem",
    fontWeight: 700,
    lineHeight: 1.35,
  },
  held: {
    margin: "4px 0 0",
    fontSize: "1.125rem",
    lineHeight: 1.4,
  },
  link: {
    display: "inline-block",
    marginTop: "6px",
    fontSize: "1.125rem",
    fontWeight: 700,
    lineHeight: 1.4,
    color: "inherit",
    textDecoration: "underline",
  },
  retry: {
    alignSelf: "flex-start",
    minHeight: "48px",
    padding: "10px 18px",
    fontSize: "1.125rem",
    fontWeight: 700,
    border: "2px solid currentColor",
    backgroundColor: "transparent",
    color: "inherit",
    cursor: "pointer",
  },
});

function heldLabel(held: number): string {
  if (held === 1) return "1 album wacht";
  return `${held} albums wachten`;
}

/** Login-needed banner. Copy for each provider comes from the server. */
export function ProviderAuthBanner({ items, onRetry, retrying = false }: ProviderAuthBannerProps) {
  const styles = useStyles();
  if (items.length === 0) return null;

  return (
    <section className={styles.banner} role="alert" aria-label="Actie nodig">
      <p className={styles.title}>
        <Warning24Regular aria-hidden="true" />
        Actie nodig
      </p>
      <ul style={{ margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "12px" }}>
        {items.map((item) => (
          <li key={item.provider} className={styles.item}>
            <p className={styles.action}>{item.banner}</p>
            <p className={styles.held}>{heldLabel(item.held)}</p>
            <Link className={styles.link} to={item.href}>
              {item.settingsLabel}
            </Link>
          </li>
        ))}
      </ul>
      <button type="button" className={styles.retry} onClick={onRetry} disabled={retrying}>
        {retrying ? "Bezig…" : "Mislukte albums opnieuw proberen"}
      </button>
    </section>
  );
}
