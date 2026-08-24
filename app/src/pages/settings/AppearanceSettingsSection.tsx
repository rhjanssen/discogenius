import {
    Radio,
    RadioGroup,
    Text,
    makeStyles,
    tokens,
} from "@fluentui/react-components";
import {
    WeatherMoon24Regular,
    WeatherSunny24Regular,
    DesktopMac24Regular,
    WeatherMoon24Filled,
    WeatherSunny24Filled,
    DesktopMac24Filled,
    bundleIcon,
} from "@fluentui/react-icons";
import { SettingsCard } from "@/components/settings/SettingsCard";
import { SettingsSection } from "@/components/settings/SettingsSection";
import type { ThemeMode } from "@/providers/themeContext";

const WeatherMoon24 = bundleIcon(WeatherMoon24Filled, WeatherMoon24Regular);
const WeatherSunny24 = bundleIcon(WeatherSunny24Filled, WeatherSunny24Regular);
const DesktopMac24 = bundleIcon(DesktopMac24Filled, DesktopMac24Regular);

export interface AppearanceSettingsSectionProps {
    theme: ThemeMode;
    onThemeChange: (theme: ThemeMode) => void;
}

const MEDIA = {
    mobile: "@media (max-width: 640px)",
};

const MODAL_LAYOUT = {
    qualityPadding: {
        base: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
        mobile: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalS}`,
    },
};

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
    optionIconRow: {
        display: "flex",
        alignItems: "center",
        gap: tokens.spacingHorizontalS,
    },
});

export const AppearanceSettingsSection = ({
    theme,
    onThemeChange,
}: AppearanceSettingsSectionProps) => {
    const styles = useStyles();

    return (
        <SettingsSection
            id="appearance"
            title="Appearance"
            description="Choose the theme used across the app."
            className={styles.section}
        >
            <SettingsCard>
                <RadioGroup
                    className={styles.qualityRadioGroup}
                    value={theme}
                    aria-label="Theme"
                    onChange={(_, data) => onThemeChange(data.value as ThemeMode)}
                >
                    <Radio
                        className={styles.qualityOption}
                        value="light"
                        label={(
                            <div className={styles.qualityContent}>
                                <div className={styles.optionIconRow}>
                                    <WeatherSunny24 />
                                    <Text weight="semibold">Light</Text>
                                </div>
                            </div>
                        )}
                    />
                    <Radio
                        className={styles.qualityOption}
                        value="dark"
                        label={(
                            <div className={styles.qualityContent}>
                                <div className={styles.optionIconRow}>
                                    <WeatherMoon24 />
                                    <Text weight="semibold">Dark</Text>
                                </div>
                            </div>
                        )}
                    />
                    <Radio
                        className={styles.qualityOption}
                        value="system"
                        label={(
                            <div className={styles.qualityContent}>
                                <div className={styles.optionIconRow}>
                                    <DesktopMac24 />
                                    <Text weight="semibold">System</Text>
                                </div>
                            </div>
                        )}
                    />
                </RadioGroup>
            </SettingsCard>
        </SettingsSection>
    );
};

export default AppearanceSettingsSection;
