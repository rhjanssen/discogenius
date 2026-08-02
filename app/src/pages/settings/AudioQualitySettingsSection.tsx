import {
    Radio,
    RadioGroup,
    Switch,
    Text,
    makeStyles,
    tokens,
} from "@fluentui/react-components";
import { SettingsCard } from "@/components/settings/SettingsCard";
import { SettingsSection } from "@/components/settings/SettingsSection";
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
    { value: "low", label: "Low", description: "Prefer smaller files; higher quality still used when it is all that is offered" },
    { value: "normal", label: "Normal", description: "Prefer good everyday quality; falls back if needed" },
    { value: "high", label: "High", description: "Prefer CD quality (lossless); uses lower quality when lossless is unavailable" },
    { value: "max", label: "Max", description: "Prefer hi-res, then lossless, then lower — never hide a provider that only has lossy" },
];

const useStyles = makeStyles({
    section: {
        display: "flex",
        width: "100%",
        minWidth: 0,
        marginBottom: tokens.spacingVerticalNone,
        flexDirection: "column",
        gap: tokens.spacingVerticalS,
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
            description="Stereo library preference: acquisition planning, downloads, and upgrades. Spatial audio is a separate on/off library."
            className={styles.section}
        >
            <SettingsCard>
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
                            Enable the Spatial library for Dolby Atmos / spatial editions. Quality ladder stays on stereo; spatial is on or off.
                        </Text>
                    </div>
                    <div className={styles.rowControl}>
                        <Switch
                            checked={includeSpatial}
                            onChange={(_, data) => onIncludeSpatialChange(data.checked)}
                        />
                    </div>
                </div>
            </SettingsCard>
        </SettingsSection>
    );
};

export default AudioQualitySettingsSection;
