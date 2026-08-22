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
import { SettingsCard } from "@/components/settings/SettingsCard";
import { SettingsSection } from "@/components/settings/SettingsSection";
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
        minWidth: 0,
        marginBottom: tokens.spacingVerticalNone,
        flexDirection: "column",
        gap: tokens.spacingVerticalS,
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
            title="Metadata Source"
            description="Choose where artist, album, and track details come from."
            className={styles.section}
        >
            <SettingsCard>
                <RadioGroup
                    className={styles.qualityRadioGroup}
                    value={metadataSource}
                    onChange={(_, data) => onUpdateCatalog({ source: data.value as "servarr" | "musicbrainz" })}
                >
                    <label className={styles.qualityOption} htmlFor="metadata-source-servarr">
                        <Radio value="servarr" id="metadata-source-servarr" />
                        <div className={styles.qualityContent}>
                            <Text weight="semibold">Online catalog</Text>
                            <Text size={200} className={styles.mutedText}>
                                Hosted MusicBrainz-based catalog — easy setup. Some releases may match less precisely.
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
                            hint="Hostname or IP of your MusicBrainz-docker host. Do not use localhost when Discogenius itself runs in Docker — that is the container, not the mirror. Postgres 5432 and search 5000 are derived automatically."
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
                                placeholder="localhost or musicbrainz.mydomain.com"
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
            </SettingsCard>
        </SettingsSection>
    );
};

export default MetadataSourceSettingsSection;
