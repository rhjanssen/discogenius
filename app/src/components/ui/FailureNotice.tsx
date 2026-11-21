import { useState, type MouseEvent } from "react";
import {
  Button,
  Link,
  Popover,
  PopoverSurface,
  PopoverTrigger,
  Text,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import { Checkmark16Regular, Copy16Regular, ErrorCircle16Filled } from "@fluentui/react-icons";
import { useNavigate } from "react-router-dom";
import type { FailureNoticeContract } from "@contracts/status";

const useStyles = makeStyles({
  root: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXXS,
    minWidth: 0,
  },
  summaryRow: {
    display: "flex",
    alignItems: "flex-start",
    gap: tokens.spacingHorizontalXS,
    minWidth: 0,
  },
  icon: {
    flexShrink: 0,
    marginTop: "1px",
    color: tokens.colorPaletteRedForeground1,
  },
  summary: {
    color: tokens.colorPaletteRedForeground1,
    minWidth: 0,
    overflowWrap: "anywhere",
  },
  hint: {
    color: tokens.colorNeutralForeground3,
    overflowWrap: "anywhere",
  },
  actions: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: tokens.spacingHorizontalM,
  },
  detailsButton: {
    minWidth: 0,
    paddingLeft: 0,
    paddingRight: 0,
    height: "auto",
    fontWeight: tokens.fontWeightRegular,
  },
  surface: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
    maxWidth: "min(560px, calc(100vw - 32px))",
  },
  detail: {
    margin: 0,
    maxHeight: "240px",
    overflow: "auto",
    padding: tokens.spacingHorizontalS,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3,
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  },
  clamp: {
    display: "-webkit-box",
    WebkitLineClamp: 2,
    WebkitBoxOrient: "vertical",
    overflow: "hidden",
  },
});

type FailureNoticeProps = {
  failure?: FailureNoticeContract | null;
  /** Shown as-is when the server sent no structured failure (live progress text). */
  fallbackText?: string | null;
  className?: string;
};

/**
 * A failed item's reason: a short cause and next step on the card, with the
 * original error one click away for diagnosis (Fluent: short text inline,
 * longer content in a Popover).
 */
export function FailureNotice({ failure, fallbackText, className }: FailureNoticeProps) {
  const styles = useStyles();
  const navigate = useNavigate();
  const [copied, setCopied] = useState(false);

  if (!failure) {
    const text = fallbackText?.trim();
    if (!text) return null;
    return (
      <Text size={200} className={mergeClasses(styles.summary, styles.clamp, className)} title={text}>
        {text}
      </Text>
    );
  }

  const openAction = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!failure.action || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(failure.action.href);
  };

  const copyDetail = async () => {
    try {
      await navigator.clipboard.writeText(failure.detail);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className={mergeClasses(styles.root, className)}>
      <div className={styles.summaryRow}>
        <ErrorCircle16Filled className={styles.icon} aria-hidden />
        <Text size={200} weight="semibold" className={styles.summary}>{failure.summary}</Text>
      </div>
      {failure.hint ? <Text size={200} className={styles.hint}>{failure.hint}</Text> : null}
      <div className={styles.actions}>
        {failure.action ? (
          <Link href={failure.action.href} onClick={openAction}>{failure.action.label}</Link>
        ) : null}
        <Popover withArrow positioning="below-start" onOpenChange={() => setCopied(false)}>
          <PopoverTrigger disableButtonEnhancement>
            <Button appearance="transparent" size="small" className={styles.detailsButton}>
              Details
            </Button>
          </PopoverTrigger>
          <PopoverSurface className={styles.surface} aria-label="Error details">
            <pre className={styles.detail}>{failure.detail}</pre>
            <div>
              <Button
                size="small"
                icon={copied ? <Checkmark16Regular /> : <Copy16Regular />}
                onClick={() => { void copyDetail(); }}
              >
                {copied ? "Copied" : "Copy details"}
              </Button>
            </div>
          </PopoverSurface>
        </Popover>
      </div>
    </div>
  );
}
