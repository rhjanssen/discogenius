import React from "react";
import { Badge, Tooltip, makeStyles, mergeClasses, tokens, shorthands } from "@fluentui/react-components";
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

// Per-provider brand marks. Keys cover both the hyphenated and underscored
// provider ids we persist (apple-music / apple_music).
const PROVIDER_ICONS: Record<string, string> = {
    tidal: "/assets/images/tidal_icon.svg",
    apple: "/assets/images/apple_music_icon.svg",
    apple_music: "/assets/images/apple_music_icon.svg",
    "apple-music": "/assets/images/apple_music_icon.svg",
    deezer: "/assets/images/deezer_icon.svg",
};

const useStyles = makeStyles({
    // The pill groups a provider mark with its quality badge into one chip that
    // never squishes — text stays inside the rounded body at any container width.
    pill: {
        display: "inline-flex",
        alignItems: "center",
        flexShrink: 0,
        whiteSpace: "nowrap",
        columnGap: tokens.spacingHorizontalXS,
        height: "24px",
        ...shorthands.padding(0, tokens.spacingHorizontalXS, 0, tokens.spacingHorizontalXXS),
        ...shorthands.borderRadius(tokens.borderRadiusCircular),
        ...shorthands.border(tokens.strokeWidthThin, "solid", tokens.colorNeutralStroke2),
        backgroundColor: tokens.colorNeutralBackground1,
        cursor: "default",
    },
    iconWrap: {
        position: "relative",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: "20px",
        height: "20px",
        flexShrink: 0,
    },
    icon: {
        width: "16px",
        height: "16px",
        display: "block",
        objectFit: "contain",
    },
    // A small status dot in the corner of the provider mark; only drawn when the
    // match needs attention (probable / ambiguous), so verified offers stay clean.
    statusDot: {
        position: "absolute",
        right: 0,
        bottom: 0,
        width: "7px",
        height: "7px",
        ...shorthands.borderRadius(tokens.borderRadiusCircular),
        ...shorthands.border(tokens.strokeWidthThin, "solid", tokens.colorNeutralBackground1),
        boxSizing: "content-box",
    },
    dotProbable: { backgroundColor: tokens.colorPaletteYellowBackground3 },
    dotAmbiguous: { backgroundColor: tokens.colorPaletteRedBackground3 },
    // The embedded quality badge keeps its own brand colours; trim its size so it
    // reads as part of the pill rather than a second free-floating badge.
    quality: {
        height: "18px",
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
 * One chip per filled library slot: a provider mark fused with its quality
 * badge (e.g. TIDAL · 24-BIT). With multiple providers this lets the user see
 * at a glance where each version came from — stereo from one, spatial from
 * another. Match confidence and the selected MusicBrainz edition live in the
 * hover tooltip to keep the row uncluttered.
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
    const iconSrc = PROVIDER_ICONS[key] || PROVIDER_ICONS[key.replace(/-/g, "_")];
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
            <span className={mergeClasses(styles.pill, className)} aria-label={`${providerName} ${slotDisplayName(slot)} ${statusLabel}`}>
                <span className={styles.iconWrap}>
                    {iconSrc ? (
                        <img src={iconSrc} alt="" aria-hidden="true" className={styles.icon} />
                    ) : (
                        <Badge size="small" appearance="tint" color="informative" shape="circular">
                            {providerName.charAt(0)}
                        </Badge>
                    )}
                    {dotClass ? <span className={mergeClasses(styles.statusDot, dotClass)} aria-hidden="true" /> : null}
                </span>
                {quality ? <QualityBadge quality={quality} size="small" className={styles.quality} /> : null}
            </span>
        </Tooltip>
    );
};
