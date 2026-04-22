import { makeStyles, mergeClasses, tokens } from "@fluentui/react-components";

type LoadingIndicatorProps = {
  className?: string;
  rippleClassName?: string;
  size?: number;
};

const useStyles = makeStyles({
  loading: {
    marginTop: tokens.spacingVerticalM,
    textAlign: "center",
  },
  rippleContainer: {
    position: "relative",
    display: "inline-block",
  },
  ripple: {
    position: "absolute",
    inset: 0,
    borderRadius: "100%",
    border: `2px solid ${tokens.colorBrandForeground1}`,
    animationName: {
      "0%": {
        opacity: 1,
        transform: "scale(0.1)",
      },
      "70%": {
        opacity: 0.7,
        transform: "scale(1)",
      },
      "100%": {
        opacity: 0,
      },
    },
    animationDuration: "1.25s",
    animationIterationCount: "infinite",
    animationTimingFunction: "cubic-bezier(0.21, 0.53, 0.56, 0.8)",
    animationFillMode: "both",
  },
});

export default function LoadingIndicator({
  className,
  rippleClassName,
  size = 50,
}: LoadingIndicatorProps) {
  const styles = useStyles();
  const sizeInPx = `${size}px`;

  return (
    <div className={mergeClasses(styles.loading, className)} style={{ height: sizeInPx }}>
      <div className={styles.rippleContainer} style={{ width: sizeInPx, height: sizeInPx }}>
        {[0, 1, 2].map((index) => (
          <div
            key={index}
            className={mergeClasses(styles.ripple, rippleClassName)}
            style={{
              width: sizeInPx,
              height: sizeInPx,
              animationDelay: `${index * 0.2}s`,
            }}
          />
        ))}
      </div>
    </div>
  );
}
