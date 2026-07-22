import type { MouseEvent } from "react";
import { Button, makeStyles, mergeClasses, tokens } from "@fluentui/react-components";
import {
  ArrowDownload24Regular,
  Eye24Regular,
  EyeOff24Regular,
  Info24Regular,
  LockClosed24Regular,
  LockOpen24Regular,
  Play24Regular,
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
import { glassButtonStyles } from "@/components/ui/glassButtonStyles";
import { AppTooltip } from "@/components/ui/AppTooltip";

const ArrowDownload24 = bundleIcon(ArrowDownload24Filled, ArrowDownload24Regular);
const Eye24 = bundleIcon(Eye24Filled, Eye24Regular);
const EyeOff24 = bundleIcon(EyeOff24Filled, EyeOff24Regular);
const Info24 = bundleIcon(Info24Filled, Info24Regular);
const LockClosed24 = bundleIcon(LockClosed24Filled, LockClosed24Regular);
const LockOpen24 = bundleIcon(LockOpen24Filled, LockOpen24Regular);
const Play24 = bundleIcon(Play24Filled, Play24Regular);

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
  actionButton: {
    ...glassButtonStyles,
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
        <AppTooltip content={isPlaying ? "Stop" : "Play"} relationship="label">
          <Button
            appearance="subtle"
            aria-label={isPlaying ? "Stop track" : "Play track"}
            icon={isPlaying ? <Stop24Filled /> : <Play24 />}
            size="small"
            onClick={onPlay}
            className={styles.actionButton}
          />
        </AppTooltip>
      ) : null}

      {onToggleMonitor ? (
        <AppTooltip
          content={isLocked ? "Unlock to change" : (isMonitored ? "Stop monitoring" : "Start monitoring")}
          relationship="label"
        >
          <Button
            appearance="subtle"
            icon={isMonitored ? <EyeOff24 /> : <Eye24 />}
            size="small"
            disabled={isLocked}
            onClick={onToggleMonitor}
            className={styles.actionButton}
          />
        </AppTooltip>
      ) : null}

      {onToggleLock ? (
        <AppTooltip content={isLocked ? "Unlock" : "Lock"} relationship="label">
          <Button
            appearance="subtle"
            icon={isLocked ? <LockOpen24 /> : <LockClosed24 />}
            size="small"
            onClick={onToggleLock}
            className={styles.actionButton}
          />
        </AppTooltip>
      ) : null}

      {/* One trailing action that toggles by state: a download button until the
          track is downloaded, then a file-info button (no kebab, no checkmark). */}
      {(isDownloaded || canShowInfo) ? (
        <AppTooltip content="Track info" relationship="label">
          <Button
            appearance="subtle"
            icon={<Info24 />}
            size="small"
            onClick={onShowInfo}
            className={styles.actionButton}
          />
        </AppTooltip>
      ) : showDownload ? (
        <AppTooltip content={onDownload ? "Download track" : "No provider offer available"} relationship="label">
          <Button
            appearance="subtle"
            aria-label="Download track"
            icon={<ArrowDownload24 />}
            size="small"
            disabled={isDownloading || !onDownload}
            onClick={onDownload}
            className={styles.actionButton}
          />
        </AppTooltip>
      ) : null}
    </div>
  );
}
