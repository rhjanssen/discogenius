import React from "react";
import { Button, Link, Tooltip, makeStyles, mergeClasses, tokens, shorthands } from "@fluentui/react-components";
import { Checkmark12Filled } from "@fluentui/react-icons";
import { QualityBadge } from "./QualityBadge";
import { ProviderMark } from "./ProviderMark";
import { providerAlbumUrl, providerKey, providerMarkFor, providerVideoUrl } from "./providerMarks";
import { tidalBadgeColor, tidalBadgeColorLight } from "@/theme/theme";
import { useTheme } from "@/providers/themeContext";

type SlotName = "stereo" | "spatial" | "video";
type BadgeSize = "small" | "medium" | "large";

export interface ProviderQualityOffer {
    /** Library slot this offer fills. */
    slot: SlotName;
    /** Audio quality tag (LOSSLESS, HIRES_LOSSLESS, DOLBY_ATMOS, …). */
    quality?: string | null;
    provider?: string | null;
    matchStatus?: string | null;
    matchKind?: "direct" | "composite";
    coverageSummary?: string | null;
    providerAlbumId?: string | null;
    providerAlbumIds?: string[];
    selectedReleaseMbid?: string | null;
    available?: boolean;
    canPreview?: boolean;
    canDownload?: boolean;
    /** Explicit edition marker (null/undefined = unknown, false = clean). */
    explicit?: boolean | null;
}

interface ProviderQualityRowProps {
    /** One entry per filled slot, in display order (stereo first, then spatial). */
    offers: ProviderQualityOffer[];
    /**
     * Show the provider pill(s). The icon appears once per contiguous run of the
     * same provider, and again whenever the provider changes — so a single source
     * shows one icon, while a stereo-from-A / spatial-from-B split shows both.
     * Turn off in dense lists where the provider is constant and implied.
     */
    showProvider?: boolean;
    size?: BadgeSize;
    className?: string;
    /**
     * Interactive mode (release switcher): each badge becomes a selectable
     * control that reports its offer. Display-only rows leave this unset.
     */
    onSelectOffer?: (offer: ProviderQualityOffer) => void;
    /** Provider album id (set) currently filling the slot — highlighted, not clickable. */
    selectedOfferAlbumId?: string | null;
    /** Owning provider for selectedOfferAlbumId; provider ids are not globally unique. */
    selectedOfferProvider?: string | null;
}

// Fluent Badge heights for small/medium/large, so provider tokens line up with
// adjacent quality and type badges instead of sitting one size step larger.
const PILL_DIAMETER: Record<BadgeSize, number> = { small: 16, medium: 20, large: 24 };
const GLYPH_SIZE: Record<BadgeSize, number> = { small: 10, medium: 12, large: 14 };

function transparentHex(hex: string, alpha: number): string {
    const normalized = hex.replace("#", "");
    if (!/^[\da-f]{6}$/i.test(normalized)) {
        return hex;
    }
    const value = Number.parseInt(normalized, 16);
    const r = (value >> 16) & 255;
    const g = (value >> 8) & 255;
    const b = value & 255;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

const useStyles = makeStyles({
    row: {
        display: "inline-flex",
        alignItems: "center",
        columnGap: tokens.spacingHorizontalXS,
        rowGap: tokens.spacingVerticalXS,
        flexWrap: "nowrap",
        whiteSpace: "nowrap",
    },
    // A little extra breathing room before a second provider group so its icon
    // visibly "owns" the badges to its right.
    groupGap: {
        marginLeft: tokens.spacingHorizontalSNudge,
    },
    providerPill: {
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        boxSizing: "border-box",
        ...shorthands.borderRadius(tokens.borderRadiusCircular),
        // Theme-aware fill matching the Dolby Atmos chip — light chip + dark glyph
        // in light mode, dark chip + white glyph in dark mode (colours applied
        // inline from the badge palette).
        fontSize: tokens.fontSizeBase200,
        fontWeight: tokens.fontWeightSemibold,
        cursor: "default",
    },
    providerPillLink: {
        display: "inline-flex",
        textDecorationLine: "none",
        ...shorthands.borderRadius(tokens.borderRadiusCircular),
        ":focus-visible": {
            outline: `2px solid ${tokens.colorStrokeFocus2}`,
            outlineOffset: "2px",
        },
    },
    badge: {
        cursor: "default",
    },
    // A mark with its own coloured background owns the full badge circle.
    badgeFillMark: {
        width: "100%",
        height: "100%",
        objectFit: "cover",
        ...shorthands.borderRadius(tokens.borderRadiusCircular),
    },
    // Interactive (release-switcher) badges: same visual as the display badge,
    // wrapped in an unstyled button with a hover lift and a selected surface.
    // A 1px transparent border + snug padding is reserved on every offer so the
    // selected brand hairline never shifts the row's layout.
    offerSelectButton: {
        display: "inline-flex",
        alignItems: "center",
        minWidth: 0,
        height: "auto",
        paddingTop: "2px",
        paddingBottom: "2px",
        paddingLeft: "2px",
        paddingRight: "2px",
        ...shorthands.border("1px", "solid", "transparent"),
        backgroundColor: "transparent",
        cursor: "pointer",
        ...shorthands.borderRadius(tokens.borderRadiusCircular),
        transitionProperty: "background-color, box-shadow, border-color",
        transitionDuration: tokens.durationFaster,
        transitionTimingFunction: tokens.curveEasyEase,
        ":hover": {
            backgroundColor: tokens.colorSubtleBackgroundHover,
        },
        ":focus-visible": {
            outline: `2px solid ${tokens.colorStrokeFocus2}`,
            outlineOffset: "2px",
        },
        ":disabled": {
            cursor: "default",
        },
    },
    // Fluent "selected" affordance: a neutral raised surface hugging the badge
    // with a brand hairline, gentle elevation and a brand check — the same
    // language as a selected segmented control, not a hard 2px outline. A neutral
    // (not brand) fill keeps the check readable and never clashes with the
    // album-accent re-theming or the badge's own colour.
    offerSelectButtonSelected: {
        backgroundColor: tokens.colorNeutralBackground1Selected,
        ...shorthands.borderColor(tokens.colorBrandStroke1),
        boxShadow: tokens.shadow2,
        ":hover": {
            backgroundColor: tokens.colorNeutralBackground1Hover,
        },
    },
    // A tiny brand check adornment that makes the selection unambiguous without
    // relying on colour alone (accessibility) and reads instantly in a row of
    // otherwise-similar badges.
    offerSelectedCheck: {
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        marginLeft: "2px",
        marginRight: "1px",
        color: tokens.colorBrandForeground1,
    },
    // The standard "explicit" square (Apple/Spotify style) — a compact neutral
    // edition marker that distinguishes otherwise-identical explicit and clean
    // cuts on the same MusicBrainz release (the "two identical MAX badges"
    // case). Both states render, so absence means genuinely unknown metadata.
    explicitMark: {
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        marginLeft: "1px",
        width: "1.15em",
        height: "1.15em",
        fontSize: tokens.fontSizeBase100,
        fontWeight: tokens.fontWeightBold,
        lineHeight: 1,
        ...shorthands.borderRadius(tokens.borderRadiusSmall),
        backgroundColor: `color-mix(in srgb, ${tokens.colorNeutralForeground3} 22%, transparent)`,
        color: tokens.colorNeutralForeground2,
    },
    tooltipBody: {
        display: "flex",
        flexDirection: "column",
        rowGap: tokens.spacingVerticalXXS,
    },
    tooltipContent: {
        maxWidth: "400px",
    },
});

function providerDisplayName(provider?: string | null): string {
    const normalized = providerKey(provider);
    if (!normalized) return "Provider";
    if (normalized === "tidal") return "TIDAL";
    if (normalized.startsWith("apple")) return "Apple Music";
    if (normalized === "amazon" || normalized === "amazon_music" || normalized === "amazon-music") return "Amazon Music";
    if (normalized === "spotify") return "Spotify";
    if (normalized === "youtube" || normalized === "youtube_music" || normalized === "youtube-music") return "YouTube Music";
    if (normalized === "deezer") return "Deezer";
    return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function slotDisplayName(slot: SlotName): string {
    if (slot === "spatial") return "Spatial";
    if (slot === "video") return "Video";
    return "Stereo";
}

function splitProviderAlbumIds(providerAlbumId?: string | null): string[] {
    return String(providerAlbumId || "")
        .split(/[+;]/)
        .map((id) => id.trim())
        .filter(Boolean);
}

/** Whether two provider album id sets ("id1;id2" composites included) are the same selection. */
function sameProviderAlbumIdSet(left?: string | null, right?: string | null): boolean {
    const a = splitProviderAlbumIds(left).sort();
    const b = splitProviderAlbumIds(right).sort();
    return a.length > 0 && a.length === b.length && a.every((id, index) => id === b[index]);
}

/** One release entry, after merging offers that point at the same provider release. */
interface MergedOffer extends ProviderQualityOffer {
    /** Every library slot this single release fills (e.g. ["stereo", "spatial"]). */
    slots: SlotName[];
}

/** Human label for the set of slots a release fills, e.g. "Stereo + Spatial". */
function slotsDisplayName(slots: SlotName[]): string {
    return slots.map(slotDisplayName).join(" + ");
}

/**
 * Collapse offers that are the *same* provider release filling more than one
 * slot into a single entry. This is the Atmos-fallback case: when no separate
 * stereo release exists, the one Atmos release fills BOTH the stereo and spatial
 * slots — so we show one badge (hover explains it covers both libraries) instead
 * of two identical pills. Offers with different releases (or no selection) stay
 * separate, so a genuine stereo + Atmos split still shows two badges.
 */
function mergeOffersByRelease(offers: ProviderQualityOffer[]): MergedOffer[] {
    const merged: MergedOffer[] = [];
    const indexByKey = new Map<string, number>();
    for (const offer of offers) {
        const albumId = String(offer.providerAlbumId || "").trim();
        const quality = String(offer.quality || "").trim().toUpperCase();
        // Only merge when both slots reference the SAME concrete release.
        const key = albumId ? `${providerKey(offer.provider)}|${albumId}|${quality}` : "";
        const existing = key ? indexByKey.get(key) : undefined;
        if (existing != null) {
            merged[existing].slots.push(offer.slot);
        } else {
            if (key) indexByKey.set(key, merged.length);
            merged.push({ ...offer, slots: [offer.slot] });
        }
    }
    return merged;
}

function statusLabel(offer: ProviderQualityOffer): string {
    const hasSelection = Boolean(String(offer.providerAlbumId || "").trim());
    // Video offers reference a concrete provider video, not a matched release.
    if (offer.slot === "video") return hasSelection ? "available" : "no provider video";
    if (!hasSelection) return "no provider release selected";
    const providerAlbumIds = offer.providerAlbumIds?.length
        ? offer.providerAlbumIds
        : splitProviderAlbumIds(offer.providerAlbumId);
    if (offer.matchKind === "composite" || providerAlbumIds.length > 1) return "hybrid complete match";
    const status = String(offer.matchStatus || "probable").toLowerCase();
    if (status === "verified") return "verified match";
    if (status === "ambiguous") return "ambiguous match";
    if (status === "unmatched") return "no provider release selected";
    return "probable match";
}

interface ProviderGroup {
    provider?: string | null;
    key: string;
    offers: MergedOffer[];
}

/**
 * A row of provider + quality indicators for an album/track. The provider mark
 * sits in its own round pill to the left of the quality badges it covers; a
 * single source shows one icon, while a stereo-from-A / spatial-from-B split
 * shows each provider before its badge. Match confidence and the selected
 * MusicBrainz edition live in the hover tooltips.
 */
export const ProviderQualityRow: React.FC<ProviderQualityRowProps> = ({
    offers,
    showProvider = true,
    size = "medium",
    className,
    onSelectOffer,
    selectedOfferAlbumId,
    selectedOfferProvider,
}) => {
    const styles = useStyles();
    const { isDarkMode } = useTheme();
    const palette = isDarkMode ? tidalBadgeColor : tidalBadgeColorLight;
    const badgeAlpha = isDarkMode ? 0.72 : 0.82;
    const pillStyle = {
        backgroundColor: transparentHex(palette.SpatialBackground, badgeAlpha),
        color: palette.SpatialText,
    };

    const visibleRaw = (offers || []).filter((offer) => offer && offer.available !== false);
    if (visibleRaw.length === 0) {
        return null;
    }
    // Collapse the same release filling multiple slots into one badge.
    const visible = mergeOffersByRelease(visibleRaw);

    // Group contiguous offers that share a provider.
    const groups: ProviderGroup[] = [];
    for (const offer of visible) {
        const key = providerKey(offer.provider);
        const last = groups[groups.length - 1];
        if (last && last.key === key) {
            last.offers.push(offer);
        } else {
            groups.push({ provider: offer.provider, key, offers: [offer] });
        }
    }

    const diameter = PILL_DIAMETER[size];
    const glyphSize = GLYPH_SIZE[size];

    const renderProviderPill = (group: ProviderGroup, groupIndex: number) => {
        const providerName = providerDisplayName(group.provider);
        const mark = providerMarkFor(group.provider);
        // Marks that carry their own coloured background fill the whole badge
        // circle; glyph marks stay centred on the tinted pill surface.
        const fillsBadge = Boolean(mark?.badgeFill);
        const glyph = mark
            ? <ProviderMark provider={group.provider} size={fillsBadge ? diameter : glyphSize} tone="auto" className={fillsBadge ? styles.badgeFillMark : undefined} />
            : providerName.charAt(0);

        const tooltipLines = [
            providerName,
            ...group.offers.map((offer) => `${slotsDisplayName(offer.slots)} · ${statusLabel(offer)}`),
        ];
        const linkedOffer = group.offers.find((offer) => splitProviderAlbumIds(offer.providerAlbumId).length > 0);
        const linkedId = splitProviderAlbumIds(linkedOffer?.providerAlbumId)[0];
        const providerHref = linkedId
            ? (linkedOffer?.slot === "video"
                ? providerVideoUrl(group.provider, linkedId)
                : providerAlbumUrl(group.provider, linkedId))
            : null;
        const pill = (
            <span
                className={mergeClasses(styles.providerPill, groupIndex > 0 ? styles.groupGap : undefined)}
                style={{ width: `${diameter}px`, height: `${diameter}px`, ...(fillsBadge ? { backgroundColor: "transparent" } : pillStyle) }}
                aria-hidden={providerHref ? true : undefined}
                aria-label={providerHref ? undefined : `${providerName} source`}
            >
                {glyph}
            </span>
        );

        return (
            <Tooltip
                key={`p-${groupIndex}`}
                withArrow
                relationship="description"
                content={{
                    children: (
                        <div className={styles.tooltipBody}>
                            {tooltipLines.map((line, i) => (
                                <span key={i}>{line}</span>
                            ))}
                        </div>
                    ),
                    className: styles.tooltipContent,
                }}
            >
                {providerHref ? (
                    <Link
                        href={providerHref}
                        target="_blank"
                        rel="noreferrer noopener"
                        className={styles.providerPillLink}
                        aria-label={`Open ${providerName} offer in a new tab`}
                    >
                        {pill}
                    </Link>
                ) : pill}
            </Tooltip>
        );
    };

    const renderQualityBadge = (offer: MergedOffer, groupIndex: number, offerIndex: number) => {
        const providerName = providerDisplayName(offer.provider);
        const fillsBothLibraries = offer.slots.length > 1;
        const providerAlbumIds = offer.providerAlbumIds?.length
            ? offer.providerAlbumIds
            : splitProviderAlbumIds(offer.providerAlbumId);
        const isSelectedOffer = Boolean(onSelectOffer)
            && providerAlbumIds.length > 0
            && providerKey(selectedOfferProvider) === providerKey(offer.provider)
            && sameProviderAlbumIdSet(selectedOfferAlbumId, offer.providerAlbumId);
        const tooltipTextLines = [
            `${providerName} · ${slotsDisplayName(offer.slots)} · ${statusLabel(offer)}`,
            offer.explicit === true ? "Explicit" : offer.explicit === false ? "Clean" : null,
            offer.coverageSummary || null,
            offer.slot === "video" && offer.canPreview === false && offer.canDownload !== false
                ? "Download available; remote preview is not supported by this provider."
                : null,
            offer.slot === "video" && offer.canDownload === false
                ? "Video download is not supported by this provider."
                : null,
            fillsBothLibraries
                ? "Same release fills both libraries (no separate stereo release available)"
                : null,
            onSelectOffer ? (isSelectedOffer ? "Currently selected" : "Click to use this offer") : null,
        ].filter(Boolean) as string[];
        const ariaLines = [
            ...tooltipTextLines,
            providerAlbumIds.length ? `${providerName} ID${providerAlbumIds.length > 1 ? "s" : ""} ${providerAlbumIds.join(", ")}` : null,
            offer.selectedReleaseMbid ? `MusicBrainz edition ${offer.selectedReleaseMbid}` : null,
        ].filter(Boolean) as string[];

        const tooltipContent = (
            <div className={styles.tooltipBody}>
                {tooltipTextLines.map((line, i) => (
                    <span key={i}>{line}</span>
                ))}
                {providerAlbumIds.map((id) => <span key={id}>{providerName} ID {id}</span>)}
                {providerAlbumIds.length > 0 ? <span>Use the provider icon to open this offer.</span> : null}
                {offer.selectedReleaseMbid ? <span>MusicBrainz edition {offer.selectedReleaseMbid}</span> : null}
            </div>
        );

        const badge = <QualityBadge quality={offer.quality || "Unknown"} size={size} className={styles.badge} />;
        const explicitMark = offer.explicit === true
            ? <span className={styles.explicitMark} aria-hidden="true" title="Explicit edition">E</span>
            : offer.explicit === false
                ? <span className={styles.explicitMark} aria-hidden="true" title="Clean edition">C</span>
                : null;

        return (
            <Tooltip
                key={`q-${groupIndex}-${offerIndex}`}
                withArrow
                relationship="description"
                content={{
                    children: tooltipContent,
                    className: styles.tooltipContent,
                }}
            >
                {onSelectOffer ? (
                    <Button
                        appearance="transparent"
                        size="small"
                        className={mergeClasses(styles.offerSelectButton, isSelectedOffer ? styles.offerSelectButtonSelected : undefined)}
                        aria-label={ariaLines.join(". ")}
                        aria-pressed={isSelectedOffer}
                        onClick={() => {
                            if (!isSelectedOffer) onSelectOffer(offer);
                        }}
                    >
                        {badge}
                        {explicitMark}
                        {isSelectedOffer ? (
                            <span className={styles.offerSelectedCheck} aria-hidden="true">
                                <Checkmark12Filled />
                            </span>
                        ) : null}
                    </Button>
                ) : (
                    <span
                        style={{ display: "inline-flex", alignItems: "center" }}
                        aria-label={ariaLines.join(". ")}
                    >
                        {badge}
                        {explicitMark}
                    </span>
                )}
            </Tooltip>
        );
    };

    return (
        <span className={mergeClasses(styles.row, className)}>
            {groups.map((group, groupIndex) => (
                <React.Fragment key={groupIndex}>
                    {showProvider ? renderProviderPill(group, groupIndex) : null}
                    {group.offers.map((offer, offerIndex) => renderQualityBadge(offer, groupIndex, offerIndex))}
                </React.Fragment>
            ))}
        </span>
    );
};
