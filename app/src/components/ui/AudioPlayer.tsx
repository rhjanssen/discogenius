import React, { useRef, useState, useEffect, useCallback } from "react";
import {
    Button,
    Text,
    makeStyles,
    tokens,
} from "@fluentui/react-components";
import { Pause24Filled, Play24Regular } from "@fluentui/react-icons";
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
    playButton: {
        flexShrink: 0,
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
    audioElement: {
        display: "none",
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
    const [isPlaying, setIsPlaying] = useState(false);
    const playbackErrorHandledRef = useRef(false);
    const isDraggingRef = useRef(false);
    const onEndedRef = useRef(onEnded);
    const onPlaybackErrorRef = useRef(onPlaybackError);

    useEffect(() => {
        isDraggingRef.current = isDragging;
    }, [isDragging]);

    useEffect(() => {
        onEndedRef.current = onEnded;
    }, [onEnded]);

    useEffect(() => {
        onPlaybackErrorRef.current = onPlaybackError;
    }, [onPlaybackError]);

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
        const audio = audioRef.current;
        if (!audio) {
            return;
        }

        playbackErrorHandledRef.current = false;
        setCurrentTime(0);
        setAudioDuration(0);
        setIsPlaying(false);

        const onTimeUpdate = () => {
            if (!isDraggingRef.current) setCurrentTime(audio.currentTime);
        };
        const onLoadedMetadata = () => setAudioDuration(audio.duration);
        const onDurationChange = () => setAudioDuration(audio.duration);
        const onPlay = () => setIsPlaying(true);
        const onPause = () => setIsPlaying(false);
        const onError = () => {
            if (playbackErrorHandledRef.current) {
                return;
            }

            playbackErrorHandledRef.current = true;
            setIsPlaying(false);
            onPlaybackErrorRef.current?.();
        };
        const onEndedHandler = () => {
            setCurrentTime(0);
            setIsPlaying(false);
            onEndedRef.current?.();
        };

        audio.addEventListener("timeupdate", onTimeUpdate);
        audio.addEventListener("loadedmetadata", onLoadedMetadata);
        audio.addEventListener("ended", onEndedHandler);
        audio.addEventListener("durationchange", onDurationChange);
        audio.addEventListener("play", onPlay);
        audio.addEventListener("pause", onPause);
        audio.addEventListener("error", onError);

        audio.load();

        if (autoPlay) {
            void audio.play().catch(() => {
                setIsPlaying(false);
            });
        }

        return () => {
            audio.pause();
            audio.removeEventListener("timeupdate", onTimeUpdate);
            audio.removeEventListener("loadedmetadata", onLoadedMetadata);
            audio.removeEventListener("ended", onEndedHandler);
            audio.removeEventListener("durationchange", onDurationChange);
            audio.removeEventListener("play", onPlay);
            audio.removeEventListener("pause", onPause);
            audio.removeEventListener("error", onError);
        };
    }, [autoPlay, src]);

    const handleTogglePlayback = useCallback(() => {
        const audio = audioRef.current;
        if (!audio) {
            return;
        }

        if (audio.paused) {
            void audio.play().catch(() => {
                setIsPlaying(false);
                onPlaybackErrorRef.current?.();
            });
            return;
        }

        audio.pause();
    }, []);

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
        isDraggingRef.current = true;
        setIsDragging(true);
        seekToPosition(e.clientX);

        const handleMouseMove = (ev: MouseEvent) => seekToPosition(ev.clientX);
        const handleMouseUp = () => {
            isDraggingRef.current = false;
            setIsDragging(false);
            window.removeEventListener("mousemove", handleMouseMove);
            window.removeEventListener("mouseup", handleMouseUp);
        };

        window.addEventListener("mousemove", handleMouseMove);
        window.addEventListener("mouseup", handleMouseUp);
    };

    const handleTouchStart = (e: React.TouchEvent) => {
        isDraggingRef.current = true;
        setIsDragging(true);
        seekToPosition(e.touches[0].clientX);

        const handleTouchMove = (ev: TouchEvent) => {
            ev.preventDefault();
            seekToPosition(ev.touches[0].clientX);
        };
        const handleTouchEnd = () => {
            isDraggingRef.current = false;
            setIsDragging(false);
            window.removeEventListener("touchmove", handleTouchMove);
            window.removeEventListener("touchend", handleTouchEnd);
        };

        window.addEventListener("touchmove", handleTouchMove, { passive: false });
        window.addEventListener("touchend", handleTouchEnd);
    };

    return (
        <div className={styles.container} data-testid="audio-player">
            <audio
                ref={audioRef}
                className={styles.audioElement}
                src={src}
                preload="metadata"
                playsInline
            />
            <Button
                appearance="subtle"
                aria-label={isPlaying ? "Pause playback" : "Resume playback"}
                data-testid={isPlaying ? "playback-pause" : "playback-resume"}
                className={styles.playButton}
                icon={isPlaying ? <Pause24Filled /> : <Play24Regular />}
                onClick={handleTogglePlayback}
            />
            <Text className={styles.timeText}>{formatDurationSeconds(currentTime)}</Text>
            <div
                ref={scrubberRef}
                className={styles.scrubberContainer}
                data-testid="audio-player-scrubber"
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
