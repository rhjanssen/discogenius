import React, { useRef, useState, useEffect, useCallback } from "react";
import {
    Text,
    makeStyles,
    tokens,
} from "@fluentui/react-components";
import { formatDurationSeconds } from "@/utils/format";

interface AudioPlayerProps {
    src: string;
    /** Known total duration in seconds (e.g. from DB metadata).
     *  Used as display fallback until the audio element reports its own duration. */
    knownDuration?: number;
    onEnded?: () => void;
    onPlaybackError?: () => void;
    autoPlay?: boolean;
}

const useStyles = makeStyles({
    container: {
        display: "flex",
        alignItems: "center",
        gap: tokens.spacingHorizontalS,
        padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalS}`,
        backgroundColor: tokens.colorNeutralBackgroundAlpha2,
        backdropFilter: "blur(10px)",
        borderRadius: tokens.borderRadiusMedium,
        border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStrokeAlpha2}`,
        width: "100%",
        boxSizing: "border-box",
        "@media (min-width: 640px)": {
            padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
        },
    },
    timeText: {
        fontSize: tokens.fontSizeBase200,
        color: tokens.colorNeutralForeground3,
        fontFamily: tokens.fontFamilyMonospace,
        minWidth: "36px",
        textAlign: "center",
        userSelect: "none",
        flexShrink: 0,
    },
    scrubberContainer: {
        flex: 1,
        display: "flex",
        alignItems: "center",
        height: "24px",
        cursor: "pointer",
        position: "relative",
        touchAction: "none",
    },
    scrubberTrack: {
        width: "100%",
        height: "4px",
        backgroundColor: tokens.colorNeutralStroke2,
        borderRadius: tokens.borderRadiusCircular,
        position: "relative",
        overflow: "hidden",
    },
    scrubberFill: {
        height: "100%",
        backgroundColor: tokens.colorBrandForeground1,
        borderRadius: tokens.borderRadiusCircular,
        transition: "width 0.1s linear",
    },
    scrubberHandle: {
        position: "absolute",
        top: "50%",
        width: "12px",
        height: "12px",
        borderRadius: tokens.borderRadiusCircular,
        backgroundColor: tokens.colorBrandForeground1,
        transform: "translate(-50%, -50%)",
        boxShadow: tokens.shadow4,
        transition: "transform 0.1s ease",
        ":hover": {
            transform: "translate(-50%, -50%) scale(1.2)",
        },
    },
});

export const AudioPlayer: React.FC<AudioPlayerProps> = ({
    src,
    knownDuration,
    onEnded,
    onPlaybackError,
    autoPlay = true,
}) => {
    const styles = useStyles();
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const scrubberRef = useRef<HTMLDivElement>(null);
    const [currentTime, setCurrentTime] = useState(0);
    const [audioDuration, setAudioDuration] = useState(0);
    const [isDragging, setIsDragging] = useState(false);
    const playbackErrorHandledRef = useRef(false);

    const duration = (() => {
        const hasKnownDuration = Boolean(knownDuration && Number.isFinite(knownDuration) && knownDuration > 0);
        const hasReportedDuration = Boolean(audioDuration && Number.isFinite(audioDuration) && audioDuration > 0);

        if (!hasKnownDuration) {
            return hasReportedDuration ? audioDuration : 0;
        }

        if (!hasReportedDuration) {
            return knownDuration ?? 0;
        }

        const drift = Math.abs(audioDuration - (knownDuration ?? 0));
        const acceptableDrift = Math.max(2, (knownDuration ?? 0) * 0.05);

        return drift <= acceptableDrift ? audioDuration : (knownDuration ?? 0);
    })();

    const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

    useEffect(() => {
        const audio = new Audio(src);
        audioRef.current = audio;
        audio.preload = "metadata";
        playbackErrorHandledRef.current = false;

        const onTimeUpdate = () => {
            if (!isDragging) setCurrentTime(audio.currentTime);
        };
        const onLoadedMetadata = () => setAudioDuration(audio.duration);
        const onDurationChange = () => setAudioDuration(audio.duration);
        const onError = () => {
            if (playbackErrorHandledRef.current) {
                return;
            }

            playbackErrorHandledRef.current = true;
            onPlaybackError?.();
        };
        const onEndedHandler = () => {
            setCurrentTime(0);
            onEnded?.();
        };

        audio.addEventListener("timeupdate", onTimeUpdate);
        audio.addEventListener("loadedmetadata", onLoadedMetadata);
        audio.addEventListener("ended", onEndedHandler);
        audio.addEventListener("durationchange", onDurationChange);
        audio.addEventListener("error", onError);

        if (autoPlay) {
            audio.play().catch(() => { });
        }

        return () => {
            audio.pause();
            audio.removeEventListener("timeupdate", onTimeUpdate);
            audio.removeEventListener("loadedmetadata", onLoadedMetadata);
            audio.removeEventListener("ended", onEndedHandler);
            audio.removeEventListener("durationchange", onDurationChange);
            audio.removeEventListener("error", onError);
            audio.src = "";
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [onEnded, onPlaybackError, src]);

    const seekToPosition = useCallback(
        (clientX: number) => {
            if (!scrubberRef.current || !audioRef.current || duration === 0) return;
            const rect = scrubberRef.current.getBoundingClientRect();
            const fraction = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
            const newTime = fraction * duration;
            audioRef.current.currentTime = newTime;
            setCurrentTime(newTime);
        },
        [duration]
    );

    const handleMouseDown = (e: React.MouseEvent) => {
        setIsDragging(true);
        seekToPosition(e.clientX);

        const handleMouseMove = (ev: MouseEvent) => seekToPosition(ev.clientX);
        const handleMouseUp = () => {
            setIsDragging(false);
            window.removeEventListener("mousemove", handleMouseMove);
            window.removeEventListener("mouseup", handleMouseUp);
        };

        window.addEventListener("mousemove", handleMouseMove);
        window.addEventListener("mouseup", handleMouseUp);
    };

    const handleTouchStart = (e: React.TouchEvent) => {
        setIsDragging(true);
        seekToPosition(e.touches[0].clientX);

        const handleTouchMove = (ev: TouchEvent) => {
            ev.preventDefault();
            seekToPosition(ev.touches[0].clientX);
        };
        const handleTouchEnd = () => {
            setIsDragging(false);
            window.removeEventListener("touchmove", handleTouchMove);
            window.removeEventListener("touchend", handleTouchEnd);
        };

        window.addEventListener("touchmove", handleTouchMove, { passive: false });
        window.addEventListener("touchend", handleTouchEnd);
    };

    return (
        <div className={styles.container}>
            <Text className={styles.timeText}>{formatDurationSeconds(currentTime)}</Text>
            <div
                ref={scrubberRef}
                className={styles.scrubberContainer}
                onMouseDown={handleMouseDown}
                onTouchStart={handleTouchStart}
            >
                <div className={styles.scrubberTrack}>
                    <div className={styles.scrubberFill} style={{ width: `${progress}%` }} />
                </div>
                <div
                    className={styles.scrubberHandle}
                    style={{ left: `${progress}%` }}
                />
            </div>
            <Text className={styles.timeText}>{formatDurationSeconds(duration)}</Text>
        </div>
    );
};
