import type { MouseEvent } from "react";
import { Button, Tooltip, makeStyles, mergeClasses, tokens } from "@fluentui/react-components";
import {
  ArrowDownload24Regular,
  Checkmark24Filled,
  Eye24Regular,
  EyeOff24Regular,
  Info24Regular,
  LockClosed24Regular,
  LockOpen24Regular,
  Play24Regular,
  Stop24Filled,
} from "@fluentui/react-icons";

interface TrackRowActionsProps {
  isPlaying: boolean;
  isMonitored: boolean;
  isLocked: boolean;
  isDownloaded: boolean;
  isDownloading?: boolean;
  canShowInfo: boolean;
  onPlay: (event: MouseEvent<HTMLButtonElement>) => void;
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
  isPlaying,
  isMonitored,
  isLocked,
  isDownloaded,
  isDownloading = false,
  canShowInfo,
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
      <Tooltip content={isPlaying ? "Stop" : "Play"} relationship="label">
        <Button
          appearance="subtle"
          icon={isPlaying ? <Stop24Filled /> : <Play24Regular />}
          size="small"
          onClick={onPlay}
        />
      </Tooltip>

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

      {canShowInfo ? (
        <Tooltip content="Track info" relationship="label">
          <Button
            appearance="subtle"
            icon={<Info24Regular />}
            size="small"
            onClick={onShowInfo}
          />
        </Tooltip>
      ) : onDownload ? (
        isDownloaded ? (
          <Button
            appearance="subtle"
            icon={<Checkmark24Filled />}
            size="small"
            disabled
            title="Downloaded"
          />
        ) : (
          <Tooltip content="Download track" relationship="label">
            <Button
              appearance="subtle"
              icon={<ArrowDownload24Regular />}
              size="small"
              disabled={isDownloading}
              onClick={onDownload}
            />
          </Tooltip>
        )
      ) : null}
    </div>
  );
}
