import {
    Button,
    Field,
    Input,
    Radio,
    RadioGroup,
    Spinner,
    Text,
    makeStyles,
    tokens,
} from "@fluentui/react-components";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { glassSurfaceStyles } from "@/components/ui/glassSurfaceStyles";
import type { CatalogConfigContract } from "@contracts/config";

export type CatalogConnectionTestState = {
    status: "idle" | "testing" | "ok" | "error";
    message?: string;
};

export interface MetadataSourceSettingsSectionProps {
    catalogConfig: CatalogConfigContract | null;
    catalogTest: CatalogConnectionTestState;
    onUpdateCatalog: (updates: Partial<CatalogConfigContract>) => void | Promise<void>;
    onHostChange: (host: string) => void;
    onTestConnection: () => void;
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
    nestedFields: {
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalXS,
        padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
        borderTop: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
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
});

export const MetadataSourceSettingsSection = ({
    catalogConfig,
    catalogTest,
    onUpdateCatalog,
    onHostChange,
    onTestConnection,
}: MetadataSourceSettingsSectionProps) => {
    const styles = useStyles();
    const metadataSource = catalogConfig?.source ?? "servarr";

    return (
        <SettingsSection
            id="metadata-source"
            title="Metadata source"
            description="Choose where artist, album, and track details come from."
            className={styles.section}
        >
            <div className={styles.card}>
                <RadioGroup
                    className={styles.qualityRadioGroup}
                    value={metadataSource}
                    onChange={(_, data) => onUpdateCatalog({ source: data.value as "servarr" | "musicbrainz" })}
                >
                    <label className={styles.qualityOption} htmlFor="metadata-source-servarr">
                        <Radio value="servarr" id="metadata-source-servarr" />
                        <div className={styles.qualityContent}>
                            <Text weight="semibold">Servarr Metadata</Text>
                            <Text size={200} className={styles.mutedText}>
                                Hosted catalog — easy setup. Some releases and codes (ISRC/UPC) may be missing.
                            </Text>
                        </div>
                    </label>
                    <label className={styles.qualityOption} htmlFor="metadata-source-musicbrainz">
                        <Radio value="musicbrainz" id="metadata-source-musicbrainz" />
                        <div className={styles.qualityContent}>
                            <Text weight="semibold">MusicBrainz (local)</Text>
                            <Text size={200} className={styles.mutedText}>
                                Your own MusicBrainz mirror — fuller release data and better matching.
                            </Text>
                        </div>
                    </label>
                </RadioGroup>
                {metadataSource === "musicbrainz" ? (
                    <div className={styles.nestedFields}>
                        <Field
                            label="MusicBrainz host"
                            hint="Hostname or IP only. Discogenius uses the standard MusicBrainz ports automatically."
                            validationState={
                                catalogTest.status === "ok" ? "success"
                                    : catalogTest.status === "error" ? "error"
                                        : "none"
                            }
                            validationMessage={
                                catalogTest.status === "ok" || catalogTest.status === "error"
                                    ? catalogTest.message
                                    : undefined
                            }
                        >
                            <Input
                                value={catalogConfig?.musicbrainz_host ?? ""}
                                placeholder="192.168.1.100 or musicbrainz.mydomain.com"
                                onChange={(_, data) => onHostChange(data.value)}
                                onBlur={() => {
                                    if (catalogConfig) {
                                        void onUpdateCatalog({ musicbrainz_host: catalogConfig.musicbrainz_host });
                                    }
                                }}
                            />
                        </Field>
                        <Button
                            appearance="secondary"
                            style={{ alignSelf: "flex-start" }}
                            disabled={catalogTest.status === "testing" || !catalogConfig?.musicbrainz_host}
                            icon={catalogTest.status === "testing" ? <Spinner size="tiny" /> : undefined}
                            onClick={() => { void onTestConnection(); }}
                        >
                            Test connection
                        </Button>
                    </div>
                ) : null}
            </div>
        </SettingsSection>
    );
};

export default MetadataSourceSettingsSection;
