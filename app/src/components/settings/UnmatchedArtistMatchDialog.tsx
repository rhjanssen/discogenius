import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
    Badge,
    Button,
    Caption1,
    Dialog,
    DialogActions,
    DialogBody,
    DialogContent,
    DialogSurface,
    DialogTitle,
    Field,
    Input,
    Spinner,
    Text,
    makeStyles,
    mergeClasses,
    tokens,
} from "@fluentui/react-components";
import { api } from "@/services/api";
import type { ManualMatchCandidateContract } from "@contracts/system-status";

export interface UnmatchedArtistTarget {
    provider: string;
    providerId: string;
    name: string;
}

const useStyles = makeStyles({
    candidateList: {
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalXS,
        maxHeight: "340px",
        overflowY: "auto",
    },
    candidate: {
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalXXS,
        padding: tokens.spacingVerticalS,
        borderRadius: tokens.borderRadiusMedium,
        border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
        cursor: "pointer",
        textAlign: "left",
        backgroundColor: "transparent",
        ":hover": {
            backgroundColor: tokens.colorNeutralBackground1Hover,
        },
    },
    candidateSelected: {
        border: `${tokens.strokeWidthThick} solid ${tokens.colorBrandStroke1}`,
        backgroundColor: tokens.colorBrandBackground2,
    },
    candidateHeader: {
        display: "flex",
        alignItems: "center",
        gap: tokens.spacingHorizontalS,
        flexWrap: "wrap",
    },
    mutedText: {
        color: tokens.colorNeutralForeground3,
    },
    sharedAlbums: {
        color: tokens.colorNeutralForeground2,
    },
    emptyState: {
        padding: tokens.spacingVerticalL,
        textAlign: "center",
    },
    errorText: {
        color: tokens.colorPaletteRedForeground1,
    },
    mbidField: {
        marginTop: tokens.spacingVerticalS,
    },
});

function CandidateRow({
    candidate,
    selected,
    onSelect,
    styles,
}: {
    candidate: ManualMatchCandidateContract;
    selected: boolean;
    onSelect: () => void;
    styles: ReturnType<typeof useStyles>;
}) {
    return (
        <button
            type="button"
            className={mergeClasses(styles.candidate, selected ? styles.candidateSelected : undefined)}
            onClick={onSelect}
            aria-pressed={selected}
        >
            <div className={styles.candidateHeader}>
                <Text size={300} weight="semibold">{candidate.name}</Text>
                {candidate.disambiguation ? (
                    <Caption1 className={styles.mutedText}>({candidate.disambiguation})</Caption1>
                ) : null}
                {candidate.sharedAlbums.length > 0 ? (
                    <Badge appearance="tint" color="success">
                        {`${candidate.sharedAlbums.length} shared album${candidate.sharedAlbums.length === 1 ? "" : "s"}`}
                    </Badge>
                ) : null}
                {candidate.nameMatched ? (
                    <Badge appearance="tint" color="informative">Name match</Badge>
                ) : null}
            </div>
            <Caption1 className={styles.mutedText}>
                {[candidate.type, `${candidate.releaseCount} release${candidate.releaseCount === 1 ? "" : "s"} on MusicBrainz`]
                    .filter(Boolean)
                    .join(" · ")}
            </Caption1>
            {candidate.sharedAlbums.length > 0 ? (
                <Caption1 className={styles.sharedAlbums}>
                    {`Both have: ${candidate.sharedAlbums.slice(0, 4).join(", ")}${candidate.sharedAlbums.length > 4 ? ", …" : ""}`}
                </Caption1>
            ) : null}
        </button>
    );
}

/**
 * Human-in-the-loop match for a provider artist automation refused to guess:
 * shows MusicBrainz candidates ranked with the automatic matcher's own
 * evidence (shared album titles, name match, catalog size) plus a raw-MBID
 * escape hatch for artists the search cannot find.
 */
export const UnmatchedArtistMatchDialog = ({
    target,
    onClose,
}: {
    target: UnmatchedArtistTarget | null;
    onClose: () => void;
}) => {
    const styles = useStyles();
    const queryClient = useQueryClient();
    const [selectedMbid, setSelectedMbid] = useState<string | null>(null);
    const [manualMbid, setManualMbid] = useState("");

    const { data, isLoading, error } = useQuery({
        queryKey: ["unmatched-artist-candidates", target?.provider, target?.providerId],
        queryFn: () => api.getUnmatchedArtistCandidates(target!.provider, target!.providerId),
        enabled: Boolean(target),
        staleTime: 60_000,
    });

    const applyMutation = useMutation({
        mutationFn: (mbid: string) => api.applyUnmatchedArtistMatch(target!.provider, target!.providerId, mbid),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: ["system-status"] });
            handleClose();
        },
    });

    const handleClose = () => {
        setSelectedMbid(null);
        setManualMbid("");
        applyMutation.reset();
        onClose();
    };

    const effectiveMbid = manualMbid.trim() || selectedMbid;

    return (
        <Dialog open={Boolean(target)} onOpenChange={(_event, dialogData) => { if (!dialogData.open) handleClose(); }}>
            <DialogSurface>
                <DialogBody>
                    <DialogTitle>{target ? `Match “${target.name}”` : "Match artist"}</DialogTitle>
                    <DialogContent>
                        {isLoading ? (
                            <div className={styles.emptyState}>
                                <Spinner label="Comparing discographies…" />
                            </div>
                        ) : error ? (
                            <Text className={styles.errorText}>
                                {error instanceof Error ? error.message : "Could not load candidates."}
                            </Text>
                        ) : (
                            <>
                                {data && data.candidates.length > 0 ? (
                                    <div className={styles.candidateList}>
                                        {data.candidates.map((candidate) => (
                                            <CandidateRow
                                                key={candidate.mbid}
                                                candidate={candidate}
                                                selected={!manualMbid.trim() && selectedMbid === candidate.mbid}
                                                onSelect={() => { setSelectedMbid(candidate.mbid); setManualMbid(""); }}
                                                styles={styles}
                                            />
                                        ))}
                                    </div>
                                ) : (
                                    <div className={styles.emptyState}>
                                        <Caption1 className={styles.mutedText}>
                                            No MusicBrainz candidates found for this name. Paste an artist MBID below if you know it.
                                        </Caption1>
                                    </div>
                                )}
                                <Field
                                    className={styles.mbidField}
                                    label="Or paste a MusicBrainz artist ID"
                                    hint="The id from a musicbrainz.org/artist/… URL."
                                >
                                    <Input
                                        value={manualMbid}
                                        onChange={(_event, inputData) => setManualMbid(inputData.value)}
                                        placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                                    />
                                </Field>
                                {applyMutation.isError ? (
                                    <Text className={styles.errorText}>
                                        {applyMutation.error instanceof Error ? applyMutation.error.message : "Could not apply the match."}
                                    </Text>
                                ) : null}
                            </>
                        )}
                    </DialogContent>
                    <DialogActions>
                        <Button appearance="secondary" onClick={handleClose}>Cancel</Button>
                        <Button
                            appearance="primary"
                            disabled={!effectiveMbid || applyMutation.isPending}
                            onClick={() => { if (effectiveMbid) applyMutation.mutate(effectiveMbid); }}
                        >
                            {applyMutation.isPending ? "Matching…" : "Match and monitor"}
                        </Button>
                    </DialogActions>
                </DialogBody>
            </DialogSurface>
        </Dialog>
    );
};
