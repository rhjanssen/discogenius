import {
    Button,
    Checkbox,
    Spinner,
    Switch,
    Text,
    makeStyles,
    tokens,
} from "@fluentui/react-components";
import {
    ArrowSortDownLines24Regular,
    ArrowSortDownLines24Filled,
    bundleIcon,
} from "@fluentui/react-icons";
import type { ReactNode } from "react";
import { SettingsCard } from "@/components/settings/SettingsCard";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { glassButtonStyles } from "@/components/ui/glassButtonStyles";
import type { FilteringConfigContract } from "@contracts/config";

const ArrowSortDownLines24 = bundleIcon(ArrowSortDownLines24Filled, ArrowSortDownLines24Regular);

export interface CurationSettingsSectionProps {
    curationConfig: FilteringConfigContract | null;
    updating?: boolean;
    onUpdate: (updates: Partial<FilteringConfigContract>) => void | Promise<void>;
    onQueueCuration: () => void | Promise<void>;
}

const MEDIA = {
    mobile: "@media (max-width: 640px)",
    desktop: "@media (min-width: 1024px)",
};

const MODAL_LAYOUT = {
    rowPadding: {
        base: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
        mobile: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalS}`,
    },
};

const rowBase = {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    flexWrap: "wrap" as const,
    padding: MODAL_LAYOUT.rowPadding.base,
    columnGap: tokens.spacingHorizontalM,
    rowGap: tokens.spacingVerticalXS,
    [MEDIA.mobile]: {
        padding: MODAL_LAYOUT.rowPadding.mobile,
        columnGap: tokens.spacingHorizontalS,
        rowGap: tokens.spacingVerticalXS,
    },
};

const primaryReleaseTypeRows = [
    { key: "include_album", title: "Albums" },
    { key: "include_ep", title: "EPs" },
    { key: "include_single", title: "Singles" },
    { key: "include_broadcast", title: "Broadcasts" },
    { key: "include_other", title: "Other" },
] as const;

const secondaryReleaseTypeRows = [
    { key: "include_compilation", title: "Compilations" },
    { key: "include_soundtrack", title: "Soundtracks" },
    { key: "include_live", title: "Live" },
    { key: "include_remix", title: "Remix" },
    { key: "include_dj_mix", title: "DJ-mix" },
    { key: "include_mixtape_street", title: "Mixtape/Street" },
    { key: "include_demo", title: "Demo" },
    { key: "include_audiobook", title: "Audiobook" },
    { key: "include_field_recording", title: "Field recording" },
    // Speech rather than music; off by default.
    { key: "include_spokenword", title: "Spokenword" },
    { key: "include_interview", title: "Interview" },
    { key: "include_audio_drama", title: "Audio drama" },
] as const;

/**
 * MusicBrainz release statuses. Unlike the type rows above, these decide which
 * *Editions* automatic curation may pick — a Release Group stays in the
 * discography while it has one eligible Edition, and an excluded Edition is
 * still listed, still usable as matching evidence, and still monitorable by
 * hand.
 */
const releaseStatusRows = [
    { key: "include_status_official", title: "Official" },
    { key: "include_status_promotion", title: "Promotion" },
    { key: "include_status_bootleg", title: "Bootleg" },
    { key: "include_status_pseudo_release", title: "Pseudo-release" },
    { key: "include_status_withdrawn", title: "Withdrawn" },
    { key: "include_status_cancelled", title: "Cancelled" },
    { key: "include_status_expunged", title: "Expunged" },
] as const;

const musicVideoTypeRows = [
    { key: "include_video_official", title: "Official video" },
    { key: "include_video_live", title: "Live" },
    { key: "include_video_lyric", title: "Lyric" },
    // Visualiser also covers Official Audio / audio-only catalog cuts.
    { key: "include_video_visualizer", title: "Visualiser" },
] as const;

const useStyles = makeStyles({
    section: {
        display: "flex",
        width: "100%",
        minWidth: 0,
        marginBottom: tokens.spacingVerticalNone,
        flexDirection: "column",
        gap: tokens.spacingVerticalS,
    },
    subsectionHeader: {
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalXXS,
        padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
        borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
        borderTop: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
        "&:first-child": {
            borderTop: "none",
        },
    },
    row: {
        ...rowBase,
        borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
        "&:last-child": {
            borderBottom: "none",
        },
    },
    rowAfterGroup: {
        ...rowBase,
        borderTop: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
        borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
        "&:last-child": {
            borderBottom: "none",
        },
    },
    fullWidthButton: {
        ...glassButtonStyles,
        width: "100%",
        justifyContent: "center",
        minHeight: "36px",
        [MEDIA.mobile]: {
            minHeight: "40px",
        },
    },
    rowContent: {
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalXXS,
        flex: 1,
        minWidth: 0,
        paddingTop: tokens.spacingVerticalXXS,
    },
    rowControl: {
        display: "flex",
        alignItems: "center",
        flexShrink: 0,
        minHeight: "32px",
        paddingTop: tokens.spacingVerticalXXS,
    },
    checkboxList: {
        display: "grid",
        gridTemplateColumns: "1fr",
        paddingTop: tokens.spacingVerticalXXS,
        paddingBottom: tokens.spacingVerticalXS,
        [MEDIA.desktop]: {
            gridTemplateColumns: "1fr 1fr",
        },
    },
    checkboxRow: {
        display: "flex",
        alignItems: "center",
        minHeight: "28px",
        padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalM}`,
        [MEDIA.mobile]: {
            padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalS}`,
        },
    },
    mutedText: {
        color: tokens.colorNeutralForeground2,
    },
});

export const CurationSettingsSection = ({
    curationConfig,
    updating = false,
    onUpdate,
    onQueueCuration,
}: CurationSettingsSectionProps) => {
    const styles = useStyles();

    const renderToggleRow = ({
        title,
        description,
        checked,
        onChange,
        afterGroup = false,
    }: {
        title: string;
        description: ReactNode;
        checked: boolean;
        onChange: (checked: boolean) => void;
        afterGroup?: boolean;
    }) => (
        <div className={afterGroup ? styles.rowAfterGroup : styles.row}>
            <div className={styles.rowContent}>
                <Text weight="semibold">{title}</Text>
                <Text size={200} className={styles.mutedText}>
                    {description}
                </Text>
            </div>
            <div className={styles.rowControl}>
                <Switch
                    aria-label={title}
                    checked={checked}
                    onChange={(_, data) => onChange(data.checked)}
                />
            </div>
        </div>
    );

    const renderCheckboxRow = ({
        title,
        checked,
        onChange,
        rowKey,
    }: {
        title: string;
        checked: boolean;
        onChange: (checked: boolean) => void;
        rowKey?: string;
    }) => (
        <div key={rowKey} className={styles.checkboxRow}>
            <Checkbox
                checked={checked}
                onChange={(_, data) => onChange(Boolean(data.checked))}
                label={title}
            />
        </div>
    );

    return (
        <SettingsSection
            id="curation"
            title="Filters"
            description="Which release and music-video types to monitor and keep, and how to choose between versions."
            className={styles.section}
        >
            <SettingsCard>
                <div className={styles.subsectionHeader}>
                    <Text weight="semibold">Primary release types</Text>
                </div>
                <div className={styles.checkboxList}>
                    {primaryReleaseTypeRows.map((row) => renderCheckboxRow({
                        rowKey: row.key,
                        title: row.title,
                        checked: curationConfig?.[row.key] !== false,
                        onChange: (checked) => void onUpdate({ [row.key]: checked }),
                    }))}
                </div>
                <div className={styles.subsectionHeader}>
                    <Text weight="semibold">Secondary release types</Text>
                    <Text size={200} className={styles.mutedText}>
                        One enabled type is enough — a release tagged both Live and Spokenword is
                        included if either is on. Releases with no secondary type are judged on
                        their primary type alone.
                    </Text>
                </div>
                <div className={styles.checkboxList}>
                    {secondaryReleaseTypeRows.map((row) => renderCheckboxRow({
                        rowKey: row.key,
                        title: row.title,
                        checked: curationConfig?.[row.key] === true,
                        onChange: (checked) => void onUpdate({ [row.key]: checked }),
                    }))}
                </div>
                <div className={styles.subsectionHeader}>
                    <Text weight="semibold">Release status</Text>
                    <Text size={200} className={styles.mutedText}>
                        Which editions Curate Library may choose. Editions whose status is
                        unchecked — or that MusicBrainz gives no status at all — stay listed and can
                        still be monitored manually.
                    </Text>
                </div>
                <div className={styles.checkboxList}>
                    {releaseStatusRows.map((row) => renderCheckboxRow({
                        rowKey: row.key,
                        title: row.title,
                        checked: curationConfig?.[row.key] === true,
                        onChange: (checked) => void onUpdate({ [row.key]: checked }),
                    }))}
                </div>
                <div className={styles.subsectionHeader}>
                    <Text weight="semibold">Music video types</Text>
                    <Text size={200} className={styles.mutedText}>
                        Unchecked types are unmonitored by Curate Library and skipped by download automation.
                    </Text>
                </div>
                <div className={styles.checkboxList}>
                    {musicVideoTypeRows.map((row) => renderCheckboxRow({
                        rowKey: row.key,
                        title: row.title,
                        checked: curationConfig?.[row.key] !== false,
                        onChange: (checked) => void onUpdate({ [row.key]: checked }),
                    }))}
                </div>
                {renderToggleRow({
                    title: "Prefer explicit",
                    description: "When clean and explicit versions both exist, prefer the explicit edition and acquisition plan (including when one non-explicit track must be filled from the clean product).",
                    checked: curationConfig?.prefer_explicit !== false,
                    onChange: (checked) => void onUpdate({ prefer_explicit: checked }),
                    afterGroup: true,
                })}
                {renderToggleRow({
                    title: "Deduplicate coverage",
                    description: "Drop singles, EPs, and re-packages whose tracks are already covered by a larger monitored product (clean/explicit twins count as the same track).",
                    checked: curationConfig?.enable_redundancy_filter !== false,
                    onChange: (checked) => void onUpdate({ enable_redundancy_filter: checked }),
                })}
                {renderToggleRow({
                    title: "Require a download source",
                    description: "Only auto-monitor releases that at least one connected service can download.",
                    checked: curationConfig?.require_provider_availability === true,
                    onChange: (checked) => void onUpdate({ require_provider_availability: checked }),
                })}
                <div className={styles.row}>
                    <Button
                        appearance="outline"
                        className={styles.fullWidthButton}
                        icon={updating ? <Spinner size="tiny" /> : <ArrowSortDownLines24 />}
                        onClick={() => void onQueueCuration()}
                        disabled={updating}
                    >
                        {updating ? "Queueing..." : "Curate Library"}
                    </Button>
                </div>
            </SettingsCard>
        </SettingsSection>
    );
};

export default CurationSettingsSection;
