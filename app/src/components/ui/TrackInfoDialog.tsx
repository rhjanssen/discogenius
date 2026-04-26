import React, { useEffect, useState } from "react";
import {
    Dialog,
    DialogSurface,
    DialogBody,
    DialogTitle,
    DialogContent,
    Text,
    Spinner,
    makeStyles,
    tokens,
} from "@fluentui/react-components";
import { Dismiss24Regular } from "@fluentui/react-icons";
import { formatDurationSeconds } from "@/utils/format";
import { QualityBadge } from "@/components/ui/QualityBadge";
import { AudioPlayer } from "@/components/ui/AudioPlayer";
import { api } from "@/services/api";

export interface TrackFileInfo {
    id: number;
    file_type: string;
    file_path: string;
    relative_path?: string;
    filename?: string;
    extension?: string;
    quality?: string;
    library_root?: string;
    file_size?: number;
    bitrate?: number;
    sample_rate?: number;
    bit_depth?: number;
    codec?: string;
    duration?: number;
}

interface TrackInfoDialogProps {
    open: boolean;
    onClose: () => void;
    trackTitle: string;
    artistName?: string;
    albumTitle?: string;
    trackNumber?: number;
    duration?: number;
    audioQuality?: string;
    files?: TrackFileInfo[];
    dialogTitle?: string;
    detailsTitle?: string;
}

type ImageMetadata = {
    width: number;
    height: number;
};

const useStyles = makeStyles({
    surface: {
        maxWidth: "640px",
        width: "calc(100vw - 32px)",
        maxHeight: "80vh",
        overflow: "auto",
    },
    dismiss: {
        cursor: "pointer",
        color: tokens.colorNeutralForeground3,
        flexShrink: 0,
        "&:hover": {
            color: tokens.colorNeutralForeground1,
        },
    },
    section: {
        marginTop: tokens.spacingVerticalM,
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalXS,
    },
    sectionTitle: {
        fontWeight: tokens.fontWeightSemibold,
        color: tokens.colorNeutralForeground1,
        fontSize: tokens.fontSizeBase300,
        marginBottom: tokens.spacingVerticalXXS,
    },
    row: {
        display: "flex",
        alignItems: "baseline",
        gap: tokens.spacingHorizontalS,
    },
    label: {
        color: tokens.colorNeutralForeground3,
        fontSize: tokens.fontSizeBase200,
        minWidth: "92px",
        flexShrink: 0,
    },
    value: {
        color: tokens.colorNeutralForeground1,
        fontSize: tokens.fontSizeBase200,
        wordBreak: "break-word",
    },
    fileSeparator: {
        height: "1px",
        backgroundColor: tokens.colorNeutralStroke2,
        marginTop: tokens.spacingVerticalS,
        marginBottom: tokens.spacingVerticalXS,
    },
    playerSection: {
        marginTop: tokens.spacingVerticalS,
    },
    textContainer: {
        marginTop: tokens.spacingVerticalS,
        maxHeight: "300px",
        overflowY: "auto",
        padding: tokens.spacingHorizontalM,
        backgroundColor: tokens.colorNeutralBackgroundAlpha2,
        borderRadius: tokens.borderRadiusMedium,
        border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStrokeAlpha2}`,
    },
    textContent: {
        whiteSpace: "pre-wrap",
        fontSize: tokens.fontSizeBase200,
        color: tokens.colorNeutralForeground2,
        lineHeight: tokens.lineHeightBase300,
    },
    loadingRow: {
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: tokens.spacingVerticalL,
    },
    imagePreview: {
        maxWidth: "100%",
        maxHeight: "280px",
        objectFit: "contain",
        borderRadius: tokens.borderRadiusMedium,
        backgroundColor: tokens.colorNeutralBackground2,
        border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    },
    videoPreview: {
        width: "100%",
        maxHeight: "320px",
        borderRadius: tokens.borderRadiusMedium,
        backgroundColor: tokens.colorNeutralBackground2,
    },
    previewFrame: {
        marginTop: tokens.spacingVerticalS,
    },
});

function formatFileSize(bytes?: number): string {
    if (!bytes) return "—";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatBitrate(bitrate?: number): string {
    if (!bitrate) return "—";
    if (bitrate >= 1000) return `${(bitrate / 1000).toFixed(0)} kbps`;
    return `${bitrate} bps`;
}

function formatSampleRate(rate?: number): string {
    if (!rate) return "—";
    if (rate >= 1000) return `${(rate / 1000).toFixed(1)} kHz`;
    return `${rate} Hz`;
}

function formatResolution(metadata?: ImageMetadata): string {
    if (!metadata) return "—";
    return `${metadata.width} x ${metadata.height}`;
}

function formatFileTypeLabel(fileType: string): string {
    switch (fileType) {
        case "track":
            return "Audio File";
        case "video":
            return "Video File";
        case "cover":
            return "Cover Image";
        case "video_cover":
            return "Video Cover";
        case "video_thumbnail":
            return "Video Thumbnail";
        case "lyrics":
            return "Lyrics";
        case "bio":
            return "Biography";
        case "review":
            return "Review";
        case "nfo":
            return "NFO";
        default:
            return fileType.replace(/_/g, " ");
    }
}

function isImageFile(file: TrackFileInfo) {
    return ["cover", "image", "video_thumbnail"].includes(file.file_type);
}

function isTextFile(file: TrackFileInfo) {
    return ["lyrics", "bio", "review", "nfo"].includes(file.file_type);
}

function isVideoFile(file: TrackFileInfo) {
    return file.file_type === "video" || file.file_type === "video_cover";
}

function isAudioFile(file: TrackFileInfo) {
    return file.file_type === "track";
}

function renderBasicFileRows(
    styles: ReturnType<typeof useStyles>,
    file: TrackFileInfo,
    imageMetadata?: ImageMetadata,
) {
    return (
        <>
            <div className={styles.row}>
                <Text className={styles.label}>Type</Text>
                <Text className={styles.value}>{formatFileTypeLabel(file.file_type)}</Text>
            </div>
            {file.filename && (
                <div className={styles.row}>
                    <Text className={styles.label}>Filename</Text>
                    <Text className={styles.value}>{file.filename}</Text>
                </div>
            )}
            {file.relative_path && (
                <div className={styles.row}>
                    <Text className={styles.label}>Path</Text>
                    <Text className={styles.value}>{file.relative_path}</Text>
                </div>
            )}
            {file.extension && (
                <div className={styles.row}>
                    <Text className={styles.label}>Format</Text>
                    <Text className={styles.value}>{file.extension.toUpperCase()}</Text>
                </div>
            )}
            <div className={styles.row}>
                <Text className={styles.label}>Size</Text>
                <Text className={styles.value}>{formatFileSize(file.file_size)}</Text>
            </div>
            {imageMetadata && (
                <div className={styles.row}>
                    <Text className={styles.label}>Resolution</Text>
                    <Text className={styles.value}>{formatResolution(imageMetadata)}</Text>
                </div>
            )}
            {file.codec && (
                <div className={styles.row}>
                    <Text className={styles.label}>Codec</Text>
                    <Text className={styles.value}>{file.codec.toUpperCase()}</Text>
                </div>
            )}
            {file.bitrate && (
                <div className={styles.row}>
                    <Text className={styles.label}>Bitrate</Text>
                    <Text className={styles.value}>{formatBitrate(file.bitrate)}</Text>
                </div>
            )}
            {file.sample_rate && (
                <div className={styles.row}>
                    <Text className={styles.label}>Sample Rate</Text>
                    <Text className={styles.value}>{formatSampleRate(file.sample_rate)}</Text>
                </div>
            )}
            {file.bit_depth && (
                <div className={styles.row}>
                    <Text className={styles.label}>Bit Depth</Text>
                    <Text className={styles.value}>{file.bit_depth}-bit</Text>
                </div>
            )}
            {file.duration && (
                <div className={styles.row}>
                    <Text className={styles.label}>Duration</Text>
                    <Text className={styles.value}>{formatDurationSeconds(file.duration)}</Text>
                </div>
            )}
            {file.quality && (
                <div className={styles.row}>
                    <Text className={styles.label}>Quality</Text>
                    <QualityBadge quality={file.quality} size="small" />
                </div>
            )}
        </>
    );
}

export const TrackInfoDialog: React.FC<TrackInfoDialogProps> = ({
    open,
    onClose,
    trackTitle,
    artistName,
    albumTitle,
    trackNumber,
    duration,
    audioQuality,
    files = [],
    dialogTitle = "Track Info",
    detailsTitle = "Details",
}) => {
    const styles = useStyles();
    const [textContent, setTextContent] = useState<Record<number, string | null>>({});
    const [loadingTextIds, setLoadingTextIds] = useState<Set<number>>(new Set());
    const [imageMetadata, setImageMetadata] = useState<Record<number, ImageMetadata>>({});

    const audioFiles = files.filter(isAudioFile);
    const videoFiles = files.filter(isVideoFile);
    const imageFiles = files.filter(isImageFile);
    const textFiles = files.filter(isTextFile);

    useEffect(() => {
        if (!open || textFiles.length === 0) {
            setTextContent({});
            setLoadingTextIds(new Set());
            return;
        }

        let cancelled = false;
        const nextLoadingIds = new Set(textFiles.map((file) => file.id));
        setLoadingTextIds(nextLoadingIds);

        void Promise.all(textFiles.map(async (file) => {
            try {
                const content = await api.getFileContent(file.file_path);
                if (!cancelled) {
                    setTextContent((current) => ({ ...current, [file.id]: content }));
                }
            } catch (error) {
                console.error("Failed to load text file:", error);
                if (!cancelled) {
                    setTextContent((current) => ({ ...current, [file.id]: null }));
                }
            } finally {
                if (!cancelled) {
                    setLoadingTextIds((current) => {
                        const next = new Set(current);
                        next.delete(file.id);
                        return next;
                    });
                }
            }
        })).catch(() => {
            // Individual failures are handled above.
        });

        return () => {
            cancelled = true;
        };
    }, [open, textFiles]);

    useEffect(() => {
        if (!open || imageFiles.length === 0) {
            setImageMetadata({});
            return;
        }

        let cancelled = false;
        imageFiles.forEach((file) => {
            const image = new window.Image();
            image.onload = () => {
                if (!cancelled) {
                    setImageMetadata((current) => ({
                        ...current,
                        [file.id]: {
                            width: image.naturalWidth,
                            height: image.naturalHeight,
                        },
                    }));
                }
            };
            image.src = api.getStreamUrl(file.id);
        });

        return () => {
            cancelled = true;
        };
    }, [open, imageFiles]);

    return (
        <Dialog open={open} onOpenChange={(_, data) => { if (!data.open) onClose(); }}>
            <DialogSurface className={styles.surface}>
                <DialogBody>
                    <DialogTitle
                        action={
                            <Dismiss24Regular className={styles.dismiss} onClick={onClose} />
                        }
                    >
                        {dialogTitle}
                    </DialogTitle>
                    <DialogContent>
                        <div className={styles.section}>
                            <Text className={styles.sectionTitle}>{detailsTitle}</Text>
                            <div className={styles.row}>
                                <Text className={styles.label}>Title</Text>
                                <Text className={styles.value} weight="semibold">{trackTitle}</Text>
                            </div>
                            {artistName && (
                                <div className={styles.row}>
                                    <Text className={styles.label}>Artist</Text>
                                    <Text className={styles.value}>{artistName}</Text>
                                </div>
                            )}
                            {albumTitle && (
                                <div className={styles.row}>
                                    <Text className={styles.label}>Album</Text>
                                    <Text className={styles.value}>{albumTitle}</Text>
                                </div>
                            )}
                            {trackNumber !== undefined && (
                                <div className={styles.row}>
                                    <Text className={styles.label}>Track #</Text>
                                    <Text className={styles.value}>{trackNumber}</Text>
                                </div>
                            )}
                            {duration !== undefined && (
                                <div className={styles.row}>
                                    <Text className={styles.label}>Duration</Text>
                                    <Text className={styles.value}>{formatDurationSeconds(duration)}</Text>
                                </div>
                            )}
                            {audioQuality && (
                                <div className={styles.row}>
                                    <Text className={styles.label}>Quality</Text>
                                    <QualityBadge quality={audioQuality} size="small" />
                                </div>
                            )}
                        </div>

                        {[...audioFiles, ...videoFiles, ...imageFiles].map((file, index) => (
                            <React.Fragment key={file.id}>
                                {index > 0 && <div className={styles.fileSeparator} />}
                                <div className={styles.section}>
                                    <Text className={styles.sectionTitle}>
                                        {formatFileTypeLabel(file.file_type)}
                                    </Text>
                                    {renderBasicFileRows(styles, file, imageMetadata[file.id])}

                                    {isAudioFile(file) && (
                                        <div className={styles.playerSection}>
                                            <AudioPlayer
                                                src={api.getStreamUrl(file.id)}
                                                autoPlay={false}
                                            />
                                        </div>
                                    )}

                                    {isVideoFile(file) && (
                                        <div className={styles.previewFrame}>
                                            <video
                                                controls
                                                preload="metadata"
                                                className={styles.videoPreview}
                                                src={api.getStreamUrl(file.id)}
                                            >
                                                Your browser does not support the video element.
                                            </video>
                                        </div>
                                    )}

                                    {isImageFile(file) && (
                                        <div className={styles.previewFrame}>
                                            <img
                                                src={api.getStreamUrl(file.id)}
                                                alt={trackTitle}
                                                className={styles.imagePreview}
                                            />
                                        </div>
                                    )}
                                </div>
                            </React.Fragment>
                        ))}

                        {textFiles.map((file, index) => (
                            <React.Fragment key={file.id}>
                                {(audioFiles.length > 0 || videoFiles.length > 0 || imageFiles.length > 0 || index > 0) && (
                                    <div className={styles.fileSeparator} />
                                )}
                                <div className={styles.section}>
                                    <Text className={styles.sectionTitle}>{formatFileTypeLabel(file.file_type)}</Text>
                                    {renderBasicFileRows(styles, file)}
                                    {loadingTextIds.has(file.id) ? (
                                        <div className={styles.loadingRow}>
                                            <Spinner size="small" />
                                        </div>
                                    ) : textContent[file.id] ? (
                                        <div className={styles.textContainer}>
                                            <Text className={styles.textContent}>{textContent[file.id]}</Text>
                                        </div>
                                    ) : (
                                        <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
                                            Could not load this file.
                                        </Text>
                                    )}
                                </div>
                            </React.Fragment>
                        ))}
                    </DialogContent>
                </DialogBody>
            </DialogSurface>
        </Dialog>
    );
};
