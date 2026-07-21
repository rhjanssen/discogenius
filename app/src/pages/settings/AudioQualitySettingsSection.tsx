import {
    Radio,
    RadioGroup,
    Switch,
    Text,
    makeStyles,
    tokens,
} from "@fluentui/react-components";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { glassSurfaceStyles } from "@/components/ui/glassSurfaceStyles";
import type { QualityConfigContract } from "@contracts/config";

export type AudioQualityValue = QualityConfigContract["audio_quality"];

export interface AudioQualitySettingsSectionProps {
    audioQuality: AudioQualityValue;
    includeSpatial: boolean;
    onAudioQualityChange: (quality: AudioQualityValue) => void | Promise<void>;
    onIncludeSpatialChange: (includeSpatial: boolean) => void | Promise<void>;
}

const MEDIA = {
    mobile: "@media (max-width: 640px)",
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
        rowGap: tokens.spacingVerticalXS,
    },
};

const QUALITY_OPTIONS: Array<{
    value: AudioQualityValue;
    label: string;
    description: string;
}> = [
    { value: "low", label: "Low", description: "Smaller files, lower quality" },
    { value: "normal", label: "Normal", description: "Good quality for everyday listening" },
    { value: "high", label: "High", description: "CD quality (lossless)" },
    { value: "max", label: "Max", description: "Highest available quality (hi-res when offered)" },
];

const useStyles = makeStyles({
    section: {
        display: "flex",
        width: "100%",
        breakInside: "avoid",
        WebkitColumnBreakInside: "avoid",
        pageBreakInside: "avoid",
        marginBottom: tokens.spacingVerticalM,
        flexDirection: "column",
        gap: tokens.spacingVerticalS,
    },
    card: {
        ...glassSurfaceStyles,
        borderRadius: tokens.borderRadiusMedium,
        padding: tokens.spacingVerticalNone,
        overflow: "hidden",
        border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    },
    qualityOption: {
        display: "flex",
        alignItems: "flex-start",
        padding: MODAL_LAYOUT.qualityPadding.base,
        gap: tokens.spacingHorizontalM,
        cursor: "pointer",
        width: "100%",
        boxSizing: "border-box",
        "&:hover": {
            backgroundColor: tokens.colorNeutralBackground1Hover,
        },
        [MEDIA.mobile]: {
            padding: MODAL_LAYOUT.qualityPadding.mobile,
            gap: tokens.spacingHorizontalS,
        },
    },
    qualityRadioGroup: {
        display: "flex",
        flexDirection: "column",
        rowGap: tokens.spacingVerticalNone,
        gap: tokens.spacingVerticalNone,
        "& > *": {
            marginTop: tokens.spacingVerticalNone,
            marginBottom: tokens.spacingVerticalNone,
        },
    },
    qualityContent: {
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalNone,
        flex: 1,
    },
    mutedText: {
        color: tokens.colorNeutralForeground2,
    },
    rowAfterGroup: {
        ...rowBase,
        borderTop: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
        borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
        "&:last-child": {
            borderBottom: "none",
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
});

export const AudioQualitySettingsSection = ({
    audioQuality,
    includeSpatial,
    onAudioQualityChange,
    onIncludeSpatialChange,
}: AudioQualitySettingsSectionProps) => {
    const styles = useStyles();

    return (
        <SettingsSection
            id="audio-quality"
            title="Audio quality"
            description="Preferred quality for new stereo downloads and upgrades."
            className={styles.section}
        >
            <div className={styles.card}>
                <RadioGroup
                    className={styles.qualityRadioGroup}
                    value={audioQuality || "max"}
                    onChange={(_, data) => onAudioQualityChange(
                        data.value as AudioQualityValue,
                    )}
                >
                    {QUALITY_OPTIONS.map((option) => (
                        <label key={option.value} className={styles.qualityOption} htmlFor={`quality-${option.value}`}>
                            <Radio value={option.value} id={`quality-${option.value}`} />
                            <div className={styles.qualityContent}>
                                <Text weight="semibold">{option.label}</Text>
                                <Text size={200} className={styles.mutedText}>
                                    {option.description}
                                </Text>
                            </div>
                        </label>
                    ))}
                </RadioGroup>
                <div className={styles.rowAfterGroup}>
                    <div className={styles.rowContent}>
                        <Text weight="semibold">Spatial audio</Text>
                        <Text size={200} className={styles.mutedText}>
                            Also keep Dolby Atmos or other spatial versions when available.
                        </Text>
                    </div>
                    <div className={styles.rowControl}>
                        <Switch
                            checked={includeSpatial}
                            onChange={(_, data) => onIncludeSpatialChange(data.checked)}
                        />
                    </div>
                </div>
            </div>
        </SettingsSection>
    );
};

export default AudioQualitySettingsSection;
