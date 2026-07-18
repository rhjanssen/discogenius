/**
 * Video detail page — shows video metadata, monitor/download controls,
 * and a native video player when the file is downloaded locally.
 */
import { useEffect, useMemo, useState, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
    Button,
    Badge,
    Link,
    Spinner,
    Text,
    Title1,
    mergeClasses,
    makeStyles,
    tokens,
} from "@fluentui/react-components";
import {
  ArrowDownload24Regular as ArrowDownload24RegularBase,
  Eye24Regular as Eye24RegularBase,
  EyeOff24Regular as EyeOff24RegularBase,
  LockClosed24Regular as LockClosed24RegularBase,
  LockOpen24Regular as LockOpen24RegularBase,
  Play24Filled,
  Video24Regular as Video24RegularBase,
  ArrowDownload24Filled,
  Eye24Filled,
  EyeOff24Filled,
  LockClosed24Filled,
  LockOpen24Filled,
  Video24Filled,
  bundleIcon
} from "@fluentui/react-icons";
import { api } from "@/services/api";
import { renderableArtworkUrl } from "@/utils/artwork";
import { formatDurationSeconds } from "@/utils/format";
import {
    selectVideoDownloadOffer,
    selectVideoOffer,
    selectVideoPreviewOffer,
    videoOfferSelectionKey,
    videoQueueTarget,
} from "@/utils/videoOffers";
import { useToast } from "@/hooks/useToast";
import { useDebouncedQueryInvalidation } from "@/hooks/useDebouncedQueryInvalidation";
import { useQueueStatus } from "@/hooks/useQueueStatus";
import { DynamicBrandProvider } from "@/providers/DynamicBrandProvider";
import { useArtworkBrandColor } from "@/hooks/useArtworkBrandColor";
import type { Artist } from "@/hooks/useLibrary";
import type { LibraryFilesListResponseContract, VideoDetailContract } from "@contracts/media";
import { ExplicitBadge } from "@/components/ui/ExplicitBadge";
import { QualityBadge } from "@/components/ui/QualityBadge";
import { ProviderQualityRow, type ProviderQualityOffer } from "@/components/ui/ProviderQualityPill";
import { ArtistPersona } from "@/components/ui/ArtistPersona";
import { ErrorState } from "@/components/ui/ContentState";

import {
    compactDetailActionButtonStyles,
    detailActionGlassButtonStyles,
    detailActionPrimaryButtonStyles,
} from "@/components/media/detailActionStyles";
import {
    ACTIVITY_REFRESH_EVENT,
    LIBRARY_UPDATED_EVENT,
    dispatchMonitorStateChanged,
    dispatchLibraryUpdated,
} from "@/utils/appEvents";

const ArrowDownload24Regular = bundleIcon(ArrowDownload24Filled, ArrowDownload24RegularBase);
const Eye24Regular = bundleIcon(Eye24Filled, Eye24RegularBase);
const EyeOff24Regular = bundleIcon(EyeOff24Filled, EyeOff24RegularBase);
const LockClosed24Regular = bundleIcon(LockClosed24Filled, LockClosed24RegularBase);
const LockOpen24Regular = bundleIcon(LockOpen24Filled, LockOpen24RegularBase);
const Video24Regular = bundleIcon(Video24Filled, Video24RegularBase);

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
    stateShell: {
        width: "100%",
        alignSelf: "stretch",
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
    playSurface: {
        width: "100%",
        height: "100%",
        minWidth: 0,
        padding: 0,
        border: 0,
        borderRadius: 0,
        display: "flex",
        position: "relative",
        overflow: "hidden",
        backgroundColor: "transparent",
        ":focus-visible": {
            outline: `3px solid ${tokens.colorStrokeFocus2}`,
            outlineOffset: "-3px",
        },
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
        pointerEvents: "none",
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
        padding: tokens.spacingHorizontalL,
        backgroundColor: tokens.colorNeutralBackgroundAlpha2,
        backdropFilter: "blur(10px)",
        border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStrokeAlpha2}`,
        borderRadius: tokens.borderRadiusXLarge,
    },
    titleRow: {
        display: "flex",
        alignItems: "flex-start",
        gap: tokens.spacingHorizontalXS,
        flexWrap: "wrap",
    },
    videoTitle: {
        whiteSpace: "normal",
        wordBreak: "break-word",
        fontSize: tokens.fontSizeHero700,
        lineHeight: tokens.lineHeightHero700,
        "@media (min-width: 768px)": {
            fontSize: tokens.fontSizeHero800,
            lineHeight: tokens.lineHeightHero800,
        },
    },
    metadataRow: {
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "space-between",
        flexWrap: "wrap",
        columnGap: tokens.spacingHorizontalL,
        rowGap: tokens.spacingVerticalM,
    },
    leftMeta: {
        display: "flex",
        alignItems: "center",
        columnGap: tokens.spacingHorizontalM,
        rowGap: tokens.spacingVerticalS,
        flexWrap: "wrap",
    },

    metaItems: {
        display: "flex",
        alignItems: "flex-start",
        columnGap: tokens.spacingHorizontalS,
        rowGap: tokens.spacingVerticalXS,
        flexWrap: "wrap",
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
        ...compactDetailActionButtonStyles,
    },
    primaryButton: {
        ...detailActionPrimaryButtonStyles,
    },
    transparentButton: {
        ...detailActionGlassButtonStyles,
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
        minHeight: "320px",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
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
    const { addToQueue } = useQueueStatus();

    const [isPlaying, setIsPlaying] = useState(false);
    const [remoteStreamUrl, setRemoteStreamUrl] = useState<string | null>(null);
    const [selectedOfferKey, setSelectedOfferKey] = useState<string | null>(null);
    const videoRef = useRef<HTMLVideoElement>(null);
    const hlsRef = useRef<{ destroy: () => void } | null>(null);

    useDebouncedQueryInvalidation({
        queryKeys: [["video", videoId], ["video-files", videoId]],
        windowEvents: [ACTIVITY_REFRESH_EVENT, LIBRARY_UPDATED_EVENT],
        enabled: Boolean(videoId),
        debounceMs: 400,
    });

    // Fetch video data
    const {
        data: video,
        isLoading: isVideoLoading,
        error,
    } = useQuery<VideoDetailContract>({
        queryKey: ["video", videoId],
        queryFn: () => api.getVideo(videoId!),
        enabled: !!videoId,
        refetchOnWindowFocus: false,
    });

    // Keep the artist chip aligned with AlbumPage: resolve the artist image from
    // the canonical artist payload, falling back from primary picture to cover.
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
    const coverUrl = video ? renderableArtworkUrl(video.cover_art_url || video.cover || video.cover_id) || undefined : undefined;
    const videoBrandColor = useArtworkBrandColor({
        artworkUrl: coverUrl,
        deriveBrandFromArtwork: true,
    });

    // Toggle monitor mutation
    const toggleMonitor = useMutation({
        mutationFn: (nextMonitored: boolean) =>
            api.updateVideo(videoId!, { monitored: nextMonitored }),
        onSuccess: (_data, nextMonitored) => {
            queryClient.setQueryData(["video", videoId], (old: VideoDetailContract | undefined) =>
                old ? { ...old, is_monitored: nextMonitored } : old
            );
            dispatchMonitorStateChanged({ type: "video", providerId: videoId!, monitored: nextMonitored });
            dispatchLibraryUpdated();
        },
        onError: (err: any) => {
            toast({ title: "Failed to update monitoring", description: err.message, variant: "destructive" });
        },
    });

    // Toggle lock mutation
    const toggleLock = useMutation({
        mutationFn: (nextLocked: boolean) =>
            api.updateVideo(videoId!, { monitored_lock: nextLocked }),
        onSuccess: (_data, nextLocked) => {
            queryClient.setQueryData(["video", videoId], (old: any) =>
                old ? { ...old, monitored_lock: nextLocked } : old
            );
        },
        onError: (err: any) => {
            toast({ title: "Failed to update lock", description: err.message, variant: "destructive" });
        },
    });

    // Provider offers for this canonical video, preference-ordered by the
    // server. The user can switch which provider serves preview + download.
    const isDownloaded = Boolean(video?.is_downloaded ?? video?.downloaded);
    const offers = video?.offers ?? [];
    const selectedOffer = selectVideoOffer(offers, selectedOfferKey);
    const previewOffer = selectVideoPreviewOffer(offers, selectedOfferKey);
    const downloadOffer = selectVideoDownloadOffer(offers, selectedOfferKey);

    const handleSelectOffer = (offer: ProviderQualityOffer) => {
        setSelectedOfferKey(videoOfferSelectionKey(offer.provider, offer.providerAlbumId));
        // A remote preview streams from the previously selected provider;
        // drop it so the next play uses the new selection.
        if (remoteStreamUrl) {
            setRemoteStreamUrl(null);
            setIsPlaying(false);
        }
    };

    const handleDownload = async () => {
        if (!downloadOffer) {
            toast({
                title: "Download unavailable",
                description: "No available provider offer supports video downloads.",
                variant: "destructive",
            });
            return;
        }
        // The third argument becomes the request's providerId after API payload
        // normalization, so pass the selected provider offer rather than the
        // canonical Recordings id. Otherwise api.addToQueue overwrites the
        // payload's selected providerId and the server silently picks a default.
        const queueTarget = videoQueueTarget(videoId!, downloadOffer);
        await addToQueue(null, "video", queueTarget.providerId, {
            successTitle: "Download queued",
            successDescription: video?.title || "Video",
            payload: {
                provider: queueTarget.provider,
                providerId: queueTarget.providerId,
                title: video?.title ?? null,
                artist: video?.artist_name ?? null,
                artistId: video?.artist_id ?? null,
                cover: video?.cover ?? video?.cover_id ?? null,
                quality: downloadOffer.quality ?? video?.quality ?? null,
            },
        });
    };

    const handlePlayClick = async () => {
        try {
            if (!isDownloaded) {
                if (!previewOffer) {
                    throw new Error("No available provider offer supports remote video previews.");
                }
                const signedUrl = await api.signVideoPreviewStream(
                    previewOffer.provider_id ?? videoId!,
                    { provider: previewOffer.provider },
                );
                setRemoteStreamUrl(signedUrl);
            }

            setIsPlaying(true);
        } catch (error: any) {
            toast({
                title: "Playback unavailable",
                description: error.message || "Could not start remote video playback.",
                variant: "destructive",
            });
        }
    };

    const isMonitored = Boolean(video?.is_monitored);
    const isLocked = Boolean(video?.monitored_lock);
    const year = video?.release_date ? new Date(video.release_date).getFullYear() : null;
    const videoErrorDescription = error instanceof Error && error.message === "Video not found"
        ? "This video doesn't exist in your library."
        : error instanceof Error
            ? error.message
            : "This video doesn't exist in your library.";

    const streamUrl = isDownloaded && videoFile
        ? api.getStreamUrl(videoFile.id)
        : (remoteStreamUrl || '');

    const artistPicUrl = renderableArtworkUrl(artistData?.picture || artistData?.cover_image_url);

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

                hls.on(Hls.Events.MANIFEST_PARSED, () => {
                    if (videoRef.current) {
                        videoRef.current.play().catch(e => console.error("Play after manifest parsed failed:", e));
                    }
                });

                hls.on(Hls.Events.ERROR, (_event: any, data: any) => {
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
            <div className={mergeClasses(styles.stateShell, styles.loadingState)} role="status" aria-live="polite">
                <Spinner label="Loading video…" labelPosition="below" />
            </div>
        );
    }

    if (error || !video) {
        return (
            <div className={styles.stateShell}>
                <ErrorState
                    title="Video not found"
                    description={videoErrorDescription}
                    minHeight="320px"
                    actions={<Button appearance="primary" onClick={() => navigate(-1)}>Go Back</Button>}
                />
            </div>
        );
    }

    return (
        <DynamicBrandProvider keyColor={videoBrandColor}>
            <div className={styles.container}>
                {/* Player Wrapper directly at top */}
                <div className={styles.playerWrapper}>
                    {!isPlaying ? (
                        <Button
                            appearance="transparent"
                            className={styles.playSurface}
                            onClick={handlePlayClick}
                            disabled={!isDownloaded && !previewOffer}
                            aria-label={isDownloaded || previewOffer ? `Play ${video.title}` : `Preview unavailable for ${video.title}`}
                        >
                            {coverUrl ? (
                                <img src={coverUrl} alt="" aria-hidden="true" className={styles.thumbnailImage} />
                            ) : (
                                <div className={styles.thumbnailPlaceholder} aria-hidden="true">
                                    <Video24Regular style={{ width: 64, height: 64 }} />
                                </div>
                            )}
                            <div className={styles.playOverlay} aria-hidden="true">
                                <Play24Filled style={{ width: 64, height: 64, color: "#fff" }} />
                            </div>
                        </Button>
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
                        <Title1 className={styles.videoTitle}>{video.title}</Title1>
                        {video.explicit ? <ExplicitBadge /> : null}
                    </div>

                    <div className={styles.metadataRow}>
                        <div className={styles.leftMeta}>
                            {video.artist_name && (
                                <ArtistPersona
                                    artistId={video.artist_id?.toString()}
                                    artistName={video.artist_name}
                                    avatarUrl={artistPicUrl || undefined}
                                />
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
                                {offers.length > 0 ? (
                                    <ProviderQualityRow
                                        offers={offers.map((offer): ProviderQualityOffer => ({
                                            slot: "video",
                                            quality: offer.quality,
                                            provider: offer.provider,
                                            providerAlbumId: offer.provider_id,
                                            available: offer.available,
                                            canPreview: offer.can_preview,
                                            canDownload: offer.can_download,
                                        }))}
                                        size="small"
                                        onSelectOffer={handleSelectOffer}
                                        selectedOfferAlbumId={selectedOffer?.provider_id ?? null}
                                        selectedOfferProvider={selectedOffer?.provider ?? null}
                                    />
                                ) : video.quality ? (
                                    <QualityBadge quality={video.quality} size="small" />
                                ) : null}
                                {(video.albums ?? []).map((album) => (
                                    <span key={album.id}>
                                        <Text>•</Text>{" "}
                                        <Link onClick={() => navigate(`/album/${album.id}`)}>
                                            From {album.title}
                                        </Link>
                                    </span>
                                ))}
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
                                    disabled={!downloadOffer}
                                    title={downloadOffer ? "Download from the selected provider" : "No provider offer supports video downloads"}
                                    className={mergeClasses(styles.actionButton, styles.transparentButton)}
                                >
                                    Download
                                </Button>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </DynamicBrandProvider>
    );
};

export default VideoPage;
