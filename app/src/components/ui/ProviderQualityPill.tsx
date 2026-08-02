import React from "react";
import { Badge, Button, Link, makeStyles, mergeClasses, tokens, shorthands } from "@fluentui/react-components";
import { Checkmark12Filled } from "@fluentui/react-icons";
import { QualityBadge, formatQualityForSlot } from "./QualityBadge";
import { ExplicitBadge } from "./ExplicitBadge";
import { ProviderMark } from "./ProviderMark";
import { providerAlbumUrl, providerKey, providerMarkFor, providerTrackUrl, providerVideoUrl } from "./providerMarks";
import { AppTooltip } from "./AppTooltip";
import { tidalBadgeColor, tidalBadgeColorLight } from "@/theme/theme";
import { useTheme } from "@/providers/themeContext";
import {
    BADGE_HEIGHT_PX,
    PROVIDER_GLYPH_SIZE_PX,
    type DiscogeniusBadgeSize,
} from "./badgeSizes";
import { badgeGlassFill } from "./badgeChrome";
import { isUnknownQualityTag } from "@/utils/qualityTier";

type SlotName = "stereo" | "spatial" | "video";
type BadgeSize = DiscogeniusBadgeSize;

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
    /** Canonical/permalink URL persisted from the provider album/video offer. */
    providerUrl?: string | null;
    /** Provider track/video id when the offer is track-scoped. */
    providerTrackId?: string | null;
    /** Canonical/permalink URL persisted from a provider track offer. */
    providerTrackUrl?: string | null;
    selectedReleaseMbid?: string | null;
    musicbrainzTrackId?: string | null;
    musicbrainzRecordingId?: string | null;
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
     * The click event is forwarded so callers can read Ctrl/Cmd for additive
     * multi-edition selection.
     */
    onSelectOffer?: (offer: ProviderQualityOffer, event: React.MouseEvent) => void;
    /** Provider album id (set) currently filling the slot — highlighted, not clickable. */
    selectedOfferAlbumId?: string | null;
    /** Owning provider for selectedOfferAlbumId; provider ids are not globally unique. */
    selectedOfferProvider?: string | null;
}

// Provider circular marks share BADGE_HEIGHT_PX with QualityBadge chips.
const PILL_DIAMETER = BADGE_HEIGHT_PX;
const GLYPH_SIZE = PROVIDER_GLYPH_SIZE_PX;

const useStyles = makeStyles({
    row: {
        display: "inline-flex",
        alignItems: "center",
        columnGap: tokens.spacingHorizontalXS,
        rowGap: tokens.spacingVerticalXS,
        // Wrap on narrow viewports so release-switcher / track pills stay in-bounds
        // instead of clipping off the card edge (Fluent: content reflows, not overflow).
        flexWrap: "wrap",
        minWidth: 0,
        maxWidth: "100%",
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
        // Theme-aware glass fill matching quality chips (SpatialBackground @ badgeGlassAlpha).
        // badgeFill marks (Apple/Spotify/YouTube) override to transparent and cover the circle.
        fontSize: tokens.fontSizeBase200,
        fontWeight: tokens.fontWeightSemibold,
        cursor: "default",
        lineHeight: 0,
        overflow: "hidden",
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
    // Fallback chip when a video offer has no resolution quality (YouTube).
    // Keeps each selectable offer visible beside the provider mark.
    videoOfferChip: {
        fontWeight: tokens.fontWeightSemibold,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        boxSizing: "border-box",
        flexShrink: 0,
        whiteSpace: "nowrap",
        lineHeight: 1,
        verticalAlign: "middle",
        ...shorthands.borderRadius(tokens.borderRadiusCircular),
        paddingLeft: tokens.spacingHorizontalSNudge,
        paddingRight: tokens.spacingHorizontalSNudge,
        "::after": {
            display: "none",
        },
    },
    videoOfferChipSmall: {
        height: `${BADGE_HEIGHT_PX.small}px`,
        fontSize: tokens.fontSizeBase100,
    },
    videoOfferChipMedium: {
        height: `${BADGE_HEIGHT_PX.medium}px`,
        fontSize: tokens.fontSizeBase200,
    },
    videoOfferChipLarge: {
        height: `${BADGE_HEIGHT_PX.large}px`,
        fontSize: tokens.fontSizeBase200,
    },
    videoOfferChipLabel: {
        opacity: 1,
        lineHeight: 1,
    },
    // A mark with its own coloured background owns the full badge circle.
    badgeFillMark: {
        width: "100%",
        height: "100%",
        objectFit: "cover",
        ...shorthands.borderRadius(tokens.borderRadiusCircular),
    },
    // Interactive (release-switcher) badges: hug the QualityBadge height so the
    // row matches album-header display pills. Selection uses a box-shadow ring
    // (not padding + border growth) so layout never shifts or vertically drifts.
    offerSelectButton: {
        display: "inline-flex",
        alignItems: "center",
        minWidth: 0,
        minHeight: "unset",
        height: "auto",
        paddingTop: "0",
        paddingBottom: "0",
        paddingLeft: "0",
        paddingRight: "0",
        ...shorthands.border("0", "solid", "transparent"),
        backgroundColor: "transparent",
        cursor: "pointer",
        ...shorthands.borderRadius(tokens.borderRadiusCircular),
        transitionProperty: "background-color, box-shadow",
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
        boxShadow: `0 0 0 1px ${tokens.colorBrandStroke1}, ${tokens.shadow2}`,
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
    explicitSlot: {
        display: "inline-flex",
        alignItems: "center",
        marginLeft: "2px",
    },
    tooltipBody: {
        display: "flex",
        flexDirection: "column",
        rowGap: tokens.spacingVerticalXXS,
    },
    tooltipLink: {
        fontWeight: tokens.fontWeightSemibold,
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
    if (normalized === "soundcloud") return "SoundCloud";
    return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

/**
 * Compact chip when a video offer has no SD/HD/FHD/UHD tag yet.
 * Never echo the provider name here — the mark already identifies the source,
 * and a "TIDAL"/"Apple" chip reads as a mistaken quality badge.
 */
function videoOfferUnknownQualityLabel(): string {
    return "Video";
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

/**
 * Shared quality-badge tooltip used by the album header and the releases
 * switcher (and every other ProviderQualityRow). Keep one format everywhere.
 *
 * Provider mark already identifies the source — do not lead with `TIDAL · …`.
 *
 *   Stereo · single-source match   (or composite match)
 *   TIDAL album ID: 287367980   ← hyperlink; multiple lines for composites
 *   TIDAL track ID: 394045534   ← when known (tracklist rows)
 *   MusicBrainz edition <mbid>
 *   MusicBrainz track / recording when known
 */
function buildQualityOfferTooltip(
    offer: MergedOffer,
    options: {
        styles: ReturnType<typeof useStyles>;
        isSelectedOffer: boolean;
        interactive: boolean;
    },
): { content: React.ReactElement; ariaLabel: string } {
    const providerName = providerDisplayName(offer.provider);
    const providerAlbumIds = offer.providerAlbumIds?.length
        ? offer.providerAlbumIds
        : splitProviderAlbumIds(offer.providerAlbumId);
    const fillsBothLibraries = offer.slots.length > 1;
    const providerTrackId = String(offer.providerTrackId || "").trim();
    const isVideo = offer.slot === "video";
    const isComposite = offer.matchKind === "composite" || providerAlbumIds.length > 1;
    // Video: skip redundant "Video · available" — provider mark + ID lines are enough.
    // Audio: composition first (single-source vs composite), then slot context.
    const summaryLine = isVideo
        ? null
        : (isComposite
            ? `Composite · ${slotsDisplayName(offer.slots)}`
            : `Single-source · ${slotsDisplayName(offer.slots)}`);
    const detailLine = isVideo ? null : (
        offer.coverageSummary && !/^composite|^single-source/i.test(offer.coverageSummary)
            ? offer.coverageSummary
            : null
    );
    const albumIdLabel = isVideo
        ? `${providerName} ID`
        : (isComposite
            ? `${providerName} album ID (source)`
            : `${providerName} album ID`);
    const trackIdLabel = `${providerName} track ID`;

    const ariaParts = [
        summaryLine,
        detailLine,
        ...providerAlbumIds.map((id) => `${albumIdLabel}: ${id}`),
        providerTrackId ? `${trackIdLabel}: ${providerTrackId}` : null,
        offer.selectedReleaseMbid ? `MusicBrainz edition ${offer.selectedReleaseMbid}` : null,
        offer.musicbrainzTrackId ? `MusicBrainz track ${offer.musicbrainzTrackId}` : null,
        offer.musicbrainzRecordingId ? `MusicBrainz recording ${offer.musicbrainzRecordingId}` : null,
        fillsBothLibraries
            ? "Same release fills both libraries (no separate stereo release available)"
            : null,
        isVideo && offer.canPreview === false && offer.canDownload !== false
            ? "Download available; remote preview is not supported by this provider."
            : null,
        isVideo && offer.canDownload === false
            ? "Video download is not supported by this provider."
            : null,
        options.interactive
            ? (options.isSelectedOffer
                ? "Currently selected"
                : "Click to use only this edition · Ctrl+click to monitor alongside")
            : null,
    ].filter(Boolean) as string[];

    const content = (
        <div className={options.styles.tooltipBody}>
            {summaryLine ? <span>{summaryLine}</span> : null}
            {detailLine ? <span>{detailLine}</span> : null}
            {providerAlbumIds.map((id) => {
                const storedUrl = providerAlbumIds.length === 1 ? offer.providerUrl : null;
                const href = isVideo
                    ? providerVideoUrl(offer.provider, id, storedUrl)
                    : providerAlbumUrl(offer.provider, id, storedUrl);
                return (
                    <span key={id}>
                        {albumIdLabel}:{" "}
                        {href ? (
                            <Link
                                href={href}
                                target="_blank"
                                rel="noreferrer noopener"
                                className={options.styles.tooltipLink}
                                onClick={(event) => event.stopPropagation()}
                            >
                                {id}
                            </Link>
                        ) : id}
                    </span>
                );
            })}
            {providerTrackId ? (
                <span>
                    {trackIdLabel}:{" "}
                    {(() => {
                        const href = providerTrackUrl(
                            offer.provider,
                            providerTrackId,
                            offer.providerTrackUrl,
                        );
                        return href ? (
                            <Link
                                href={href}
                                target="_blank"
                                rel="noreferrer noopener"
                                className={options.styles.tooltipLink}
                                onClick={(event) => event.stopPropagation()}
                            >
                                {providerTrackId}
                            </Link>
                        ) : providerTrackId;
                    })()}
                </span>
            ) : null}
            {offer.selectedReleaseMbid ? (
                <span>
                    MusicBrainz edition{" "}
                    <Link
                        href={`https://musicbrainz.org/release/${offer.selectedReleaseMbid}`}
                        target="_blank"
                        rel="noreferrer noopener"
                        className={options.styles.tooltipLink}
                        onClick={(event) => event.stopPropagation()}
                    >
                        {offer.selectedReleaseMbid}
                    </Link>
                </span>
            ) : null}
            {offer.musicbrainzTrackId ? (
                <span>
                    MusicBrainz track{" "}
                    <Link
                        href={`https://musicbrainz.org/track/${offer.musicbrainzTrackId}`}
                        target="_blank"
                        rel="noreferrer noopener"
                        className={options.styles.tooltipLink}
                        onClick={(event) => event.stopPropagation()}
                    >
                        {offer.musicbrainzTrackId}
                    </Link>
                </span>
            ) : null}
            {offer.musicbrainzRecordingId ? (
                <span>
                    MusicBrainz recording{" "}
                    <Link
                        href={`https://musicbrainz.org/recording/${offer.musicbrainzRecordingId}`}
                        target="_blank"
                        rel="noreferrer noopener"
                        className={options.styles.tooltipLink}
                        onClick={(event) => event.stopPropagation()}
                    >
                        {offer.musicbrainzRecordingId}
                    </Link>
                </span>
            ) : null}
            {fillsBothLibraries ? (
                <span>Same release fills both libraries (no separate stereo release available)</span>
            ) : null}
            {isVideo && offer.canPreview === false && offer.canDownload !== false ? (
                <span>Download available; remote preview is not supported by this provider.</span>
            ) : null}
            {isVideo && offer.canDownload === false ? (
                <span>Video download is not supported by this provider.</span>
            ) : null}
            {options.interactive ? (
                <span>
                    {options.isSelectedOffer
                        ? "Currently selected"
                        : "Click to use only this edition · Ctrl+click to monitor alongside"}
                </span>
            ) : null}
        </div>
    );

    return { content, ariaLabel: ariaParts.join(". ") };
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
 * shows each provider before its badge. Match confidence, provider album id
 * (as a link), and the selected MusicBrainz edition live on the quality-badge
 * tooltip — defined once in buildQualityOfferTooltip for header and releases.
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
    const pillStyle = {
        backgroundColor: badgeGlassFill(palette.SpatialBackground, isDarkMode),
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

        const linkedOffer = group.offers.find((offer) => splitProviderAlbumIds(offer.providerAlbumId).length > 0);
        const linkedIds = splitProviderAlbumIds(linkedOffer?.providerAlbumId);
        const linkedId = linkedIds[0];
        const storedUrl = linkedIds.length === 1 ? linkedOffer?.providerUrl : null;
        const providerHref = linkedId
            ? (linkedOffer?.slot === "video"
                ? providerVideoUrl(group.provider, linkedId, storedUrl)
                : providerAlbumUrl(group.provider, linkedId, storedUrl))
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

        // Quality badges already carry provider / slot / match detail. Keep the
        // provider mark tooltip to the brand name only.
        return (
            <AppTooltip
                key={`p-${groupIndex}`}
                withArrow
                relationship="label"
                content={providerName}
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
            </AppTooltip>
        );
    };

    const renderQualityBadge = (offer: MergedOffer, groupIndex: number, offerIndex: number) => {
        const providerAlbumIds = offer.providerAlbumIds?.length
            ? offer.providerAlbumIds
            : splitProviderAlbumIds(offer.providerAlbumId);
        const isSelectedOffer = Boolean(onSelectOffer)
            && providerAlbumIds.length > 0
            && providerKey(selectedOfferProvider) === providerKey(offer.provider)
            && sameProviderAlbumIdSet(selectedOfferAlbumId, offer.providerAlbumId);
        const { content: tooltipContent, ariaLabel } = buildQualityOfferTooltip(offer, {
            styles,
            isSelectedOffer,
            interactive: Boolean(onSelectOffer),
        });

        const offerQuality = offer.slot === "video" ? formatQualityForSlot(offer.quality, true) : String(offer.quality || "");
        const hasKnownQuality = !isUnknownQualityTag(offerQuality);
        const chipSizeClass = size === "small"
            ? styles.videoOfferChipSmall
            : size === "large"
                ? styles.videoOfferChipLarge
                : styles.videoOfferChipMedium;
        const badge = hasKnownQuality
            ? <QualityBadge quality={offerQuality} size={size} className={styles.badge} showTooltip={false} />
            : offer.slot === "video"
                ? (
                    <Badge
                        shape="circular"
                        appearance="tint"
                        size="medium"
                        className={mergeClasses(styles.videoOfferChip, chipSizeClass, styles.badge)}
                        style={{
                            backgroundColor: badgeGlassFill(palette.SpatialBackground, isDarkMode),
                            color: palette.SpatialText,
                        }}
                        aria-label={`${providerDisplayName(offer.provider)} video offer (quality unknown)`}
                    >
                        <span className={styles.videoOfferChipLabel}>{videoOfferUnknownQualityLabel()}</span>
                    </Badge>
                )
                : null;
        // Only mark explicit editions. Clean is the default assumption — no "C" badge.
        const explicitMark = offer.explicit === true
            ? (
                <span className={styles.explicitSlot}>
                    <ExplicitBadge size={size} />
                </span>
            )
            : null;

        if (!badge && !explicitMark) {
            return null;
        }

        return (
            <AppTooltip
                key={`q-${groupIndex}-${offerIndex}`}
                withArrow
                relationship="description"
                content={tooltipContent}
            >
                {onSelectOffer ? (
                    <Button
                        appearance="transparent"
                        size="small"
                        className={mergeClasses(styles.offerSelectButton, isSelectedOffer ? styles.offerSelectButtonSelected : undefined)}
                        aria-label={ariaLabel}
                        aria-pressed={isSelectedOffer}
                        onClick={(event) => {
                            if (!isSelectedOffer) onSelectOffer(offer, event);
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
                        aria-label={ariaLabel}
                    >
                        {badge}
                        {explicitMark}
                    </span>
                )}
            </AppTooltip>
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
