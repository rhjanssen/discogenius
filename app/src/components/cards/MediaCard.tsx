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
    /** Is this item monitored? */
    monitored?: boolean;
    /** Is monitoring state loading? */
    monitorLoading?: boolean;
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
    alt,
    title,
    subtitle,
    explicit,
    quality,
    monitored,
    monitorLoading,
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
            onClick={handleClick}
            role="link"
            aria-label={title}
        >
            <div className={previewClass}>
                {imageUrl ? (
                    <img
                        src={imageUrl}
                        alt={alt}
                        className={styles.cardImage}
                        loading="lazy"
                    />
                ) : (
                    placeholder || <div className={styles.placeholderBg} />
                )}

                {quality && (
                    <div className={styles.qualityBadge}>
                        <QualityBadge quality={quality} size="small" />
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
