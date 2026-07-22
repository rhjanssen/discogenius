/**
 * Video detail page — shows video metadata, monitor/download controls,
 * and a native video player when the file is downloaded locally.
 */
import { useEffect, useMemo, useState, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
    Button,
    Spinner,
    Text,
    Title1,
    mergeClasses,
    makeStyles,
    tokens,
} from "@fluentui/react-components";
import {
  ArrowDownload24Regular,
  Eye24Regular,
  EyeOff24Regular,
  LockClosed24Regular,
  LockOpen24Regular,
  Play24Filled,
  Video24Regular,
  ArrowDownload24Filled,
  Eye24Filled,
  EyeOff24Filled,
  LockClosed24Filled,
  LockOpen24Filled,
  Video24Filled,
  bundleIcon
} from "@fluentui/react-icons";
import { api } from "@/services/api";
import { mediaCoverSrc } from "@/utils/artwork";
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
import { useUltraBlurHero } from "@/hooks/useUltraBlurHero";
import type { Artist } from "@/hooks/useLibrary";
import type { LibraryFilesListResponseContract, VideoDetailContract } from "@contracts/media";
import { ExplicitBadge } from "@/components/ui/ExplicitBadge";
import { QualityBadge } from "@/components/ui/QualityBadge";
import { ProviderQualityRow, type ProviderQualityOffer } from "@/components/ui/ProviderQualityPill";
import { ArtistPersona } from "@/components/ui/ArtistPersona";
import { VideoAlbumAffiliation } from "@/components/ui/VideoAlbumAffiliation";
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

const ArrowDownload24 = bundleIcon(ArrowDownload24Filled, ArrowDownload24Regular);
const Eye24 = bundleIcon(Eye24Filled, Eye24Regular);
const EyeOff24 = bundleIcon(EyeOff24Filled, EyeOff24Regular);
const LockClosed24 = bundleIcon(LockClosed24Filled, LockClosed24Regular);
const LockOpen24 = bundleIcon(LockOpen24Filled, LockOpen24Regular);
const Video24 = bundleIcon(Video24Filled, Video24Regular);

/** Human label for Recordings.video_variant (Discogenius catalog class). */
function videoVariantLabel(variant: string | null | undefined): string {
    switch (String(variant || "").trim().toLowerCase()) {
        case "official":
            return "Official";
        case "lyric":
            return "Lyric";
        case "live":
            return "Live";
        case "audio":
            return "Audio";
        case "visualizer":
            return "Visualizer";
        default:
            return "Video";
    }
}

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
        // Section rhythm; persona↔title uses the tighter titleBlock gap.
        // No glass card — match AlbumPage header (open on the page surface).
        gap: tokens.spacingVerticalM,
        padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalXXS}`,
        "@media (min-width: 768px)": {
            padding: `${tokens.spacingVerticalM} 0`,
        },
    },
    // Related-content pair (Fluent XS / SNudge): artist byline belongs to the title.
    titleBlock: {
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalXS,
        minWidth: 0,
        "@media (min-width: 768px)": {
            gap: tokens.spacingVerticalSNudge,
        },
    },
    albumAffiliation: {
        marginTop: tokens.spacingVerticalXXS,
        width: "100%",
        minWidth: 0,
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
        alignItems: "center",
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
    // Match AlbumPage header facts: centered text + medium quality pills.
    metaItems: {
        display: "inline-flex",
        alignItems: "center",
        columnGap: tokens.spacingHorizontalS,
        rowGap: tokens.spacingVerticalXXS,
        flexWrap: "wrap",
        color: tokens.colorNeutralForeground2,
        fontSize: tokens.fontSizeBase300,
        lineHeight: tokens.lineHeightBase300,
    },
    metaSeparator: {
        width: "4px",
        height: "4px",
        flexShrink: 0,
        borderRadius: tokens.borderRadiusCircular,
        backgroundColor: tokens.colorNeutralForeground2,
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
    loadingState: {
        minHeight: "320px",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
    },
});

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

    // Canonicalize the address bar to Recordings.id (API contract id). Queue /
    // history still deep-link by provider id; GET resolves both.
    useEffect(() => {
        if (!video?.id || !videoId) return;
        if (String(video.id) === String(videoId)) return;
        navigate(`/video/${video.id}`, { replace: true });
    }, [video?.id, videoId, navigate]);

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
    const coverUrl = video ? (mediaCoverSrc(video) || null) : undefined;
    const videoBrandColor = useArtworkBrandColor({
        artworkUrl: coverUrl,
        deriveBrandFromArtwork: true,
        ownsAmbience: true,
    });
    const { heroProps: ultraBlurHeroProps } = useUltraBlurHero(coverUrl);

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

    const artistPicUrl = mediaCoverSrc(artistData);

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

            if (Hls.isSupported() && /\.m3u8(\?|$)/i.test(remoteStreamUrl)) {
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

            videoRef.current.src = remoteStreamUrl;
            videoRef.current.play().catch((e) => console.error("Play progressive preview failed:", e));
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
                                <img
                                    {...ultraBlurHeroProps}
                                    src={coverUrl}
                                    alt=""
                                    aria-hidden="true"
                                    className={styles.thumbnailImage}
                                />
                            ) : (
                                <div className={styles.thumbnailPlaceholder} aria-hidden="true">
                                    <Video24 style={{ width: 64, height: 64 }} />
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
                    <div className={styles.titleBlock}>
                        {video.artist_name ? (
                            <ArtistPersona
                                artistId={video.artist_id?.toString()}
                                artistName={video.artist_name}
                                avatarUrl={artistPicUrl || undefined}
                            />
                        ) : null}

                        <div className={styles.titleRow}>
                            <Title1 className={styles.videoTitle}>{video.title}</Title1>
                            {video.explicit ? <ExplicitBadge size="small" /> : null}
                        </div>
                    </div>

                    <div className={styles.metadataRow}>
                        <div className={styles.leftMeta}>
                            <div className={styles.metaItems}>
                                {year ? <Text>{year}</Text> : null}
                                {year ? <div className={styles.metaSeparator} /> : null}
                                <Text>{formatDurationSeconds(video.duration)}</Text>
                                <div className={styles.metaSeparator} />
                                <Text title="Discogenius video type">{videoVariantLabel(video.video_variant)}</Text>
                                {(offers.length > 0 || video.quality) ? (
                                    <div className={styles.metaSeparator} />
                                ) : null}
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
                                        size="medium"
                                        onSelectOffer={handleSelectOffer}
                                        selectedOfferAlbumId={selectedOffer?.provider_id ?? null}
                                        selectedOfferProvider={selectedOffer?.provider ?? null}
                                    />
                                ) : video.quality ? (
                                    <QualityBadge quality={video.quality} size="medium" />
                                ) : null}
                                {isDownloaded && videoFile?.quality ? (
                                    <>
                                        {(offers.length > 0 || video.quality) ? (
                                            <div className={styles.metaSeparator} />
                                        ) : null}
                                        <span title={`Downloaded file: ${videoFile.quality}`}>
                                            <QualityBadge
                                                quality={videoFile.quality}
                                                size="medium"
                                            />
                                        </span>
                                    </>
                                ) : null}
                            </div>
                        </div>

                        <div className={styles.rightActions}>
                            <Button
                                appearance={isMonitored ? "subtle" : "primary"}
                                icon={isMonitored ? <EyeOff24 /> : <Eye24 />}
                                disabled={isLocked}
                                onClick={() => toggleMonitor.mutate(!isMonitored)}
                                className={mergeClasses(styles.actionButton, isMonitored ? styles.transparentButton : styles.primaryButton)}
                                title={isLocked ? "Unlock to change" : (isMonitored ? "Stop monitoring" : "Start monitoring")}
                            >
                                {isMonitored ? "Unmonitor" : "Monitor"}
                            </Button>

                            <Button
                                appearance="subtle"
                                icon={isLocked ? <LockOpen24 /> : <LockClosed24 />}
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
                                    icon={<ArrowDownload24 />}
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

                    {(video.albums?.length ?? 0) > 0 ? (
                        <VideoAlbumAffiliation
                            className={styles.albumAffiliation}
                            albums={video.albums ?? []}
                        />
                    ) : null}
                </div>
            </div>
        </DynamicBrandProvider>
    );
};

export default VideoPage;
