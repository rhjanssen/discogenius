import React, { useState, useEffect } from "react";
import { formatDurationSeconds } from "@/utils/format";
import {
    Text,
    Badge,
    Button,
    Card,
    Dialog,
    DialogSurface,
    DialogBody,
    DialogTitle,
    DialogContent,
    Table,
    TableBody,
    TableCell,
    TableCellLayout,
    TableHeader,
    TableHeaderCell,
    TableRow,
    Tooltip,
    makeStyles,
    tokens,
    shorthands,
    Image,
    Spinner,
} from "@fluentui/react-components";
import { tidalBadgeColor } from "@/theme/theme";
import {
    Document24Regular,
    MusicNote124Regular,
    Video24Regular,
    Image24Regular,
    Info24Regular,
    ChevronDown16Regular,
    ChevronUp16Regular,
    Copy24Regular,
} from "@fluentui/react-icons";
import { useToast } from "@/hooks/useToast";
import { api } from "@/services/api";

export interface LibraryFile {
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
    channels?: number;
    codec?: string;
    duration?: number;
    qualityTarget?: string | null;
    qualityChangeWanted?: boolean;
    qualityChangeDirection?: "upgrade" | "downgrade" | "none";
    qualityCutoffNotMet?: boolean;
    qualityChangeReason?: string | null;
}

interface FileListProps {
    files: LibraryFile[];
    compact?: boolean;
    showExpand?: boolean;
    maxVisible?: number;
    /** Use responsive grid layout - horizontal on desktop, vertical on mobile */
    responsive?: boolean;
}

const useStyles = makeStyles({
    container: {
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalS,
    },
    tableWrapper: {
        width: "100%",
        overflowX: "auto",
    },
    tableWrapperResponsive: {
        width: "100%",
        overflowX: "auto",
        "@media (max-width: 720px)": {
            display: "none",
        },
    },
    tableRow: {
        cursor: "pointer",
        ":hover": {
            backgroundColor: tokens.colorNeutralBackground1Hover,
        },
    },
    fileIcon: {
        flexShrink: 0,
        color: tokens.colorNeutralForeground3,
        display: "flex",
        alignItems: "center",
    },
    fileName: {
        ...shorthands.overflow("hidden"),
        whiteSpace: "nowrap",
        textOverflow: "ellipsis",
        fontWeight: tokens.fontWeightSemibold,
    },
    fileStack: {
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
    },
    filePath: {
        ...shorthands.overflow("hidden"),
        whiteSpace: "nowrap",
        textOverflow: "ellipsis",
        fontSize: tokens.fontSizeBase100,
        color: tokens.colorNeutralForeground3,
    },
    typeStack: {
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalXXS,
    },
    metaText: {
        color: tokens.colorNeutralForeground3,
        fontSize: tokens.fontSizeBase200,
    },
    detailText: {
        color: tokens.colorNeutralForeground3,
        fontSize: tokens.fontSizeBase200,
    },
    badge: {
        flexShrink: 0,
    },
    sizeCell: {
        textAlign: "right",
        color: tokens.colorNeutralForeground2,
        fontFamily: tokens.fontFamilyMonospace,
    },
    actionCell: {
        textAlign: "right",
    },
    mobileList: {
        display: "none",
        flexDirection: "column",
        gap: tokens.spacingVerticalS,
        "@media (max-width: 720px)": {
            display: "flex",
        },
    },
    mobileCard: {
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalXS,
        padding: tokens.spacingHorizontalM,
        width: "100%",
        cursor: "pointer",
        ":hover": {
            backgroundColor: tokens.colorNeutralBackground1Hover,
        },
    },
    mobileHeader: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: tokens.spacingHorizontalS,
    },
    mobileTitle: {
        display: "flex",
        alignItems: "center",
        gap: tokens.spacingHorizontalS,
        minWidth: 0,
    },
    mobileName: {
        ...shorthands.overflow("hidden"),
        whiteSpace: "nowrap",
        textOverflow: "ellipsis",
    },
    mobileMeta: {
        display: "flex",
        flexWrap: "wrap",
        gap: tokens.spacingHorizontalXS,
        color: tokens.colorNeutralForeground3,
        fontSize: tokens.fontSizeBase200,
    },
    mobileDetails: {
        color: tokens.colorNeutralForeground3,
        fontSize: tokens.fontSizeBase200,
    },
    mobilePath: {
        color: tokens.colorNeutralForeground3,
        fontSize: tokens.fontSizeBase100,
        wordBreak: "break-all",
    },
    expandButton: {
        marginTop: tokens.spacingVerticalXXS,
    },
    dialogContent: {
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalM,
    },
    detailRow: {
        display: "flex",
        alignItems: "center",
        gap: tokens.spacingHorizontalS,
        paddingBottom: tokens.spacingVerticalXS,
        borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    },
    detailLabel: {
        minWidth: "100px",
        color: tokens.colorNeutralForeground3,
    },
    detailValue: {
        flex: 1,
        wordBreak: "break-all",
    },
    copyButton: {
        flexShrink: 0,
    },
    compactRow: {
        display: "inline-flex",
        alignItems: "center",
        gap: tokens.spacingHorizontalXXS,
        padding: `${tokens.spacingVerticalNone} ${tokens.spacingHorizontalXS}`,
        borderRadius: tokens.borderRadiusSmall,
        backgroundColor: tokens.colorNeutralBackgroundAlpha2,
        fontSize: tokens.fontSizeBase100,
        cursor: "pointer",
        "&:hover": {
            backgroundColor: tokens.colorNeutralBackground1Hover,
        },
    },
    compactContainer: {
        display: "flex",
        flexWrap: "wrap",
        gap: tokens.spacingHorizontalXS,
    },
    // Custom quality badge that accepts style overrides
    qualityBadge: {
        fontWeight: tokens.fontWeightBold,
        border: "none",
        "::after": {
            display: "none",
        },
    },
    // Preview components for FileDetailDialog
    previewContainer: {
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalS,
        marginBottom: tokens.spacingVerticalM,
    },
    audioPlayer: {
        width: "100%",
        borderRadius: tokens.borderRadiusSmall,
    },
    imagePreview: {
        maxWidth: "100%",
        maxHeight: "300px",
        objectFit: "contain",
        borderRadius: tokens.borderRadiusMedium,
        backgroundColor: tokens.colorNeutralBackground2,
    },
    textPreview: {
        maxHeight: "300px",
        overflow: "auto",
        padding: tokens.spacingHorizontalM,
        backgroundColor: tokens.colorNeutralBackground2,
        borderRadius: tokens.borderRadiusMedium,
        fontFamily: "monospace",
        fontSize: tokens.fontSizeBase200,
        whiteSpace: "pre-wrap",
    },
    spinnerContainer: {
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        padding: tokens.spacingVerticalL,
    },
});

function getFileIcon(fileType: string) {
    switch (fileType) {
        case "track":
            return <MusicNote124Regular />;
        case "video":
        case "video_cover":
            return <Video24Regular />;
        case "cover":
        case "video_thumbnail":
            return <Image24Regular />;
        case "lyrics":
        case "bio":
        case "review":
        case "nfo":
            return <Document24Regular />;
        default:
            return <Document24Regular />;
    }
}

function formatFileSize(bytes?: number): string {
    if (!bytes) return "";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatBitrate(bitrate?: number): string {
    if (!bitrate) return "";
    if (bitrate >= 1000) return `${(bitrate / 1000).toFixed(0)} kbps`;
    return `${bitrate} bps`;
}

function formatSampleRate(rate?: number): string {
    if (!rate) return "";
    if (rate >= 1000) return `${(rate / 1000).toFixed(1)} kHz`;
    return `${rate} Hz`;
}

interface QualityStyle {
    backgroundColor: string;
    color: string;
    label: string;
}

/**
 * Determines the quality badge styling using Tidal colors:
 * - Yellow (#ffd432) for Hi-Res (24-bit)
 * - Teal (#33ffee) for Lossless (16-bit)
 * - Atmos-specific styling for multi-channel audio
 */
function getQualityStyle(
    quality?: string,
    bitDepth?: number,
    sampleRate?: number,
    bitrate?: number,
    channels?: number,
    codec?: string
): QualityStyle | null {
    if (!quality) return null;
    const q = quality.toUpperCase();

    // Check for Dolby Atmos (multi-channel audio, typically 6+ channels)
    const isMultiChannel = channels && channels > 2;
    if (q === "DOLBY_ATMOS" || isMultiChannel) {
        return {
            backgroundColor: tidalBadgeColor.AtmosBackground,
            color: tidalBadgeColor.AtmosText,
            label: "Atmos",
        };
    }

    // Hi-Res (24-bit) - Tidal Yellow
    if (q === "HIRES_LOSSLESS" || bitDepth === 24) {
        let label = "24-bit";
        if (bitDepth && sampleRate) {
            const formattedRate = sampleRate >= 1000
                ? `${(sampleRate / 1000).toFixed(sampleRate % 1000 === 0 ? 0 : 1)}kHz`
                : `${sampleRate}Hz`;
            label = `${bitDepth}-bit/${formattedRate}`;
            if (codec) label += ` ${codec.toUpperCase()}`;
        }
        return {
            backgroundColor: tidalBadgeColor.YellowBackground,
            color: tidalBadgeColor.YellowText,
            label,
        };
    }

    // Lossless (16-bit) - Tidal Teal
    if (q === "LOSSLESS" || bitDepth === 16) {
        let label = "16-bit";
        if (bitDepth && sampleRate) {
            const formattedRate = sampleRate >= 1000
                ? `${(sampleRate / 1000).toFixed(sampleRate % 1000 === 0 ? 0 : 1)}kHz`
                : `${sampleRate}Hz`;
            label = `${bitDepth}-bit/${formattedRate}`;
            if (codec) label += ` ${codec.toUpperCase()}`;
        }
        return {
            backgroundColor: tidalBadgeColor.TealBackground,
            color: tidalBadgeColor.TealText,
            label,
        };
    }

    // Lossy formats (AAC) - neutral/informative style
    if (q === "HIGH" || q === "NORMAL" || q === "LOW" || bitrate) {
        let label = bitrate
            ? `${bitrate >= 1000 ? Math.round(bitrate / 1000) : bitrate}kbps`
            : q === "HIGH" ? "320kbps" : q === "NORMAL" ? "160kbps" : "96kbps";
        if (codec) label += ` ${codec.toUpperCase()}`;
        return {
            backgroundColor: tokens.colorNeutralBackground3,
            color: tokens.colorNeutralForeground3,
            label,
        };
    }

    return {
        backgroundColor: tokens.colorNeutralBackground3,
        color: tokens.colorNeutralForeground3,
        label: quality,
    };
}

function formatFileTypeLabel(fileType: string): string {
    switch (fileType) {
        case "track":
            return "Audio";
        case "video":
            return "Video";
        case "cover":
            return "Cover";
        case "video_cover":
            return "Video Cover";
        case "video_thumbnail":
            return "Thumbnail";
        case "lyrics":
            return "Lyrics";
        case "bio":
            return "Biography";
        case "review":
            return "Review";
        case "nfo":
            return "NFO";
        default:
            return fileType;
    }
}

function getFileDetailParts(file: LibraryFile): string[] {
    const parts: string[] = [];

    if (file.extension) {
        parts.push(file.extension.toUpperCase().replace('.', ''));
    }
    if (file.codec && file.codec.toUpperCase() !== file.extension?.toUpperCase().replace('.', '')) {
        parts.push(file.codec.toUpperCase());
    }
    if (file.bit_depth && file.sample_rate) {
        parts.push(`${file.bit_depth}-bit/${formatSampleRate(file.sample_rate)}`);
    }
    if (file.channels) {
        parts.push(file.channels > 2 ? `${file.channels}ch` : "Stereo");
    }
    if (file.bitrate) {
        parts.push(formatBitrate(file.bitrate));
    }
    if (file.duration) {
        parts.push(formatDurationSeconds(file.duration));
    }

    return parts;
}

// Styled quality badge using Tidal colors
interface FileQualityBadgeProps {
    file: LibraryFile;
    size?: "small" | "medium" | "large";
    className?: string;
}

const FileQualityBadge: React.FC<FileQualityBadgeProps> = ({ file, size = "medium", className }) => {
    const styles = useStyles();
    const qualityStyle = getQualityStyle(
        file.quality,
        file.bit_depth,
        file.sample_rate,
        file.bitrate,
        file.channels,
        file.codec
    );

    if (!qualityStyle) return null;

    return (
        <Badge
            appearance="tint"
            size={size}
            className={`${styles.qualityBadge} ${className || ""}`}
            style={{
                backgroundColor: qualityStyle.backgroundColor,
                color: qualityStyle.color,
            }}
        >
            {qualityStyle.label}
        </Badge>
    );
};

export const FileList: React.FC<FileListProps> = ({
    files,
    compact = false,
    showExpand = true,
    maxVisible = 3,
    responsive = false,
}) => {
    const styles = useStyles();
    const { toast } = useToast();
    const [expanded, setExpanded] = useState(false);
    const [selectedFile, setSelectedFile] = useState<LibraryFile | null>(null);

    const displayFiles = expanded ? files : files.slice(0, maxVisible);
    const hasMore = files.length > maxVisible;

    const copyToClipboard = async (text: string, label: string) => {
        try {
            await navigator.clipboard.writeText(text);
            toast({
                title: "Copied",
                description: `${label} copied to clipboard`,
            });
        } catch (e) {
            toast({
                title: "Error",
                description: "Failed to copy to clipboard",
                variant: "destructive",
            });
        }
    };

    if (files.length === 0) {
        return null;
    }

    if (compact) {
        return (
            <div className={styles.compactContainer}>
                {displayFiles.map((file) => {
                    const qualityStyle = getQualityStyle(file.quality, file.bit_depth, file.sample_rate, file.bitrate, file.channels, file.codec);
                    const details = getFileDetailParts(file).filter(p => !p.includes(':')); // Filter out duration (e.g. "3:45")
                    return (
                        <Tooltip
                            key={file.id}
                            content={
                                <div>
                                    <div>{file.relative_path || file.file_path}</div>
                                    {qualityStyle && file.file_type !== "lyrics" && (
                                        <div>Quality: {qualityStyle.label}</div>
                                    )}
                                    {file.file_size && <div>Size: {formatFileSize(file.file_size)}</div>}
                                </div>
                            }
                            relationship="description"
                        >
                            <div
                                className={styles.compactRow}
                                onClick={() => setSelectedFile(file)}
                            >
                                {getFileIcon(file.file_type)}
                                <span>{formatFileTypeLabel(file.file_type)}</span>
                                {file.quality && file.file_type !== "lyrics" && (
                                    <FileQualityBadge file={file} size="small" />
                                )}
                                {file.file_type !== "lyrics" && details.length > 0 && (
                                    <span style={{ color: tokens.colorNeutralForeground3, marginLeft: tokens.spacingHorizontalXXS }}>
                                        {details.join(" • ")}
                                    </span>
                                )}
                            </div>
                        </Tooltip>
                    );
                })}
                {hasMore && !expanded && showExpand && (
                    <Button
                        appearance="subtle"
                        size="small"
                        icon={<ChevronDown16Regular />}
                        onClick={() => setExpanded(true)}
                    >
                        +{files.length - maxVisible} more
                    </Button>
                )}
                {expanded && showExpand && (
                    <Button
                        appearance="subtle"
                        size="small"
                        icon={<ChevronUp16Regular />}
                        onClick={() => setExpanded(false)}
                    >
                        Show less
                    </Button>
                )}

                {/* File Detail Dialog */}
                <FileDetailDialog
                    file={selectedFile}
                    onClose={() => setSelectedFile(null)}
                    copyToClipboard={copyToClipboard}
                />
            </div>
        );
    }

    return (
        <div className={styles.container}>
            <div className={responsive ? styles.tableWrapperResponsive : styles.tableWrapper}>
                <Table aria-label="Library files">
                    <TableHeader>
                        <TableRow>
                            <TableHeaderCell>File</TableHeaderCell>
                            <TableHeaderCell>Type</TableHeaderCell>
                            <TableHeaderCell>Quality</TableHeaderCell>
                            <TableHeaderCell>Details</TableHeaderCell>
                            <TableHeaderCell style={{ textAlign: "right" }}>Size</TableHeaderCell>
                            <TableHeaderCell />
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {displayFiles.map((file) => {
                            const name = file.filename || file.relative_path?.split("/").pop() || file.file_path.split("/").pop();
                            const path = file.relative_path || file.file_path;
                            const details = getFileDetailParts(file);
                            const detailText = details.length > 0 ? details.join(" • ") : "—";
                            const hasQuality = !!file.quality && file.file_type !== "lyrics";
                            const sizeText = file.file_size ? formatFileSize(file.file_size) : "—";

                            return (
                                <TableRow
                                    key={file.id}
                                    className={styles.tableRow}
                                    onClick={() => setSelectedFile(file)}
                                    tabIndex={0}
                                    onKeyDown={(event) => {
                                        if (event.key === "Enter" || event.key === " ") {
                                            event.preventDefault();
                                            setSelectedFile(file);
                                        }
                                    }}
                                >
                                    <TableCell>
                                        <TableCellLayout media={<span className={styles.fileIcon}>{getFileIcon(file.file_type)}</span>}>
                                            <div className={styles.fileStack}>
                                                <Text className={styles.fileName} title={name}>{name}</Text>
                                                <Text className={styles.filePath} title={path}>{path}</Text>
                                            </div>
                                        </TableCellLayout>
                                    </TableCell>
                                    <TableCell>
                                        <div className={styles.typeStack}>
                                            <Text>{formatFileTypeLabel(file.file_type)}</Text>
                                            {file.library_root && (
                                                <Text className={styles.metaText}>{file.library_root}</Text>
                                            )}
                                        </div>
                                    </TableCell>
                                    <TableCell>
                                        {hasQuality ? (
                                            <FileQualityBadge file={file} size="small" className={styles.badge} />
                                        ) : (
                                            <Text className={styles.metaText}>—</Text>
                                        )}
                                    </TableCell>
                                    <TableCell>
                                        <Text className={styles.detailText}>{detailText}</Text>
                                    </TableCell>
                                    <TableCell className={styles.sizeCell}>
                                        <Text>{sizeText}</Text>
                                    </TableCell>
                                    <TableCell
                                        className={styles.actionCell}
                                        onClick={(event) => event.stopPropagation()}
                                    >
                                        <Tooltip content="View details" relationship="label">
                                            <Button
                                                appearance="subtle"
                                                size="small"
                                                icon={<Info24Regular />}
                                                onClick={(event) => {
                                                    event.stopPropagation();
                                                    setSelectedFile(file);
                                                }}
                                            />
                                        </Tooltip>
                                    </TableCell>
                                </TableRow>
                            );
                        })}
                    </TableBody>
                </Table>
            </div>
            {responsive && (
                <div className={styles.mobileList}>
                    {displayFiles.map((file) => {
                        const name = file.filename || file.relative_path?.split("/").pop() || file.file_path.split("/").pop();
                        const path = file.relative_path || file.file_path;
                        const details = getFileDetailParts(file);
                        const hasQuality = !!file.quality && file.file_type !== "lyrics";

                        return (
                            <Card
                                key={file.id}
                                className={styles.mobileCard}
                                onClick={() => setSelectedFile(file)}
                                tabIndex={0}
                                onKeyDown={(event) => {
                                    if (event.key === "Enter" || event.key === " ") {
                                        event.preventDefault();
                                        setSelectedFile(file);
                                    }
                                }}
                            >
                                <div className={styles.mobileHeader}>
                                    <div className={styles.mobileTitle}>
                                        <span className={styles.fileIcon}>{getFileIcon(file.file_type)}</span>
                                        <Text className={styles.mobileName} weight="semibold" title={name}>
                                            {name}
                                        </Text>
                                    </div>
                                    {hasQuality && <FileQualityBadge file={file} size="small" />}
                                </div>
                                <div className={styles.mobileMeta}>
                                    <span>{formatFileTypeLabel(file.file_type)}</span>
                                    {file.library_root && <span>• {file.library_root}</span>}
                                    {file.file_size && <span>• {formatFileSize(file.file_size)}</span>}
                                </div>
                                {details.length > 0 && (
                                    <Text className={styles.mobileDetails}>{details.join(" • ")}</Text>
                                )}
                                <Text className={styles.mobilePath} title={path}>
                                    {path}
                                </Text>
                            </Card>
                        );
                    })}
                </div>
            )}
            {hasMore && !expanded && showExpand && (
                <Button
                    appearance="subtle"
                    size="small"
                    icon={<ChevronDown16Regular />}
                    onClick={() => setExpanded(true)}
                    className={styles.expandButton}
                >
                    Show {files.length - maxVisible} more files
                </Button>
            )}
            {expanded && showExpand && (
                <Button
                    appearance="subtle"
                    size="small"
                    icon={<ChevronUp16Regular />}
                    onClick={() => setExpanded(false)}
                    className={styles.expandButton}
                >
                    Show less
                </Button>
            )}

            {/* File Detail Dialog */}
            <FileDetailDialog
                file={selectedFile}
                onClose={() => setSelectedFile(null)}
                copyToClipboard={copyToClipboard}
            />
        </div>
    );
};

interface FileDetailDialogProps {
    file: LibraryFile | null;
    onClose: () => void;
    copyToClipboard: (text: string, label: string) => Promise<void>;
}

const FileDetailDialog: React.FC<FileDetailDialogProps> = ({
    file,
    onClose,
    copyToClipboard,
}) => {
    const styles = useStyles();
    const [textContent, setTextContent] = useState<string | null>(null);
    const [loadingText, setLoadingText] = useState(false);
    const filePath = file?.file_path;
    const fileType = file?.file_type;

    // Load text content for sidecar metadata files
    useEffect(() => {
        if (filePath && fileType && ["lyrics", "bio", "review", "nfo"].includes(fileType)) {
            setLoadingText(true);
            api.getFileContent(filePath)
                .then(text => setTextContent(text))
                .catch(() => setTextContent(null))
                .finally(() => setLoadingText(false));
        } else {
            setTextContent(null);
        }
    }, [filePath, fileType]);

    if (!file) return null;

    const isAudio = file.file_type === "track";
    const isVideo = file.file_type === "video" || file.file_type === "video_cover";
    const isImage = file.file_type === "cover" || file.file_type === "video_thumbnail";
    const isText = ["lyrics", "bio", "review", "nfo"].includes(file.file_type);

    const previewUrl = api.getStreamUrl(file.id);

    return (
        <Dialog open={!!file} onOpenChange={(_, data) => !data.open && onClose()}>
            <DialogSurface style={{ maxWidth: "600px" }}>
                <DialogBody>
                    <DialogTitle>File Details</DialogTitle>
                    <DialogContent className={styles.dialogContent}>
                        {/* Preview Section */}
                        {(isAudio || isVideo || isImage) && (
                            <div className={styles.previewContainer}>
                                {isAudio && (
                                    <audio
                                        controls
                                        className={styles.audioPlayer}
                                        src={previewUrl}
                                        preload="metadata"
                                    >
                                        Your browser does not support the audio element.
                                    </audio>
                                )}
                                {isVideo && (
                                    <video
                                        controls
                                        className={styles.audioPlayer}
                                        src={previewUrl}
                                        preload="metadata"
                                        style={{ maxHeight: "300px" }}
                                    >
                                        Your browser does not support the video element.
                                    </video>
                                )}
                                {isImage && (
                                    <Image
                                        src={previewUrl}
                                        alt={file.filename || "Preview"}
                                        className={styles.imagePreview}
                                        fit="contain"
                                    />
                                )}
                            </div>
                        )}

                        {/* Text Content Preview */}
                        {isText && (
                            <div className={styles.previewContainer}>
                                {loadingText && (
                                    <div className={styles.spinnerContainer}>
                                        <Spinner size="small" label="Loading content..." />
                                    </div>
                                )}
                                {!loadingText && textContent && (
                                    <pre className={styles.textPreview}>{textContent}</pre>
                                )}
                                {!loadingText && !textContent && (
                                    <Text style={{ color: tokens.colorNeutralForeground3, fontStyle: "italic" }}>
                                        Unable to load text content
                                    </Text>
                                )}
                            </div>
                        )}

                        <div className={styles.detailRow}>
                            <Text className={styles.detailLabel}>Type</Text>
                            <Text className={styles.detailValue}>{formatFileTypeLabel(file.file_type)}</Text>
                        </div>

                        <div className={styles.detailRow}>
                            <Text className={styles.detailLabel}>Filename</Text>
                            <Text className={styles.detailValue}>{file.filename || file.file_path.split("/").pop()}</Text>
                            <Tooltip content="Copy filename" relationship="label">
                                <Button
                                    appearance="subtle"
                                    size="small"
                                    icon={<Copy24Regular />}
                                    className={styles.copyButton}
                                    onClick={() => copyToClipboard(file.filename || file.file_path.split("/").pop() || "", "Filename")}
                                />
                            </Tooltip>
                        </div>

                        <div className={styles.detailRow}>
                            <Text className={styles.detailLabel}>Full Path</Text>
                            <Text className={styles.detailValue} style={{ fontSize: tokens.fontSizeBase100 }}>
                                {file.file_path}
                            </Text>
                            <Tooltip content="Copy full path" relationship="label">
                                <Button
                                    appearance="subtle"
                                    size="small"
                                    icon={<Copy24Regular />}
                                    className={styles.copyButton}
                                    onClick={() => copyToClipboard(file.file_path, "Full path")}
                                />
                            </Tooltip>
                        </div>

                        {file.relative_path && (
                            <div className={styles.detailRow}>
                                <Text className={styles.detailLabel}>Relative Path</Text>
                                <Text className={styles.detailValue} style={{ fontSize: tokens.fontSizeBase100 }}>
                                    {file.relative_path}
                                </Text>
                                <Tooltip content="Copy relative path" relationship="label">
                                    <Button
                                        appearance="subtle"
                                        size="small"
                                        icon={<Copy24Regular />}
                                        className={styles.copyButton}
                                        onClick={() => copyToClipboard(file.relative_path!, "Relative path")}
                                    />
                                </Tooltip>
                            </div>
                        )}

                        {file.library_root && (
                            <div className={styles.detailRow}>
                                <Text className={styles.detailLabel}>Library</Text>
                                <Text className={styles.detailValue}>{file.library_root}</Text>
                            </div>
                        )}

                        {file.quality && file.file_type !== "lyrics" && (
                            <div className={styles.detailRow}>
                                <Text className={styles.detailLabel}>Quality</Text>
                                <FileQualityBadge file={file} />
                            </div>
                        )}

                        {file.qualityTarget && file.file_type !== "lyrics" && (
                            <div className={styles.detailRow}>
                                <Text className={styles.detailLabel}>Target</Text>
                                <Text className={styles.detailValue}>{file.qualityTarget}</Text>
                            </div>
                        )}

                        {(file.qualityChangeWanted || file.qualityCutoffNotMet || file.qualityChangeReason) && file.file_type !== "lyrics" && (
                            <div className={styles.detailRow}>
                                <Text className={styles.detailLabel}>Quality Status</Text>
                                <Text className={styles.detailValue}>
                                    {file.qualityChangeWanted
                                        ? `${file.qualityChangeDirection === "downgrade" ? "Downgrade" : "Upgrade"} required`
                                        : "Target met"}
                                    {file.qualityCutoffNotMet ? " • Cutoff not met" : ""}
                                    {file.qualityChangeReason ? ` • ${file.qualityChangeReason}` : ""}
                                </Text>
                            </div>
                        )}

                        {file.file_size && (
                            <div className={styles.detailRow}>
                                <Text className={styles.detailLabel}>Size</Text>
                                <Text className={styles.detailValue}>
                                    {formatFileSize(file.file_size)} ({file.file_size.toLocaleString()} bytes)
                                </Text>
                            </div>
                        )}

                        {file.codec && (
                            <div className={styles.detailRow}>
                                <Text className={styles.detailLabel}>Codec</Text>
                                <Text className={styles.detailValue}>{file.codec.toUpperCase()}</Text>
                            </div>
                        )}

                        {file.bit_depth && (
                            <div className={styles.detailRow}>
                                <Text className={styles.detailLabel}>Bit Depth</Text>
                                <Text className={styles.detailValue}>{file.bit_depth}-bit</Text>
                            </div>
                        )}

                        {file.sample_rate && (
                            <div className={styles.detailRow}>
                                <Text className={styles.detailLabel}>Sample Rate</Text>
                                <Text className={styles.detailValue}>{formatSampleRate(file.sample_rate)}</Text>
                            </div>
                        )}

                        {file.channels && (
                            <div className={styles.detailRow}>
                                <Text className={styles.detailLabel}>Channels</Text>
                                <Text className={styles.detailValue}>
                                    {file.channels} ({file.channels === 1 ? "Mono" : file.channels === 2 ? "Stereo" : `${file.channels}ch Surround`})
                                </Text>
                            </div>
                        )}

                        {file.bitrate && !file.bit_depth && (
                            <div className={styles.detailRow}>
                                <Text className={styles.detailLabel}>Bitrate</Text>
                                <Text className={styles.detailValue}>{formatBitrate(file.bitrate)}</Text>
                            </div>
                        )}

                        {file.duration && (
                            <div className={styles.detailRow}>
                                <Text className={styles.detailLabel}>Duration</Text>
                                <Text className={styles.detailValue}>
                                    {Math.floor(file.duration / 60)}:{(file.duration % 60).toString().padStart(2, "0")}
                                </Text>
                            </div>
                        )}

                        {file.extension && (
                            <div className={styles.detailRow}>
                                <Text className={styles.detailLabel}>Extension</Text>
                                <Text className={styles.detailValue}>.{file.extension}</Text>
                            </div>
                        )}
                    </DialogContent>
                </DialogBody>
            </DialogSurface>
        </Dialog>
    );
};

export default FileList;
