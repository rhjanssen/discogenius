/**
 * Shared MediaCard component used for albums, artists, videos, and tracks.
 * Replaces 3 copy-pasted card implementations across Library, ArtistPage, and AlbumPage.
 */
import React, { memo, useCallback } from "react";
import { Card, mergeClasses } from "@fluentui/react-components";
import { useNavigate } from "react-router-dom";
import { Eye16Regular, EyeOff16Regular } from "@fluentui/react-icons";
import { QualityBadge } from "@/components/ui/QualityBadge";
import { ExplicitBadge } from "@/components/ui/ExplicitBadge";
import { DownloadOverlay } from "@/components/ui/DownloadOverlay";
import { useCardStyles } from "./cardStyles";

export interface MediaCardProps {
    /** Navigation path on click (optional if onClick is provided) */
    to?: string;
    /** Custom click handler. Overrides 'to' navigation if provided. */
    onClick?: () => void;
    /** Image URL (null for placeholder) */
    imageUrl: string | null;
    /** Provider/local fallback image URL when the canonical artwork URL fails */
    fallbackImageUrl?: string | null;
    /** Alt text for image */
    alt: string;
    /** Title text */
    title: string;
    /** Subtitle (artist name, release count, etc.) */
    subtitle?: string;
    /** Is this item explicit? */
    explicit?: boolean | number | string | null;
    /** Audio quality for badge overlay */
    quality?: string | null;
    /** Custom quality badge content, used when multiple provider slots should share the overlay. */
    qualityBadges?: React.ReactNode;
    /** Is this item monitored? */
    monitored?: boolean;

    /** Called when monitor indicator is clicked */
    onMonitorToggle?: (e: React.MouseEvent) => void;
    /** Use mini variant (less visual weight) */
    mini?: boolean;
    /** Override placeholder content (default: colored bg) */
    placeholder?: React.ReactNode;
    /** Additional status badge in top-right corner */
    statusBadge?: React.ReactNode;
    /** Additional className for the card root */
    className?: string;
    /** Use video aspect ratio (3:2) instead of square */
    videoAspect?: boolean;
    /** Download overlay status */
    downloadStatus?: 'pending' | 'queued' | 'downloading' | 'completed' | 'failed' | 'cancelled' | 'paused' | string;
    /** Download overlay progress */
    downloadProgress?: number;
    /** Download overlay error message */
    downloadError?: string;
}

export const MediaCard: React.FC<MediaCardProps> = memo(function MediaCard({
    to,
    imageUrl,
    fallbackImageUrl,
    alt,
    title,
    subtitle,
    explicit,
    quality,
    qualityBadges,
    monitored,

    onMonitorToggle,
    mini,
    placeholder,
    statusBadge,
    className,
    videoAspect,
    downloadStatus,
    downloadProgress,
    downloadError,
    onClick,
}) {
    const styles = useCardStyles();
    const navigate = useNavigate();
    const showExplicitBadge = explicit === true || explicit === 1 || explicit === "1" || explicit === "true";
    const [imageFailed, setImageFailed] = React.useState(false);
    const [fallbackFailed, setFallbackFailed] = React.useState(false);
    const isClickable = Boolean(onClick || to);
    React.useEffect(() => {
        setImageFailed(false);
        setFallbackFailed(false);
    }, [imageUrl, fallbackImageUrl]);

    const handleClick = useCallback(() => {
        if (onClick) {
            onClick();
        } else if (to) {
            navigate(to);
        }
    }, [navigate, to, onClick]);

    const handleMonitorClick = useCallback(
        (e: React.MouseEvent) => {
            e.stopPropagation();
            onMonitorToggle?.(e);
        },
        [onMonitorToggle]
    );

    const handleMonitorKeyDown = useCallback(
        (e: React.KeyboardEvent) => {
            if (e.key === "Enter" || e.key === " ") {
                e.stopPropagation();
                e.preventDefault();
                onMonitorToggle?.(e as unknown as React.MouseEvent);
            }
        },
        [onMonitorToggle]
    );

    const previewClass = videoAspect ? styles.videoPreview : styles.cardPreview;

    return (
        <Card
            className={mergeClasses(
                mini ? styles.cardMini : styles.card,
                className
            )}
            onClick={isClickable ? handleClick : undefined}
            role={isClickable ? "link" : undefined}
            aria-label={title}
        >
            <div className={previewClass}>
                {(imageFailed ? (!fallbackFailed ? fallbackImageUrl : null) : imageUrl) ? (
                    <img
                        src={(imageFailed ? fallbackImageUrl : imageUrl) as string}
                        alt={alt}
                        className={styles.cardImage}
                        loading="lazy"
                        onError={() => {
                            if (!imageFailed && fallbackImageUrl) {
                                setImageFailed(true);
                            } else {
                                setImageFailed(true);
                                setFallbackFailed(true);
                            }
                        }}
                    />
                ) : (
                    placeholder || <div className={styles.placeholderBg} />
                )}

                {(quality || qualityBadges) && (
                    <div className={styles.qualityBadge}>
                        {qualityBadges ?? <QualityBadge quality={quality as string} size="small" />}
                    </div>
                )}

                {statusBadge && (
                    <div className={styles.statusBadge}>{statusBadge}</div>
                )}

                {onMonitorToggle && (
                    <div
                        className={styles.monitorIndicator}
                        role="button"
                        tabIndex={0}
                        onClick={handleMonitorClick}
                        onKeyDown={handleMonitorKeyDown}
                        aria-label={monitored ? "Unmonitor" : "Monitor"}
                        title={monitored ? "Unmonitor" : "Monitor"}
                    >
                        {monitored ? (
                            <EyeOff16Regular className={styles.monitorIcon} />
                        ) : (
                            <Eye16Regular className={styles.monitorIcon} />
                        )}
                    </div>
                )}

                {downloadStatus && downloadStatus !== 'completed' && (
                    <DownloadOverlay
                        status={downloadStatus}
                        progress={downloadProgress}
                        error={downloadError}
                    />
                )}
            </div>

            <div className={styles.cardContent}>
                <div className={styles.cardTitleRow}>
                    <div className={styles.cardTitle} title={title}>
                        {title}
                    </div>
                    {showExplicitBadge ? (
                        <ExplicitBadge className={styles.explicitBadge} />
                    ) : null}
                </div>
                {subtitle && (
                    <div className={styles.cardSubtitle} title={subtitle}>
                        {subtitle}
                    </div>
                )}
            </div>
        </Card>
    );
});

export default MediaCard;
