import React from "react";
import { Tooltip, makeStyles, mergeClasses, tokens, shorthands } from "@fluentui/react-components";
import { QualityBadge } from "./QualityBadge";

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

type ProviderMark = { src: string; monochrome: boolean };

// Monochrome marks (TIDAL's white diamonds) render as a foreground-tinted glyph
// so they stay visible on both light and dark pills; full-colour marks (Apple
// Music, Deezer) keep their brand colours.
const PROVIDER_MARKS: Record<string, ProviderMark> = {
    tidal: { src: "/assets/images/tidal_icon.svg", monochrome: true },
    apple: { src: "/assets/images/apple_music_icon.svg", monochrome: false },
    apple_music: { src: "/assets/images/apple_music_icon.svg", monochrome: false },
    "apple-music": { src: "/assets/images/apple_music_icon.svg", monochrome: false },
    deezer: { src: "/assets/images/deezer_icon.svg", monochrome: false },
};

// Provider pill diameters match the quality-badge heights so the round source
// token lines up with the badges beside it.
const PILL_DIAMETER: Record<BadgeSize, number> = { small: 18, medium: 22, large: 26 };
const GLYPH_SIZE: Record<BadgeSize, number> = { small: 11, medium: 13, large: 16 };

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
        ...shorthands.borderRadius(tokens.borderRadiusCircular),
        ...shorthands.border(tokens.strokeWidthThin, "solid", tokens.colorNeutralStroke2),
        backgroundColor: tokens.colorNeutralBackground3,
        cursor: "default",
    },
    glyphImg: {
        display: "block",
        objectFit: "contain",
    },
    glyph: {
        display: "block",
        backgroundColor: tokens.colorNeutralForeground1,
        WebkitMaskRepeat: "no-repeat",
        maskRepeat: "no-repeat",
        WebkitMaskPosition: "center",
        maskPosition: "center",
        WebkitMaskSize: "contain",
        maskSize: "contain",
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

function providerKey(provider?: string | null): string {
    return String(provider || "").trim().toLowerCase();
}

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
    offers: ProviderQualityOffer[];
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

    const visible = (offers || []).filter((offer) => offer && offer.quality);
    if (visible.length === 0) {
        return null;
    }

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
        const mark = PROVIDER_MARKS[group.key] || PROVIDER_MARKS[group.key.replace(/-/g, "_")];

        let glyph: React.ReactNode;
        if (mark?.monochrome) {
            glyph = (
                <span
                    aria-hidden="true"
                    className={styles.glyph}
                    style={{
                        width: `${glyphSize}px`,
                        height: `${glyphSize}px`,
                        WebkitMaskImage: `url("${mark.src}")`,
                        maskImage: `url("${mark.src}")`,
                    }}
                />
            );
        } else if (mark) {
            glyph = (
                <img
                    src={mark.src}
                    alt=""
                    aria-hidden="true"
                    className={styles.glyphImg}
                    style={{ width: `${glyphSize}px`, height: `${glyphSize}px` }}
                />
            );
        } else {
            glyph = providerName.charAt(0);
        }

        const tooltipLines = [
            providerName,
            ...group.offers.map((offer) => `${slotDisplayName(offer.slot)} · ${statusLabel(offer)}`),
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
                    style={{ width: `${diameter}px`, height: `${diameter}px` }}
                    aria-label={`${providerName} source`}
                >
                    {glyph}
                </span>
            </Tooltip>
        );
    };

    const renderQualityBadge = (offer: ProviderQualityOffer, groupIndex: number, offerIndex: number) => {
        const providerName = providerDisplayName(offer.provider);
        const tooltipLines = [
            `${providerName} · ${slotDisplayName(offer.slot)} · ${statusLabel(offer)}`,
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
