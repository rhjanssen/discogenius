/**
 * Shared MediaCard component used for albums, artists, videos, and tracks.
 * Replaces 3 copy-pasted card implementations across Library, ArtistPage, and AlbumPage.
 */
import React, { memo, useCallback } from "react";
import { Card, mergeClasses } from "@fluentui/react-components";
import { useNavigate } from "react-router-dom";
import {
  CheckmarkCircle24Filled,
  Circle24Regular,
  Eye16Regular,
  EyeOff16Regular,
  Circle24Filled,
  Eye16Filled,
  EyeOff16Filled,
  bundleIcon
} from "@fluentui/react-icons";
import { QualityBadge } from "@/components/ui/QualityBadge";
import { ExplicitBadge } from "@/components/ui/ExplicitBadge";
import { DownloadOverlay } from "@/components/ui/DownloadOverlay";
import { useCardStyles } from "./cardStyles";

const Circle24 = bundleIcon(Circle24Filled, Circle24Regular);
const Eye16 = bundleIcon(Eye16Filled, Eye16Regular);
const EyeOff16 = bundleIcon(EyeOff16Filled, EyeOff16Regular);

/** Same-origin /media-cover paths share HTTP cache with UltraBlur heroes when CORS mode matches. */
function isMediaCoverUrl(url: string): boolean {
    if (url.startsWith("/media-cover/")) {
        return true;
    }
    try {
        return new URL(url).pathname.startsWith("/media-cover/");
    } catch {
        return false;
    }
}

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
    /** Poster selection control shown while the parent collection is in selection mode. */
    selection?: {
        selected: boolean;
        label: string;
        onChange: (selected: boolean, shiftKey: boolean) => void;
    };
    /**
     * Called on right-click or touch long-press while the collection is NOT in
     * selection mode; the parent should enter selection mode and select this
     * card. When `selection` is set, those gestures toggle the selection instead.
     */
    onSelectionIntent?: () => void;
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
    onSelectionIntent,
    onClick,
}) {
    const styles = useCardStyles();
    const navigate = useNavigate();
    const showExplicitBadge = explicit === true || explicit === 1 || explicit === "1" || explicit === "true";
    const [imageFailed, setImageFailed] = React.useState(false);
    const [fallbackFailed, setFallbackFailed] = React.useState(false);
    const [imageLoaded, setImageLoaded] = React.useState(false);
    const imageRef = React.useRef<HTMLImageElement | null>(null);
    const isClickable = Boolean(onClick || to || selection);
    const longPressTimer = React.useRef<number | null>(null);
    const longPressFired = React.useRef(false);

    const markLoadedIfComplete = useCallback((image: HTMLImageElement | null) => {
        if (image?.complete && image.naturalWidth > 0) {
            setImageLoaded(true);
        }
    }, []);

    const handleImageRef = useCallback((node: HTMLImageElement | null) => {
        imageRef.current = node;
        markLoadedIfComplete(node);
    }, [markLoadedIfComplete]);

    React.useEffect(() => {
        setImageFailed(false);
        setFallbackFailed(false);
        setImageLoaded(false);
        markLoadedIfComplete(imageRef.current);
    }, [imageUrl, fallbackImageUrl, markLoadedIfComplete]);

    const handleClick = useCallback((event?: React.MouseEvent) => {
        if (longPressFired.current) {
            // The long-press already handled this gesture; swallow the tap click.
            longPressFired.current = false;
            return;
        }
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

    // Right-click / touch long-press enter selection mode with this card
    // selected (or toggle when selection mode is already active).
    const handleContextMenu = useCallback((event: React.MouseEvent) => {
        if (selection) {
            event.preventDefault();
            selection.onChange(!selection.selected, event.shiftKey);
            return;
        }
        if (onSelectionIntent) {
            event.preventDefault();
            onSelectionIntent();
        }
    }, [selection, onSelectionIntent]);

    const clearLongPress = useCallback(() => {
        if (longPressTimer.current !== null) {
            window.clearTimeout(longPressTimer.current);
            longPressTimer.current = null;
        }
    }, []);
    const handlePointerDown = useCallback((event: React.PointerEvent) => {
        if (event.pointerType !== "touch") return;
        if (!onSelectionIntent && !selection) return;
        longPressFired.current = false;
        clearLongPress();
        longPressTimer.current = window.setTimeout(() => {
            longPressTimer.current = null;
            longPressFired.current = true;
            if (selection) {
                selection.onChange(!selection.selected, false);
            } else {
                onSelectionIntent?.();
            }
        }, 500);
    }, [clearLongPress, onSelectionIntent, selection]);
    const handlePointerEnd = useCallback(() => {
        clearLongPress();
    }, [clearLongPress]);
    React.useEffect(() => clearLongPress, [clearLongPress]);

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
            onContextMenu={selection || onSelectionIntent ? handleContextMenu : undefined}
            onPointerDown={selection || onSelectionIntent ? handlePointerDown : undefined}
            onPointerUp={handlePointerEnd}
            onPointerMove={handlePointerEnd}
            onPointerCancel={handlePointerEnd}
            onPointerLeave={handlePointerEnd}
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
                        ref={handleImageRef}
                        src={activeImageUrl}
                        alt={alt}
                        className={mergeClasses(styles.cardImage, !imageLoaded && styles.cardImageLoading)}
                        loading="lazy"
                        decoding="async"
                        crossOrigin={isMediaCoverUrl(activeImageUrl) ? "anonymous" : undefined}
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
                        {selection.selected ? <CheckmarkCircle24Filled /> : <Circle24 />}
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
                            <EyeOff16 className={styles.monitorIcon} />
                        ) : (
                            <Eye16 className={styles.monitorIcon} />
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
                        <ExplicitBadge size="small" className={styles.explicitBadge} />
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
