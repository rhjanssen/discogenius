import React from "react";
import { Badge, Tooltip, makeStyles, mergeClasses, tokens, shorthands } from "@fluentui/react-components";
import {
    CheckmarkCircle12Filled,
    QuestionCircle12Filled,
    Warning12Filled,
    DismissCircle12Filled,
} from "@fluentui/react-icons";

type SlotName = "stereo" | "spatial";

interface ProviderMatchBadgeProps {
    provider?: string | null;
    matchStatus?: string | null;
    slot: SlotName;
    providerAlbumId?: string | null;
    selectedReleaseMbid?: string | null;
    className?: string;
}

const useStyles = makeStyles({
    base: {
        fontWeight: tokens.fontWeightSemibold,
        ...shorthands.border("none"),
        columnGap: tokens.spacingHorizontalXXS,
        height: "20px",
        fontSize: tokens.fontSizeBase100,
        ...shorthands.padding(0, tokens.spacingHorizontalSNudge),
        cursor: "default",
    },
    tooltipBody: {
        display: "flex",
        flexDirection: "column",
        rowGap: tokens.spacingVerticalXXS,
    },
});

function providerDisplayName(provider?: string | null): string {
    const normalized = String(provider || "").trim().toLowerCase();
    if (!normalized) return "Provider";
    if (normalized === "tidal") return "TIDAL";
    return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function slotDisplayName(slot: SlotName): string {
    return slot === "spatial" ? "Spatial" : "Stereo";
}

/**
 * Shows how a MusicBrainz release group is matched to a streaming-provider
 * release for one library slot: verified/probable/ambiguous, or unmatched
 * when no provider offer is selected.
 */
export const ProviderMatchBadge: React.FC<ProviderMatchBadgeProps> = ({
    provider,
    matchStatus,
    slot,
    providerAlbumId,
    selectedReleaseMbid,
    className,
}) => {
    const styles = useStyles();

    const hasSelection = Boolean(String(providerAlbumId || "").trim());
    const status = hasSelection ? String(matchStatus || "probable").toLowerCase() : "unmatched";
    const providerName = providerDisplayName(provider);
    const combinedCount = String(providerAlbumId || "").split(";").filter(Boolean).length;

    let color: "success" | "warning" | "severe" | "informative" = "informative";
    let icon = <DismissCircle12Filled />;
    let label = `Not on ${providerName}`;

    if (status === "verified") {
        color = "success";
        icon = <CheckmarkCircle12Filled />;
        label = `${providerName} matched`;
    } else if (status === "probable") {
        color = "warning";
        icon = <QuestionCircle12Filled />;
        label = `${providerName} probable`;
    } else if (status === "ambiguous") {
        color = "severe";
        icon = <Warning12Filled />;
        label = `${providerName} ambiguous`;
    }

    const tooltipLines = [
        `${slotDisplayName(slot)} slot · ${hasSelection ? `${status} match` : "no provider release selected"}`,
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
            <Badge
                shape="rounded"
                appearance="tint"
                color={color}
                icon={icon}
                className={mergeClasses(styles.base, className)}
            >
                {label}
            </Badge>
        </Tooltip>
    );
};
