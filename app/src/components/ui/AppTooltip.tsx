import type { ReactElement, ReactNode } from "react";
import { isValidElement } from "react";
import {
  Tooltip,
  makeStyles,
  mergeClasses,
  type TooltipProps,
} from "@fluentui/react-components";

/**
 * Discogenius Fluent UI v9 tooltip convention:
 *
 * - Interactive controls (icon buttons, toggles): `relationship="label"` —
 *   the tooltip is the accessible name (or supplements a short aria-label).
 * - Rich / multi-line descriptions (quality offers, help copy):
 *   `relationship="description"` + `withArrow`.
 *
 * Prefer this wrapper over native `title=` on interactive controls so hover
 * and keyboard focus share one Fluent surface. Truncated text overflow may
 * still use native `title=` where a Fluent portal would be noisy.
 *
 * Width: Fluent's content slot defaults to `max-width: 240px`, which wraps
 * short quality strings like `Dolby Digital Plus 5.1 + Dolby Atmos · 768 kbps`
 * early. Every AppTooltip raises that to a shared 400px budget so content
 * grows with the string and only wraps when the cap (or viewport) requires it.
 */
export type AppTooltipProps = Omit<TooltipProps, "children" | "relationship"> & {
  /** Defaults to `label` for control tooltips. */
  relationship?: TooltipProps["relationship"];
  children: ReactElement;
};

const useStyles = makeStyles({
  content: {
    maxWidth: "400px",
  },
});

/** True when `content` is a Fluent slot shorthand object (not a React node). */
function isContentSlotObject(
  content: TooltipProps["content"],
): content is Extract<TooltipProps["content"], object> & { className?: string; children?: ReactNode } {
  return (
    content != null
    && typeof content === "object"
    && !Array.isArray(content)
    && !isValidElement(content)
  );
}

function withSharedContentWidth(
  content: TooltipProps["content"],
  contentClassName: string,
): TooltipProps["content"] {
  if (content == null) {
    return content;
  }
  if (isContentSlotObject(content)) {
    return {
      ...content,
      className: mergeClasses(contentClassName, content.className),
    };
  }
  return {
    children: content as ReactNode,
    className: contentClassName,
  };
}

export function AppTooltip({
  relationship = "label",
  withArrow,
  content,
  children,
  ...rest
}: AppTooltipProps) {
  const styles = useStyles();
  return (
    <Tooltip
      relationship={relationship}
      withArrow={withArrow}
      content={withSharedContentWidth(content, styles.content)}
      {...rest}
    >
      {children}
    </Tooltip>
  );
}
