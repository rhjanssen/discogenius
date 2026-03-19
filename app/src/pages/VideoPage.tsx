/**
 * Video detail page — shows video metadata, monitor/download controls,
 * and a native video player when the file is downloaded locally.
 */
import React, { useEffect, useMemo, useState, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
    Button,
    Badge,
    Text,
    Title1,
    mergeClasses,
    Title2,
    Body1,
    Card,
    makeStyles,
    tokens,
    Tooltip,
} from "@fluentui/react-components";
import {
    ArrowDownload24Regular,
    ArrowLeft24Regular,
    Checkmark24Filled,
    Eye24Regular,
    EyeOff24Regular,
    LockClosed24Regular,
    LockOpen24Regular,
    Open24Regular,
    Play24Filled,
    Video24Regular,
} from "@fluentui/react-icons";
import { api } from "@/services/api";
import { getTidalImage, getArtistPicture } from "@/utils/tidalImages";
import { tidalUrl } from "@/utils/tidalUrl";
import { formatDurationSeconds } from "@/utils/format";
import { useUltraBlurContext } from "@/providers/UltraBlurContext";
import { useTheme } from "@/providers/themeContext";
import { useToast } from "@/hooks/useToast";
import { useDownloadQueue } from "@/hooks/useDownloadQueue";
import type { Artist } from "@/hooks/useLibrary";
import type { LibraryFilesListResponseContract, VideoDetailContract } from "@contracts/media";
import { ExplicitBadge } from "@/components/ui/ExplicitBadge";
import { QualityBadge } from "@/components/ui/QualityBadge";
import { LoadingState } from "@/components/ui/LoadingState";
import {
    dispatchMonitorStateChanged,
    dispatchLibraryUpdated,
    dispatchActivityRefresh,
} from "@/utils/appEvents";

/* ------------------------------------------------------------------ */
/*  Styles                                                            */
/* ------------------------------------------------------------------ */

const useStyles = makeStyles({
    container: {
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalL,
        maxWidth: "1280px",
        width: "100%",
        margin: "0 auto",
        paddingBottom: tokens.spacingVerticalXXL,
    },
    backButton: {
        alignSelf: "flex-start",
        marginBottom: tokens.spacingVerticalS,
    },
    playerWrapper: {
        position: "relative",
        width: "100%",
        aspectRatio: "16/9",
        borderRadius: tokens.borderRadiusMedium,
        overflow: "hidden",
        backgroundColor: tokens.colorNeutralBackground3,
        flexShrink: 0,
        boxShadow: tokens.shadow16,
    },
    thumbnailImage: {
        width: "100%",
        height: "100%",
        objectFit: "cover",
        display: "block",
        cursor: "pointer",
        transition: "transform 0.2s ease",
        ":hover": {
            transform: "scale(1.02)",
        }
    },
    playOverlay: {
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "rgba(0,0,0,0.3)",
        opacity: 0.8,
        transition: "opacity 0.2s ease",
        cursor: "pointer",
        ":hover": {
            opacity: 1,
        }
    },
    thumbnailPlaceholder: {
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: tokens.colorNeutralForeground4,
    },
    videoPlayer: {
        width: "100%",
        height: "100%",
        backgroundColor: tokens.colorNeutralBackground1,
    },
    infoSection: {
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalM,
    },
    titleRow: {
        display: "flex",
        alignItems: "flex-start",
        gap: tokens.spacingHorizontalS,
        flexWrap: "wrap",
    },
    metadataRow: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        flexWrap: "wrap",
        gap: tokens.spacingVerticalM,
    },
    leftMeta: {
        display: "flex",
        alignItems: "center",
        gap: tokens.spacingHorizontalM,
        flexWrap: "wrap",
    },
    artistProfile: {
        display: "flex",
        alignItems: "center",
        gap: tokens.spacingHorizontalS,
        cursor: "pointer",
        padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
        borderRadius: tokens.borderRadiusMedium,
        transition: "background-color 0.2s",
        ":hover": {
            backgroundColor: tokens.colorNeutralBackground1Hover,
        }
    },
    artistAvatar: {
        width: "40px",
        height: "40px",
        borderRadius: "50%",
        objectFit: "cover",
    },
    metaItems: {
        display: "flex",
        alignItems: "center",
        gap: tokens.spacingHorizontalS,
        color: tokens.colorNeutralForeground2,
    },
    rightActions: {
        display: "flex",
        gap: tokens.spacingHorizontalXS,
        flexWrap: "nowrap",
        justifyContent: "center",
        width: "100%",
        marginTop: tokens.spacingVerticalS,
        alignItems: "stretch",
        "@media (min-width: 768px)": {
            justifyContent: "flex-start",
            alignItems: "center",
            gap: tokens.spacingHorizontalM,
            marginTop: tokens.spacingVerticalNone,
            flexWrap: "wrap",
            width: "auto",
        },
    },
    actionButton: {
        // Mobile: compact vertical layout, equal-width
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "flex-start",
        flex: "1 1 0",
        minWidth: 0,
        padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalXS}`,
        gap: tokens.spacingVerticalXXS,
        "& .fui-Button__content": {
            fontSize: tokens.fontSizeBase100,
            marginLeft: "0 !important",
        },
        "& .fui-Button__icon": {
            marginRight: "0",
            fontSize: tokens.fontSizeBase400,
        },
        // Tablet: slightly larger
        "@media (min-width: 480px)": {
            padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalS}`,
            "& .fui-Button__content": {
                fontSize: tokens.fontSizeBase100,
            },
            "& .fui-Button__icon": {
                fontSize: tokens.fontSizeBase500,
            },
        },
        // Desktop: normal horizontal layout, auto width
        "@media (min-width: 768px)": {
            flexDirection: "row",
            flex: "0 0 auto",
            minWidth: "auto",
            gap: tokens.spacingHorizontalNone,
            padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
            "& .fui-Button__content": {
                fontSize: tokens.fontSizeBase300,
                marginTop: "0",
                marginLeft: tokens.spacingHorizontalS,
            },
            "& .fui-Button__icon": {
                marginRight: tokens.spacingHorizontalSNudge,
                fontSize: tokens.fontSizeBase600,
            },
        },
    },
    primaryButton: {
        borderRadius: tokens.borderRadiusXLarge,
    },
    transparentButton: {
        borderRadius: tokens.borderRadiusXLarge,
    },
    fileInfo: {
        display: "flex",
        gap: tokens.spacingHorizontalM,
        flexWrap: "wrap",
        marginTop: tokens.spacingVerticalS,
        padding: tokens.spacingVerticalS,
        backgroundColor: tokens.colorNeutralBackgroundAlpha2,
        borderRadius: tokens.borderRadiusMedium,
    },
    fileBadge: {
        fontSize: tokens.fontSizeBase200,
    },
    loadingState: {
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        minHeight: "50vh",
    },
    errorState: {
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "50vh",
        gap: tokens.spacingVerticalL,
        textAlign: "center",
    },
});

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function formatFileSize(bytes?: number): string {
    if (!bytes) return "—";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/* ------------------------------------------------------------------ */
/*  Component                                                         */
/* ------------------------------------------------------------------ */

const VideoPage = () => {
    const styles = useStyles();
    const { videoId } = useParams<{ videoId: string }>();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const { toast } = useToast();
    const { setArtwork } = useUltraBlurContext();
    const { addToQueue } = useDownloadQueue();

    const [isPlaying, setIsPlaying] = useState(false);
    const [remoteStreamUrl, setRemoteStreamUrl] = useState<string | null>(null);
    const videoRef = useRef<HTMLVideoElement>(null);
    const hlsRef = useRef<{ destroy: () => void } | null>(null);

    // Fetch video data
    const {
        data: video,
        isLoading: isVideoLoading,
        error,
    } = useQuery<VideoDetailContract>({
        queryKey: ["video", videoId],
        queryFn: () => api.getVideo(videoId!),
        enabled: !!videoId,
        refetchInterval: 5_000,
    });

    // We fetch artist data to get the profile picture since it might not be in the video response
    const { data: artistData } = useQuery<Artist | null>({
        queryKey: ["artist", video?.artist_id],
        queryFn: () => api.getArtist<Artist>(video!.artist_id!).catch(() => null),
        enabled: !!video?.artist_id,
    });

    // Fetch library files for this video
    const { data: filesData } = useQuery<LibraryFilesListResponseContract>({
        queryKey: ["video-files", videoId],
        queryFn: () => api.getLibraryFiles({ mediaId: videoId! }),
        enabled: !!videoId && !!video?.is_downloaded,
    });

    const videoFile = useMemo(() => {
        const files = filesData?.items ?? [];
        return files.find((file) => file.file_type === "video");
    }, [filesData]);

    const { setBrandKeyColor } = useTheme();

    // Set UltraBlur background from cover
    useEffect(() => {
        if (video?.cover_id) {
            const url = getTidalImage(video.cover_id, "video", "large");
            if (url) setArtwork(url);
        }
        return () => {
            // Keep persistence global for videos too
        };
    }, [video?.cover_id, setArtwork, setBrandKeyColor]);

    // Toggle monitor mutation
    const toggleMonitor = useMutation({
        mutationFn: (nextMonitored: boolean) =>
            api.updateVideo(videoId!, { monitored: nextMonitored }),
        onSuccess: (_data, nextMonitored) => {
            queryClient.setQueryData(["video", videoId], (old: VideoDetailContract | undefined) =>
                old ? { ...old, is_monitored: nextMonitored } : old
            );
            dispatchMonitorStateChanged({ type: "video", tidalId: videoId!, monitored: nextMonitored });
            dispatchLibraryUpdated();
        },
        onError: (err: any) => {
            toast({ title: "Failed to update monitoring", description: err.message, variant: "destructive" });
        },
    });

    // Toggle lock mutation
    const toggleLock = useMutation({
        mutationFn: (nextLocked: boolean) =>
            api.updateVideo(videoId!, { monitor_lock: nextLocked }),
        onSuccess: (_data, nextLocked) => {
            queryClient.setQueryData(["video", videoId], (old: any) =>
                old ? { ...old, monitor_locked: nextLocked, monitor_lock: nextLocked } : old
            );
        },
        onError: (err: any) => {
            toast({ title: "Failed to update lock", description: err.message, variant: "destructive" });
        },
    });

    const handleDownload = async () => {
        const url = tidalUrl("video", videoId!);
        await addToQueue(url, "video", videoId!);
        toast({ title: "Download queued", description: video?.title || "Video" });
        dispatchActivityRefresh();
    };

    const handlePlayClick = async () => {
        try {
            if (!isDownloaded) {
                const signedUrl = await api.signTidalVideoStream(videoId!);
                setRemoteStreamUrl(signedUrl);
            }

            setIsPlaying(true);
            setTimeout(() => {
                if (videoRef.current) {
                    videoRef.current.play().catch(e => console.error("Auto-play failed:", e));
                }
            }, 50);
        } catch (error: any) {
            toast({
                title: "Playback unavailable",
                description: error.message || "Could not start remote video playback.",
                variant: "destructive",
            });
        }
    };

    const isMonitored = Boolean(video?.is_monitored ?? video?.monitor);
    const isLocked = Boolean(video?.monitor_locked ?? video?.monitor_lock);
    const isDownloaded = Boolean(video?.is_downloaded ?? video?.downloaded);
    const coverUrl = getTidalImage(video?.cover_id || video?.cover, "video", "large");
    const year = video?.release_date ? new Date(video.release_date).getFullYear() : null;

    const streamUrl = isDownloaded && videoFile
        ? api.getStreamUrl(videoFile.id)
        : (remoteStreamUrl || '');

    const artistPicUrl = artistData?.picture ? getArtistPicture(artistData.picture, "small") : null;

    useEffect(() => {
        const videoElement = videoRef.current;

        if (!videoElement) {
            return;
        }

        if (hlsRef.current) {
            hlsRef.current.destroy();
            hlsRef.current = null;
        }

        if (!isPlaying || !remoteStreamUrl || isDownloaded) {
            return;
        }

        let cancelled = false;

        const attachRemoteVideo = async () => {
            if (!videoRef.current) {
                return;
            }

            const { default: Hls } = await import("hls.js/dist/hls.light.mjs");
            if (cancelled || !videoRef.current) {
                return;
            }

            if (Hls.isSupported()) {
                const hls = new Hls({
                    enableWorker: true,
                });

                hlsRef.current = hls;
                hls.loadSource(remoteStreamUrl);
                hls.attachMedia(videoRef.current);

                hls.on(Hls.Events.ERROR, (_event, data) => {
                    if (!data.fatal) {
                        return;
                    }

                    console.error("Remote video playback failed:", data);
                    toast({
                        title: "Playback unavailable",
                        description: "The remote video stream could not be loaded.",
                        variant: "destructive",
                    });
                    hls.destroy();
                    if (hlsRef.current === hls) {
                        hlsRef.current = null;
                    }
                });
                return;
            }

            if (videoRef.current.canPlayType("application/vnd.apple.mpegurl")) {
                videoRef.current.src = remoteStreamUrl;
                return;
            }
        };

        void attachRemoteVideo();

        return () => {
            cancelled = true;
            if (hlsRef.current) {
                hlsRef.current.destroy();
                hlsRef.current = null;
            }
        };
    }, [isDownloaded, isPlaying, remoteStreamUrl, toast]);

    if (isVideoLoading) {
        return (
            <LoadingState className={styles.loadingState} label="Loading video..." />
        );
    }

    if (error || !video) {
        return (
            <div className={styles.errorState}>
                <Video24Regular style={{ width: 64, height: 64, color: tokens.colorNeutralForeground4 }} />
                <Title2>Video Not Found</Title2>
                <Body1 style={{ color: tokens.colorNeutralForeground2 }}>
                    This video doesn't exist in your library.
                </Body1>
                <Button appearance="primary" onClick={() => navigate(-1)}>
                    Go Back
                </Button>
            </div>
        );
    }

    return (
        <div className={styles.container}>
            {/* Player Wrapper directly at top */}
            <div className={styles.playerWrapper}>
                {!isPlaying ? (
                    <>
                        {coverUrl ? (
                            <img src={coverUrl} alt={video.title} className={styles.thumbnailImage} onClick={handlePlayClick} />
                        ) : (
                            <div className={styles.thumbnailPlaceholder} onClick={handlePlayClick}>
                                <Video24Regular style={{ width: 64, height: 64 }} />
                            </div>
                        )}
                        <div className={styles.playOverlay} onClick={handlePlayClick}>
                            <Play24Filled style={{ width: 64, height: 64, color: "#fff" }} />
                        </div>
                    </>
                ) : (
                    <video
                        ref={videoRef}
                        controls
                        className={styles.videoPlayer}
                        src={isDownloaded ? streamUrl : undefined}
                        poster={coverUrl || undefined}
                        preload="metadata"
                        autoPlay
                    >
                        Your browser does not support the video element.
                    </video>
                )}
            </div>

            <div className={styles.infoSection}>
                <div className={styles.titleRow}>
                    <Title1>{video.title}</Title1>
                    {video.explicit ? <ExplicitBadge /> : null}
                </div>

                <div className={styles.metadataRow}>
                    <div className={styles.leftMeta}>
                        {video.artist_name && (
                            <div className={styles.artistProfile} onClick={() => video.artist_id && navigate(`/artist/${video.artist_id}`)}>
                                {artistPicUrl ? (
                                    <img src={artistPicUrl} className={styles.artistAvatar} alt={video.artist_name} />
                                ) : (
                                    <div className={styles.artistAvatar} style={{ backgroundColor: tokens.colorNeutralBackground4, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                        <Text size={200} weight="bold">{video.artist_name.charAt(0)}</Text>
                                    </div>
                                )}
                                <Text weight="semibold" size={400}>{video.artist_name}</Text>
                            </div>
                        )}

                        <div className={styles.metaItems}>
                            {year && (
                                <>
                                    <Text>{year}</Text>
                                    <Text>•</Text>
                                </>
                            )}
                            <Text>{formatDurationSeconds(video.duration)}</Text>
                            <Text>•</Text>
                            {video.quality && (
                                <QualityBadge quality={video.quality} size="small" />
                            )}
                            {isDownloaded && videoFile && (
                                <>
                                    <Text>•</Text>
                                    <Badge appearance="outline" size="small">
                                        {[
                                            videoFile.codec,
                                            videoFile.file_size ? formatFileSize(videoFile.file_size) : null,
                                            videoFile.extension?.toUpperCase(),
                                            videoFile.bitrate ? `${Math.round(videoFile.bitrate / 1000)}k` : null
                                        ].filter(Boolean).join(" / ")}
                                    </Badge>
                                </>
                            )}
                        </div>
                    </div>

                    <div className={styles.rightActions}>
                        <Button
                            appearance={isMonitored ? "subtle" : "primary"}
                            icon={isMonitored ? <EyeOff24Regular /> : <Eye24Regular />}
                            disabled={isLocked}
                            onClick={() => toggleMonitor.mutate(!isMonitored)}
                            className={mergeClasses(styles.actionButton, isMonitored ? styles.transparentButton : styles.primaryButton)}
                            title={isLocked ? "Unlock to change" : (isMonitored ? "Stop monitoring" : "Start monitoring")}
                        >
                            {isMonitored ? "Unmonitor" : "Monitor"}
                        </Button>

                        <Button
                            appearance="subtle"
                            icon={isLocked ? <LockOpen24Regular /> : <LockClosed24Regular />}
                            onClick={() => toggleLock.mutate(!isLocked)}
                            style={isLocked ? { color: tokens.colorPaletteRedForeground1 } : undefined}
                            className={mergeClasses(styles.actionButton, styles.transparentButton)}
                            title={isLocked ? "Unlock" : "Lock"}
                        >
                            {isLocked ? "Unlock" : "Lock"}
                        </Button>

                        {!isDownloaded && (
                            <Button
                                appearance="subtle"
                                icon={<ArrowDownload24Regular />}
                                onClick={handleDownload}
                                className={mergeClasses(styles.actionButton, styles.transparentButton)}
                            >
                                Download
                            </Button>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};

export default VideoPage;
