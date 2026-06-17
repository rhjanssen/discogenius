import React from "react";
import { Tooltip, makeStyles, mergeClasses, tokens, shorthands } from "@fluentui/react-components";
import { QualityBadge } from "./QualityBadge";
import { ProviderMark } from "./ProviderMark";
import { providerKey, providerMarkFor } from "./providerMarks";
import { tidalBadgeColor, tidalBadgeColorLight, badgeStrokeColor } from "@/theme/theme";
import { useTheme } from "@/providers/themeContext";

type SlotName = "stereo" | "spatial";
type BadgeSize = "small" | "medium" | "large";

export interface ProviderQualityOffer {
    /** Library slot this offer fills. */
    slot: SlotName;
    /** Audio quality tag (LOSSLESS, HIRES_LOSSLESS, DOLBY_ATMOS, …). */
    quality?: string | null;
    provider?: string | null;
    matchStatus?: string | null;
    providerAlbumId?: string | null;
    selectedReleaseMbid?: string | null;
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
}

// Provider pill diameters match the quality-badge heights so the round source
// token lines up with the badges beside it.
// Diameters match the quality-badge heights (the pill is border-box) so the
// round source token renders at the exact same height as the badges beside it.
const PILL_DIAMETER: Record<BadgeSize, number> = { small: 18, medium: 24, large: 28 };
const GLYPH_SIZE: Record<BadgeSize, number> = { small: 11, medium: 14, large: 16 };

const useStyles = makeStyles({
    row: {
        display: "inline-flex",
        alignItems: "center",
        columnGap: tokens.spacingHorizontalXS,
        rowGap: tokens.spacingVerticalXS,
        flexWrap: "wrap",
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
        ...shorthands.borderStyle("solid"),
        ...shorthands.borderWidth(tokens.strokeWidthThin),
        fontSize: tokens.fontSizeBase200,
        fontWeight: tokens.fontWeightSemibold,
        cursor: "default",
    },
    badge: {
        cursor: "default",
    },
    tooltipBody: {
        display: "flex",
        flexDirection: "column",
        rowGap: tokens.spacingVerticalXXS,
    },
});

function providerDisplayName(provider?: string | null): string {
    const normalized = providerKey(provider);
    if (!normalized) return "Provider";
    if (normalized === "tidal") return "TIDAL";
    if (normalized.startsWith("apple")) return "Apple Music";
    return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function slotDisplayName(slot: SlotName): string {
    return slot === "spatial" ? "Spatial" : "Stereo";
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
    if (!hasSelection) return "no provider release selected";
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
}) => {
    const styles = useStyles();
    const { isDarkMode } = useTheme();
    const palette = isDarkMode ? tidalBadgeColor : tidalBadgeColorLight;
    const pillStyle = {
        backgroundColor: palette.SpatialBackground,
        color: palette.SpatialText,
        borderColor: badgeStrokeColor(isDarkMode),
    };

    const visibleRaw = (offers || []).filter((offer) => offer && offer.quality);
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
        const glyph = providerMarkFor(group.provider)
            ? <ProviderMark provider={group.provider} size={glyphSize} tone="auto" />
            : providerName.charAt(0);

        const tooltipLines = [
            providerName,
            ...group.offers.map((offer) => `${slotsDisplayName(offer.slots)} · ${statusLabel(offer)}`),
        ];

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
                }}
            >
                <span
                    className={mergeClasses(styles.providerPill, groupIndex > 0 ? styles.groupGap : undefined)}
                    style={{ width: `${diameter}px`, height: `${diameter}px`, ...pillStyle }}
                    aria-label={`${providerName} source`}
                >
                    {glyph}
                </span>
            </Tooltip>
        );
    };

    const renderQualityBadge = (offer: MergedOffer, groupIndex: number, offerIndex: number) => {
        const providerName = providerDisplayName(offer.provider);
        const fillsBothLibraries = offer.slots.length > 1;
        const tooltipLines = [
            `${providerName} · ${slotsDisplayName(offer.slots)} · ${statusLabel(offer)}`,
            fillsBothLibraries
                ? "Same release fills both libraries (no separate stereo release available)"
                : null,
            offer.providerAlbumId ? `${providerName} ID ${offer.providerAlbumId}` : null,
            offer.selectedReleaseMbid ? `MusicBrainz edition ${offer.selectedReleaseMbid}` : null,
        ].filter(Boolean) as string[];

        return (
            <Tooltip
                key={`q-${groupIndex}-${offerIndex}`}
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
                }}
            >
                <span style={{ display: "inline-flex" }}>
                    <QualityBadge quality={offer.quality as string} size={size} className={styles.badge} />
                </span>
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
