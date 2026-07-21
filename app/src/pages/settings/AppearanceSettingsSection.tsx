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
import { SettingsSection } from "@/components/settings/SettingsSection";
import { glassSurfaceStyles } from "@/components/ui/glassSurfaceStyles";
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
            <div className={styles.card}>
                <RadioGroup
                    className={styles.qualityRadioGroup}
                    value={theme}
                    onChange={(_, data) => onThemeChange(data.value as ThemeMode)}
                >
                    <label className={styles.qualityOption} htmlFor="theme-light">
                        <Radio value="light" id="theme-light" />
                        <div className={styles.qualityContent}>
                            <div className={styles.optionIconRow}>
                                <WeatherSunny24 />
                                <Text weight="semibold">Light</Text>
                            </div>
                        </div>
                    </label>
                    <label className={styles.qualityOption} htmlFor="theme-dark">
                        <Radio value="dark" id="theme-dark" />
                        <div className={styles.qualityContent}>
                            <div className={styles.optionIconRow}>
                                <WeatherMoon24 />
                                <Text weight="semibold">Dark</Text>
                            </div>
                        </div>
                    </label>
                    <label className={styles.qualityOption} htmlFor="theme-system">
                        <Radio value="system" id="theme-system" />
                        <div className={styles.qualityContent}>
                            <div className={styles.optionIconRow}>
                                <DesktopMac24 />
                                <Text weight="semibold">System</Text>
                            </div>
                        </div>
                    </label>
                </RadioGroup>
            </div>
        </SettingsSection>
    );
};

export default AppearanceSettingsSection;
