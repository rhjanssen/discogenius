import type { MouseEvent } from "react";
import { Button, Tooltip, makeStyles, mergeClasses, tokens } from "@fluentui/react-components";
import {
  ArrowDownload24Regular as ArrowDownload24RegularBase,
  Eye24Regular as Eye24RegularBase,
  EyeOff24Regular as EyeOff24RegularBase,
  Info24Regular as Info24RegularBase,
  LockClosed24Regular as LockClosed24RegularBase,
  LockOpen24Regular as LockOpen24RegularBase,
  Play24Regular as Play24RegularBase,
  Stop24Filled,
  ArrowDownload24Filled,
  Eye24Filled,
  EyeOff24Filled,
  Info24Filled,
  LockClosed24Filled,
  LockOpen24Filled,
  Play24Filled,
  bundleIcon
} from "@fluentui/react-icons";

const ArrowDownload24Regular = bundleIcon(ArrowDownload24Filled, ArrowDownload24RegularBase);
const Eye24Regular = bundleIcon(Eye24Filled, Eye24RegularBase);
const EyeOff24Regular = bundleIcon(EyeOff24Filled, EyeOff24RegularBase);
const Info24Regular = bundleIcon(Info24Filled, Info24RegularBase);
const LockClosed24Regular = bundleIcon(LockClosed24Filled, LockClosed24RegularBase);
const LockOpen24Regular = bundleIcon(LockOpen24Filled, LockOpen24RegularBase);
const Play24Regular = bundleIcon(Play24Filled, Play24RegularBase);

interface TrackRowActionsProps {
  isPlaying?: boolean;
  isMonitored: boolean;
  isLocked: boolean;
  isDownloaded: boolean;
  isDownloading?: boolean;
  canShowInfo: boolean;
  showDownload?: boolean;
  /** When provided, an inline play/stop button is shown (e.g. library list). The
      album tracklist omits this and uses the number↔play hover control instead. */
  onPlay?: (event: MouseEvent<HTMLButtonElement>) => void;
  onToggleMonitor?: (event: MouseEvent<HTMLButtonElement>) => void;
  onToggleLock?: (event: MouseEvent<HTMLButtonElement>) => void;
  onShowInfo?: (event: MouseEvent<HTMLButtonElement>) => void;
  onDownload?: (event: MouseEvent<HTMLButtonElement>) => void;
  className?: string;
}

const useStyles = makeStyles({
  root: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
  },
});

export function TrackRowActions({
  isPlaying = false,
  isMonitored,
  isLocked,
  isDownloaded,
  isDownloading = false,
  canShowInfo,
  showDownload = false,
  onPlay,
  onToggleMonitor,
  onToggleLock,
  onShowInfo,
  onDownload,
  className,
}: TrackRowActionsProps) {
  const styles = useStyles();

  return (
    <div className={mergeClasses(styles.root, className)}>
      {onPlay ? (
        <Tooltip content={isPlaying ? "Stop" : "Play"} relationship="label">
          <Button
            appearance="subtle"
            aria-label={isPlaying ? "Stop track" : "Play track"}
            icon={isPlaying ? <Stop24Filled /> : <Play24Regular />}
            size="small"
            onClick={onPlay}
          />
        </Tooltip>
      ) : null}

      {onToggleMonitor ? (
        <Tooltip
          content={isLocked ? "Unlock to change" : (isMonitored ? "Stop monitoring" : "Start monitoring")}
          relationship="label"
        >
          <Button
            appearance="subtle"
            icon={isMonitored ? <EyeOff24Regular /> : <Eye24Regular />}
            size="small"
            disabled={isLocked}
            onClick={onToggleMonitor}
          />
        </Tooltip>
      ) : null}

      {onToggleLock ? (
        <Tooltip content={isLocked ? "Unlock" : "Lock"} relationship="label">
          <Button
            appearance="subtle"
            icon={isLocked ? <LockOpen24Regular /> : <LockClosed24Regular />}
            size="small"
            onClick={onToggleLock}
          />
        </Tooltip>
      ) : null}

      {/* One trailing action that toggles by state: a download button until the
          track is downloaded, then a file-info button (no kebab, no checkmark). */}
      {(isDownloaded || canShowInfo) ? (
        <Tooltip content="Track info" relationship="label">
          <Button
            appearance="subtle"
            icon={<Info24Regular />}
            size="small"
            onClick={onShowInfo}
          />
        </Tooltip>
      ) : showDownload ? (
        <Tooltip content={onDownload ? "Download track" : "No provider offer available"} relationship="label">
          <Button
            appearance="subtle"
            aria-label="Download track"
            icon={<ArrowDownload24Regular />}
            size="small"
            disabled={isDownloading || !onDownload}
            onClick={onDownload}
          />
        </Tooltip>
      ) : null}
    </div>
  );
}
