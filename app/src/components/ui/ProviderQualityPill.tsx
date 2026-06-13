import React from "react";
import { Tooltip, makeStyles, mergeClasses, tokens, shorthands } from "@fluentui/react-components";
import { QualityBadge } from "./QualityBadge";

type SlotName = "stereo" | "spatial";

interface ProviderQualityPillProps {
    /** Library slot this offer fills. */
    slot: SlotName;
    /** Audio quality tag (LOSSLESS, HIRES_LOSSLESS, DOLBY_ATMOS, …). */
    quality?: string | null;
    provider?: string | null;
    matchStatus?: string | null;
    providerAlbumId?: string | null;
    selectedReleaseMbid?: string | null;
    className?: string;
}

type ProviderMark = {
    src: string;
    /**
     * Monochrome brand marks (e.g. TIDAL's white diamonds) are rendered as a
     * masked glyph tinted with the theme foreground, so they stay visible on
     * both light and dark pills. Full-colour marks (Apple Music, Deezer) keep
     * their brand colours and render as an <img>.
     */
    monochrome: boolean;
};

// Keys cover both the hyphenated and underscored provider ids we persist.
const PROVIDER_MARKS: Record<string, ProviderMark> = {
    tidal: { src: "/assets/images/tidal_icon.svg", monochrome: true },
    apple: { src: "/assets/images/apple_music_icon.svg", monochrome: false },
    apple_music: { src: "/assets/images/apple_music_icon.svg", monochrome: false },
    "apple-music": { src: "/assets/images/apple_music_icon.svg", monochrome: false },
    deezer: { src: "/assets/images/deezer_icon.svg", monochrome: false },
};

const useStyles = makeStyles({
    // Outer capsule. Fully rounded; the inner quality badge is made circular too
    // so the two radii stay concentric instead of fighting each other.
    pill: {
        display: "inline-flex",
        alignItems: "center",
        flexShrink: 0,
        whiteSpace: "nowrap",
        columnGap: tokens.spacingHorizontalXXS,
        height: "22px",
        ...shorthands.padding(0, tokens.spacingHorizontalXXS),
        ...shorthands.borderRadius(tokens.borderRadiusCircular),
        ...shorthands.border(tokens.strokeWidthThin, "solid", tokens.colorNeutralStroke2),
        backgroundColor: tokens.colorNeutralBackground3,
        cursor: "default",
    },
    iconWrap: {
        position: "relative",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: "16px",
        height: "16px",
        flexShrink: 0,
    },
    // Full-colour brand mark.
    iconImg: {
        width: "14px",
        height: "14px",
        display: "block",
        objectFit: "contain",
    },
    // Monochrome brand mark, recoloured to the theme foreground via masking so
    // it never disappears on a same-colour background (the white TIDAL bug).
    iconGlyph: {
        width: "14px",
        height: "14px",
        display: "block",
        backgroundColor: tokens.colorNeutralForeground1,
        WebkitMaskRepeat: "no-repeat",
        maskRepeat: "no-repeat",
        WebkitMaskPosition: "center",
        maskPosition: "center",
        WebkitMaskSize: "contain",
        maskSize: "contain",
    },
    // Small status dot in the mark's corner; only drawn for matches that need
    // attention (probable / ambiguous) so verified offers stay clean. Its ring
    // matches the pill background so it reads as a cutout.
    statusDot: {
        position: "absolute",
        right: "-1px",
        bottom: "-1px",
        width: "7px",
        height: "7px",
        ...shorthands.borderRadius(tokens.borderRadiusCircular),
        ...shorthands.border("1.5px", "solid", tokens.colorNeutralBackground3),
        boxSizing: "content-box",
    },
    dotProbable: { backgroundColor: tokens.colorPaletteYellowBackground3 },
    dotAmbiguous: { backgroundColor: tokens.colorPaletteRedBackground3 },
    // Concentric inner badge: circular to echo the outer capsule, inset evenly.
    quality: {
        height: "16px",
        ...shorthands.borderRadius(tokens.borderRadiusCircular),
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

/**
 * One capsule per filled library slot: a provider mark fused with its quality
 * badge (e.g. TIDAL · 24-BIT). With multiple providers this shows where each
 * version came from — stereo from one, spatial from another. Match confidence
 * and the selected MusicBrainz edition live in the hover tooltip.
 */
export const ProviderQualityPill: React.FC<ProviderQualityPillProps> = ({
    slot,
    quality,
    provider,
    matchStatus,
    providerAlbumId,
    selectedReleaseMbid,
    className,
}) => {
    const styles = useStyles();

    const hasSelection = Boolean(String(providerAlbumId || "").trim());
    const status = hasSelection ? String(matchStatus || "probable").toLowerCase() : "unmatched";
    const providerName = providerDisplayName(provider);
    const key = providerKey(provider);
    const mark = PROVIDER_MARKS[key] || PROVIDER_MARKS[key.replace(/-/g, "_")];
    const combinedCount = String(providerAlbumId || "").split(";").filter(Boolean).length;

    const dotClass =
        status === "probable"
            ? styles.dotProbable
            : status === "ambiguous"
              ? styles.dotAmbiguous
              : null;

    const statusLabel =
        status === "verified"
            ? "verified match"
            : status === "probable"
              ? "probable match"
              : status === "ambiguous"
                ? "ambiguous match"
                : "no provider release selected";

    const tooltipLines = [
        `${providerName} · ${slotDisplayName(slot)} · ${statusLabel}`,
        hasSelection
            ? combinedCount > 1
                ? `${combinedCount} ${providerName} releases combined to cover the tracklist`
                : `${providerName} release ${providerAlbumId}`
            : `Refresh & curate the artist to look for a ${providerName} release.`,
        selectedReleaseMbid ? `MusicBrainz edition ${selectedReleaseMbid}` : null,
    ].filter(Boolean) as string[];

    let mark_node: React.ReactNode = null;
    if (mark?.monochrome) {
        mark_node = (
            <span
                aria-hidden="true"
                className={styles.iconGlyph}
                style={{ WebkitMaskImage: `url("${mark.src}")`, maskImage: `url("${mark.src}")` }}
            />
        );
    } else if (mark) {
        mark_node = <img src={mark.src} alt="" aria-hidden="true" className={styles.iconImg} />;
    } else {
        // Unknown provider — fall back to its initial.
        mark_node = <span aria-hidden="true">{providerName.charAt(0)}</span>;
    }

    return (
        <Tooltip
            withArrow
            relationship="description"
            content={{
                children: (
                    <div className={styles.tooltipBody}>
                        {tooltipLines.map((line) => (
                            <span key={line}>{line}</span>
                        ))}
                    </div>
                ),
            }}
        >
            <span
                className={mergeClasses(styles.pill, className)}
                aria-label={`${providerName} ${slotDisplayName(slot)} ${statusLabel}`}
            >
                <span className={styles.iconWrap}>
                    {mark_node}
                    {dotClass ? <span className={mergeClasses(styles.statusDot, dotClass)} aria-hidden="true" /> : null}
                </span>
                {quality ? <QualityBadge quality={quality} size="small" className={styles.quality} /> : null}
            </span>
        </Tooltip>
    );
};
