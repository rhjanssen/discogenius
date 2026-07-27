import { makeStyles, mergeClasses, tokens } from "@fluentui/react-components";

const useStyles = makeStyles({
  track: {
    position: "relative",
    width: "100%",
    minWidth: "56px",
    maxWidth: "120px",
    height: "18px",
    borderRadius: tokens.borderRadiusCircular,
    overflow: "hidden",
    backgroundColor: `color-mix(in srgb, ${tokens.colorBrandBackground} 20%, transparent)`,
  },
  trackComplete: {
    backgroundColor: `color-mix(in srgb, ${tokens.colorPaletteGreenBackground3} 20%, transparent)`,
  },
  fill: {
    position: "absolute",
    insetBlock: 0,
    left: 0,
    borderRadius: tokens.borderRadiusCircular,
    backgroundColor: tokens.colorBrandBackground,
    transition: `width ${tokens.durationSlow} ${tokens.curveEasyEase}`,
  },
  fillComplete: {
    backgroundColor: tokens.colorPaletteGreenBackground3,
  },
  label: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    height: "100%",
    paddingInline: tokens.spacingHorizontalXXS,
    fontSize: tokens.fontSizeBase100,
    fontWeight: tokens.fontWeightSemibold,
    fontVariantNumeric: "tabular-nums",
    color: tokens.colorNeutralForeground1,
    whiteSpace: "nowrap",
    textShadow: "0 1px 2px rgba(0,0,0,0.35)",
  },
});

export function CompletionProgressPill({
  value,
  total,
  title,
  className,
}: {
  value: number;
  total: number;
  title?: string;
  className?: string;
}) {
  const styles = useStyles();
  const normalizedValue = Number.isFinite(value) ? Math.max(0, value) : 0;
  const normalizedTotal = Number.isFinite(total) ? Math.max(0, total) : 0;
  const percent = normalizedTotal > 0
    ? Math.min(100, Math.round((normalizedValue / normalizedTotal) * 100))
    : 0;
  const complete = normalizedTotal > 0 && normalizedValue >= normalizedTotal;
  const accessibleTitle = title || `${normalizedValue} of ${normalizedTotal}`;

  return (
    <div
      className={mergeClasses(styles.track, complete ? styles.trackComplete : undefined, className)}
      role="progressbar"
      aria-valuenow={normalizedValue}
      aria-valuemin={0}
      aria-valuemax={normalizedTotal}
      aria-label={accessibleTitle}
      title={accessibleTitle}
    >
      <div
        className={mergeClasses(styles.fill, complete ? styles.fillComplete : undefined)}
        style={{ width: `${percent}%` }}
      />
      <span className={styles.label}>{normalizedValue} / {normalizedTotal}</span>
    </div>
  );
}
