import React, { useRef, useState, useEffect, useCallback } from "react";
import {
    Button,
    Text,
    makeStyles,
    tokens,
} from "@fluentui/react-components";
import {
  Pause24Filled,
  Play24Regular,
  Play24Filled,
  bundleIcon
} from "@fluentui/react-icons";
// Audio playback only needs the standard HLS pipeline. The full hls.js build
// pulled subtitle, alternate-audio, EME, and interstitial controllers into a
// shared lazy route chunk, adding more than 500 kB of minified code to pages
// that never opened the player.
import Hls from "hls.js/dist/hls.light.mjs";
import { formatDurationSeconds } from "@/utils/format";
import { glassButtonStyles } from "@/components/ui/glassButtonStyles";

const Play24 = bundleIcon(Play24Filled, Play24Regular);

interface AudioPlayerProps {
    src: string;
    /** Optional HLS playlist for the same source. Preferred when supported so
     *  segmented provider previews stream/seek without buffering the whole
     *  track; falls back to `src` on any fatal HLS error (including
     *  progressive-only sources, which report 409 on the playlist URL). */
    hlsSrc?: string;
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
        backgroundColor: `color-mix(in srgb, ${tokens.colorNeutralBackgroundAlpha2} 82%, transparent)`,
        backdropFilter: "blur(14px) saturate(115%)",
        WebkitBackdropFilter: "blur(14px) saturate(115%)",
        borderRadius: tokens.borderRadiusMedium,
        border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStrokeAlpha2}`,
        boxShadow: tokens.shadow4,
        width: "100%",
        boxSizing: "border-box",
        "@media (min-width: 640px)": {
            padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
        },
    },
    playButton: {
        ...glassButtonStyles,
        flexShrink: 0,
        color: tokens.colorNeutralForeground1,
        ":hover": {
            color: tokens.colorNeutralForeground1,
        },
        ":active": {
            color: tokens.colorBrandForeground2,
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
        borderRadius: tokens.borderRadiusMedium,
        ":focus-visible": {
            outlineStyle: "solid",
            outlineWidth: tokens.strokeWidthThick,
            outlineColor: tokens.colorBrandStroke1,
            outlineOffset: tokens.strokeWidthThin,
        },
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
        backgroundColor: tokens.colorBrandBackground,
        borderRadius: tokens.borderRadiusCircular,
        transition: "width 0.1s linear",
    },
    scrubberHandle: {
        position: "absolute",
        top: "50%",
        width: "12px",
        height: "12px",
        borderRadius: tokens.borderRadiusCircular,
        backgroundColor: tokens.colorBrandBackground,
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
    hlsSrc,
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
    const [hlsFailed, setHlsFailed] = useState(false);
    const playbackErrorHandledRef = useRef(false);
    const isDraggingRef = useRef(false);
    const onEndedRef = useRef(onEnded);
    const onPlaybackErrorRef = useRef(onPlaybackError);

    useEffect(() => {
        setHlsFailed(false);
    }, [src, hlsSrc]);

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

    const progress = duration > 0
        ? Math.max(0, Math.min(100, (currentTime / duration) * 100))
        : 0;

    const useHlsSource = Boolean(hlsSrc) && !hlsFailed && Hls.isSupported();

    useEffect(() => {
        const audio = audioRef.current;
        if (!audio) {
            return;
        }

        playbackErrorHandledRef.current = false;
        setCurrentTime(0);
        setAudioDuration(0);
        setIsPlaying(false);
        let isFallingBackFromHls = false;

        const onTimeUpdate = () => {
            if (!isDraggingRef.current) setCurrentTime(audio.currentTime);
        };
        const onLoadedMetadata = () => setAudioDuration(audio.duration);
        const onDurationChange = () => setAudioDuration(audio.duration);
        const onPlay = () => setIsPlaying(true);
        const onPause = () => setIsPlaying(false);
        const onError = () => {
            // Destroying a failed MediaSource can emit an <audio> error. That
            // belongs to the internal HLS -> progressive fallback, not to the
            // track-level source fallback handled by the parent.
            if (isFallingBackFromHls) {
                return;
            }

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

        let hls: Hls | null = null;
        if (useHlsSource && hlsSrc) {
            hls = new Hls({
                enableWorker: true,
                // Provider segments can be cold on the first play while a
                // catalog refresh is contending for resources. Hls.js's
                // shorter defaults turned that temporary delay into a fatal
                // error, even though the same preview worked moments later on
                // the album page after its segments had warmed the cache.
                manifestLoadingTimeOut: 60_000,
                levelLoadingTimeOut: 60_000,
                fragLoadingTimeOut: 60_000,
                manifestLoadingMaxRetry: 2,
                levelLoadingMaxRetry: 2,
                fragLoadingMaxRetry: 2,
            });
            hls.on(Hls.Events.ERROR, (_event, data) => {
                if (!data.fatal) {
                    return;
                }
                // Progressive-only sources answer the playlist with 409; any
                // other fatal error also drops us back to the proxied stream.
                isFallingBackFromHls = true;
                hls?.destroy();
                setHlsFailed(true);
            });
            hls.loadSource(hlsSrc);
            hls.attachMedia(audio);
        } else {
            audio.src = src;
            audio.load();
        }

        if (autoPlay) {
            void audio.play().catch(() => {
                setIsPlaying(false);
            });
        }

        return () => {
            audio.pause();
            hls?.destroy();
            audio.removeAttribute("src");
            audio.removeEventListener("timeupdate", onTimeUpdate);
            audio.removeEventListener("loadedmetadata", onLoadedMetadata);
            audio.removeEventListener("ended", onEndedHandler);
            audio.removeEventListener("durationchange", onDurationChange);
            audio.removeEventListener("play", onPlay);
            audio.removeEventListener("pause", onPause);
            audio.removeEventListener("error", onError);
        };
    }, [autoPlay, src, hlsSrc, useHlsSource]);

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

    const seekToTime = useCallback((requestedTime: number) => {
        if (!audioRef.current || duration <= 0) {
            return;
        }

        const nextTime = Math.max(0, Math.min(duration, requestedTime));
        audioRef.current.currentTime = nextTime;
        setCurrentTime(nextTime);
    }, [duration]);

    const handleSeekKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
        const seekStepSeconds = Math.min(5, Math.max(1, Math.round(duration / 100)));
        let nextTime: number | undefined;

        switch (event.key) {
            case "ArrowLeft":
            case "ArrowDown":
                nextTime = currentTime - seekStepSeconds;
                break;
            case "ArrowRight":
            case "ArrowUp":
                nextTime = currentTime + seekStepSeconds;
                break;
            case "Home":
                nextTime = 0;
                break;
            case "End":
                nextTime = duration;
                break;
            default:
                return;
        }

        event.preventDefault();
        seekToTime(nextTime);
    }, [currentTime, duration, seekToTime]);

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
            {/* eslint-disable-next-line jsx-a11y/media-has-caption -- Audio tracks have no caption resource. */}
            <audio
                ref={audioRef}
                className={styles.audioElement}
                preload="metadata"
                playsInline
                aria-hidden="true"
                tabIndex={-1}
            />
            <Button
                appearance="subtle"
                aria-label={isPlaying ? "Pause playback" : "Resume playback"}
                data-testid={isPlaying ? "playback-pause" : "playback-resume"}
                className={styles.playButton}
                icon={isPlaying ? <Pause24Filled /> : <Play24 />}
                onClick={handleTogglePlayback}
            />
            <Text className={styles.timeText}>{formatDurationSeconds(currentTime)}</Text>
            <div
                ref={scrubberRef}
                className={styles.scrubberContainer}
                data-testid="audio-player-scrubber"
                role="slider"
                tabIndex={duration > 0 ? 0 : -1}
                aria-label="Seek audio"
                aria-orientation="horizontal"
                aria-disabled={duration <= 0}
                aria-valuemin={0}
                aria-valuemax={duration}
                aria-valuenow={Math.max(0, Math.min(duration, currentTime))}
                aria-valuetext={`${formatDurationSeconds(currentTime)} of ${formatDurationSeconds(duration)}`}
                onMouseDown={handleMouseDown}
                onTouchStart={handleTouchStart}
                onKeyDown={handleSeekKeyDown}
            >
                <div className={styles.scrubberTrack}>
                    <div className={styles.scrubberFill} style={{ width: `${progress}%` }} />
                </div>
                <div
                    className={styles.scrubberHandle}
                    style={{ left: `${progress}%` }}
                    aria-hidden="true"
                />
            </div>
            <Text className={styles.timeText}>{formatDurationSeconds(duration)}</Text>
        </div>
    );
};
