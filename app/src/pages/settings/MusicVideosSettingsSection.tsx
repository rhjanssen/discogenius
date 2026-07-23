import {
    Button,
    Radio,
    RadioGroup,
    Select,
    Switch,
    Text,
    makeStyles,
    tokens,
} from "@fluentui/react-components";
import {
    QuestionCircle24Regular,
    QuestionCircle24Filled,
    bundleIcon,
} from "@fluentui/react-icons";
import type { ReactNode } from "react";
import { SettingsCard } from "@/components/settings/SettingsCard";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { AppTooltip } from "@/components/ui/AppTooltip";
import type {
    FilteringConfigContract,
    PathConfigContract,
    QualityConfigContract,
} from "@contracts/config";

const QuestionCircle24 = bundleIcon(QuestionCircle24Filled, QuestionCircle24Regular);

const MEDIA = {
    mobile: "@media (max-width: 640px)",
    desktop: "@media (min-width: 1024px)",
};

const MODAL_LAYOUT = {
    rowPadding: {
        base: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
        mobile: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalS}`,
    },
    qualityPadding: {
        base: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
        mobile: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalS}`,
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
    },
};

const VIDEO_QUALITY_OPTIONS: Array<{ value: QualityConfigContract["video_quality"]; label: string }> = [
    { value: "sd", label: "SD · 480p" },
    { value: "hd", label: "HD · 720p" },
    { value: "fhd", label: "Full HD · 1080p" },
    { value: "uhd", label: "Ultra HD · 2160p" },
];

const useStyles = makeStyles({
    section: {
        display: "flex",
        width: "100%",
        minWidth: 0,
        flexDirection: "column",
        gap: tokens.spacingVerticalS,
    },
    row: {
        ...rowBase,
        borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
        "&:last-child": { borderBottom: "none" },
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
    labelWithHelp: {
        display: "flex",
        alignItems: "center",
        gap: tokens.spacingHorizontalXXS,
        minWidth: 0,
    },
    helpButton: {
        minWidth: "28px",
        minHeight: "28px",
    },
    controlWide: {
        width: "192px",
        maxWidth: "100%",
    },
    qualityRadioGroup: {
        display: "flex",
        flexDirection: "column",
        rowGap: tokens.spacingVerticalNone,
        gap: tokens.spacingVerticalNone,
        "& > *": { marginTop: 0, marginBottom: 0 },
    },
    qualityOption: {
        display: "flex",
        alignItems: "center",
        padding: MODAL_LAYOUT.qualityPadding.base,
        gap: tokens.spacingHorizontalM,
        cursor: "pointer",
        width: "100%",
        boxSizing: "border-box",
        "&:hover": { backgroundColor: tokens.colorNeutralBackground1Hover },
        [MEDIA.mobile]: {
            padding: MODAL_LAYOUT.qualityPadding.mobile,
            gap: tokens.spacingHorizontalS,
        },
    },
    mutedText: {
        color: tokens.colorNeutralForeground2,
    },
});

export interface MusicVideosSettingsSectionProps {
    curationConfig: FilteringConfigContract | null;
    videoQuality: QualityConfigContract["video_quality"];
    videoFolderLayout: PathConfigContract["video_folder_layout"];
    onUpdateCuration: (updates: Partial<FilteringConfigContract>) => void | Promise<void>;
    onVideoQualityChange: (quality: QualityConfigContract["video_quality"]) => void | Promise<void>;
    onVideoFolderLayoutChange: (layout: PathConfigContract["video_folder_layout"]) => void | Promise<void>;
}

const FOLDER_LAYOUT_HELP =
    "Separated keeps videos in the video library. "
    + "Inline places a linked video beside its stereo track when the album is monitored; otherwise it stays separated. "
    + "Album-linked only uses that inline placement but never downloads videos that would only land in the video library.";

export const MusicVideosSettingsSection = ({
    curationConfig,
    videoQuality,
    videoFolderLayout,
    onUpdateCuration,
    onVideoQualityChange,
    onVideoFolderLayoutChange,
}: MusicVideosSettingsSectionProps) => {
    const styles = useStyles();
    const downloadEnabled = curationConfig?.include_videos === true;

    const renderToggleRow = (options: {
        title: string;
        description: ReactNode;
        checked: boolean;
        onChange: (checked: boolean) => void;
    }) => (
        <div className={styles.row}>
            <div className={styles.rowContent}>
                <Text weight="semibold">{options.title}</Text>
                <Text size={200} className={styles.mutedText}>{options.description}</Text>
            </div>
            <div className={styles.rowControl}>
                <Switch checked={options.checked} onChange={(_, data) => options.onChange(data.checked)} />
            </div>
        </div>
    );

    return (
        <SettingsSection
            id="music-videos"
            title="Music videos"
            description="What music videos to collect, at which resolution, and where they live in the library."
            className={styles.section}
        >
            <SettingsCard>
                {renderToggleRow({
                    title: "Download music videos",
                    description: "Queue monitored videos for download when a connected service offers them.",
                    checked: downloadEnabled,
                    onChange: (checked) => void onUpdateCuration({ include_videos: checked }),
                })}

                <RadioGroup
                    className={styles.qualityRadioGroup}
                    value={videoQuality || "uhd"}
                    onChange={(_, data) => onVideoQualityChange(data.value as QualityConfigContract["video_quality"])}
                >
                    {VIDEO_QUALITY_OPTIONS.map((option) => (
                        <label key={option.value} className={styles.qualityOption} htmlFor={`video-quality-${option.value}`}>
                            <Radio value={option.value} id={`video-quality-${option.value}`} />
                            <Text weight="semibold">{option.label}</Text>
                        </label>
                    ))}
                </RadioGroup>

                <div className={styles.row}>
                    <div className={styles.rowContent}>
                        <div className={styles.labelWithHelp}>
                            <Text weight="semibold">Folder layout</Text>
                            <AppTooltip relationship="description" withArrow content={FOLDER_LAYOUT_HELP}>
                                <Button
                                    appearance="subtle"
                                    icon={<QuestionCircle24 />}
                                    className={styles.helpButton}
                                    aria-label="Video folder layout help"
                                />
                            </AppTooltip>
                        </div>
                        <Text size={200} className={styles.mutedText}>
                            Where music videos live relative to albums.
                        </Text>
                    </div>
                    <div className={styles.rowControl}>
                        <Select
                            value={videoFolderLayout || "separated"}
                            onChange={(_, data) => onVideoFolderLayoutChange(
                                data.value as PathConfigContract["video_folder_layout"],
                            )}
                            className={styles.controlWide}
                        >
                            <option value="separated">Separated library</option>
                            <option value="inline">Inline with albums when possible</option>
                            <option value="inline_only">Album-linked only</option>
                        </Select>
                    </div>
                </div>
            </SettingsCard>
        </SettingsSection>
    );
};

export default MusicVideosSettingsSection;
