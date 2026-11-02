import type { MouseEvent } from "react";
import {
  Button,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  MessageBarGroup,
  MessageBarTitle,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { ArrowClockwise20Regular, PlugConnected20Regular } from "@fluentui/react-icons";
import { useNavigate } from "react-router-dom";

export interface ProviderAuthBannerItem {
  provider: string;
  /** Display name, e.g. "Tidal". */
  label: string;
  /** Server copy: what is wrong, e.g. "Tidal opnieuw inloggen". */
  banner: string;
  held: number;
  /** Where the reconnect flow for this provider lives. */
  href: string;
}

interface ProviderAuthBannerProps {
  items: ProviderAuthBannerItem[];
  onRetry: () => void;
  retrying?: boolean;
}

const useStyles = makeStyles({
  group: {
    display: "flex",
    flexDirection: "column",
    rowGap: tokens.spacingVerticalS,
    marginTop: tokens.spacingVerticalM,
    marginRight: tokens.spacingHorizontalM,
    marginBottom: tokens.spacingVerticalM,
    marginLeft: tokens.spacingHorizontalM,
  },
});

export function providerAuthWaitingText(label: string, held: number): string {
  if (held === 1) return `1 album wacht tot ${label} weer verbonden is.`;
  if (held > 1) return `${held.toLocaleString("nl-NL")} albums wachten tot ${label} weer verbonden is.`;
  return `Downloads via ${label} wachten tot ${label} weer verbonden is.`;
}

/** Provider connection problems, one Fluent MessageBar per provider. Copy comes from the server. */
export function ProviderAuthBanner({ items, onRetry, retrying = false }: ProviderAuthBannerProps) {
  const styles = useStyles();
  const navigate = useNavigate();
  if (items.length === 0) return null;

  const openReconnect = (href: string) => (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    navigate(href);
  };

  return (
    <MessageBarGroup className={styles.group} aria-label="Providerverbindingen">
      {items.map((item) => (
        <MessageBar key={item.provider} intent="warning" layout="multiline" politeness="assertive">
          <MessageBarBody>
            <MessageBarTitle>{item.banner}</MessageBarTitle>
            {providerAuthWaitingText(item.label, item.held)}
          </MessageBarBody>
          <MessageBarActions>
            <Button
              as="a"
              href={item.href}
              onClick={openReconnect(item.href)}
              appearance="primary"
              size="small"
              icon={<PlugConnected20Regular />}
            >
              Opnieuw verbinden
            </Button>
            <Button
              appearance="secondary"
              size="small"
              icon={<ArrowClockwise20Regular />}
              onClick={onRetry}
              disabledFocusable={retrying}
            >
              {retrying ? "Bezig…" : "Opnieuw proberen"}
            </Button>
          </MessageBarActions>
        </MessageBar>
      ))}
    </MessageBarGroup>
  );
}
