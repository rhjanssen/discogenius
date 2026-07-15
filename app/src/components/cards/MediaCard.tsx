/**
 * Shared MediaCard component used for albums, artists, videos, and tracks.
 * Replaces 3 copy-pasted card implementations across Library, ArtistPage, and AlbumPage.
 */
import React, { memo, useCallback } from "react";
import { Card, mergeClasses } from "@fluentui/react-components";
import { useNavigate } from "react-router-dom";
import {
  CheckmarkCircle24Filled,
  Circle24Regular as Circle24RegularBase,
  Eye16Regular as Eye16RegularBase,
  EyeOff16Regular as EyeOff16RegularBase,
  Circle24Filled,
  Eye16Filled,
  EyeOff16Filled,
  bundleIcon
} from "@fluentui/react-icons";
import { QualityBadge } from "@/components/ui/QualityBadge";
import { ExplicitBadge } from "@/components/ui/ExplicitBadge";
import { DownloadOverlay } from "@/components/ui/DownloadOverlay";
import { useCardStyles } from "./cardStyles";

const Circle24Regular = bundleIcon(Circle24Filled, Circle24RegularBase);
const Eye16Regular = bundleIcon(Eye16Filled, Eye16RegularBase);
const EyeOff16Regular = bundleIcon(EyeOff16Filled, EyeOff16RegularBase);

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
    /** User-locked monitor state cannot be toggled by this control. */
    monitoringLocked?: boolean;

    /** Called when monitor indicator is clicked */
    onMonitorToggle?: (e: React.MouseEvent) => void;
    /** Use mini variant (less visual weight) */
    mini?: boolean;
    /** Override placeholder content (default: colored bg) */
    placeholder?: React.ReactNode;
    /** Additional status badge in top-right corner */
    statusBadge?: React.ReactNode;
    /** Additional overlay badge in bottom-left corner */
    bottomLeftBadge?: React.ReactNode;
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
    /** Lidarr-style poster selection control shown while the parent collection is in selection mode. */
    selection?: {
        selected: boolean;
        label: string;
        onChange: (selected: boolean, shiftKey: boolean) => void;
    };
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
    monitoringLocked,

    onMonitorToggle,
    mini,
    placeholder,
    statusBadge,
    bottomLeftBadge,
    className,
    videoAspect,
    downloadStatus,
    downloadProgress,
    downloadError,
    selection,
    onClick,
}) {
    const styles = useCardStyles();
    const navigate = useNavigate();
    const showExplicitBadge = explicit === true || explicit === 1 || explicit === "1" || explicit === "true";
    const [imageFailed, setImageFailed] = React.useState(false);
    const [fallbackFailed, setFallbackFailed] = React.useState(false);
    const [imageLoaded, setImageLoaded] = React.useState(false);
    const isClickable = Boolean(onClick || to || selection);
    React.useEffect(() => {
        setImageFailed(false);
        setFallbackFailed(false);
        setImageLoaded(false);
    }, [imageUrl, fallbackImageUrl]);

    const handleClick = useCallback((event?: React.MouseEvent) => {
        if (selection) {
            selection.onChange(!selection.selected, Boolean(event?.shiftKey));
            return;
        }
        if (onClick) {
            onClick();
        } else if (to) {
            navigate(to);
        }
    }, [navigate, to, onClick, selection]);

    const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
        if (selection) {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            selection.onChange(!selection.selected, event.shiftKey);
            return;
        }
        const activatesLink = Boolean(to) && event.key === "Enter";
        const activatesButton = !to && Boolean(onClick) && (event.key === "Enter" || event.key === " ");
        if (!activatesLink && !activatesButton) return;
        event.preventDefault();
        handleClick();
    }, [handleClick, onClick, to, selection]);

    const handleMonitorClick = useCallback(
        (e: React.MouseEvent) => {
            e.stopPropagation();
            onMonitorToggle?.(e);
        },
        [onMonitorToggle]
    );

    const handleSelectionClick = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
        event.stopPropagation();
        selection?.onChange(!selection.selected, event.shiftKey);
    }, [selection]);

    const previewClass = videoAspect ? styles.videoPreview : styles.cardPreview;
    const primaryImageUrl = imageUrl || null;
    const fallbackUrl = fallbackImageUrl && fallbackImageUrl !== primaryImageUrl ? fallbackImageUrl : null;
    const activeImageUrl = primaryImageUrl && !imageFailed
        ? primaryImageUrl
        : fallbackUrl && !fallbackFailed
            ? fallbackUrl
            : null;
    const placeholderContent = placeholder || <div className={styles.placeholderBg} />;

    return (
        <Card
            className={mergeClasses(
                mini ? styles.cardMini : styles.card,
                className
            )}
            onClick={isClickable ? handleClick : undefined}
            onKeyDown={isClickable ? handleKeyDown : undefined}
            role={selection ? "button" : to ? "link" : onClick ? "button" : undefined}
            tabIndex={isClickable ? 0 : undefined}
            aria-label={title}
        >
            <div className={previewClass}>
                {(!activeImageUrl || !imageLoaded) && (
                    <div className={styles.imagePlaceholderLayer}>
                        {placeholderContent}
                    </div>
                )}

                {activeImageUrl ? (
                    <img
                        key={activeImageUrl}
                        src={activeImageUrl}
                        alt={alt}
                        className={mergeClasses(styles.cardImage, !imageLoaded && styles.cardImageLoading)}
                        loading="lazy"
                        decoding="async"
                        onLoad={() => setImageLoaded(true)}
                        onError={() => {
                            setImageLoaded(false);
                            if (primaryImageUrl && !imageFailed && fallbackUrl) {
                                setImageFailed(true);
                            } else {
                                setImageFailed(true);
                                setFallbackFailed(true);
                            }
                        }}
                    />
                ) : null}

                {selection ? (
                    <button
                        type="button"
                        className={mergeClasses(styles.selectionIndicator, selection.selected && styles.selectionIndicatorSelected)}
                        onClick={handleSelectionClick}
                        aria-label={selection.label}
                        aria-pressed={selection.selected}
                    >
                        {selection.selected ? <CheckmarkCircle24Filled /> : <Circle24Regular />}
                    </button>
                ) : null}

                {(quality || qualityBadges) && (
                    <div className={mergeClasses(styles.qualityBadge, selection && styles.qualityBadgeWithSelection)}>
                        {qualityBadges ?? <QualityBadge quality={quality as string} size="small" />}
                    </div>
                )}

                {statusBadge && (
                    <div className={styles.statusBadge}>{statusBadge}</div>
                )}

                {bottomLeftBadge && (
                    <div className={styles.bottomLeftBadge}>{bottomLeftBadge}</div>
                )}

                {onMonitorToggle && (
                    <button
                        type="button"
                        className={styles.monitorIndicator}
                        onClick={handleMonitorClick}
                        disabled={monitoringLocked}
                        aria-label={monitored ? "Unmonitor" : "Monitor"}
                        title={monitoringLocked ? "Monitoring is locked" : monitored ? "Unmonitor" : "Monitor"}
                    >
                        {monitored ? (
                            <EyeOff16Regular className={styles.monitorIcon} />
                        ) : (
                            <Eye16Regular className={styles.monitorIcon} />
                        )}
                    </button>
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
