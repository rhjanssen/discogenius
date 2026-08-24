import {
    Select,
    Switch,
    Text,
    makeStyles,
    tokens,
} from "@fluentui/react-components";
import type { ReactNode } from "react";
import { SettingsCard } from "@/components/settings/SettingsCard";
import { SettingsSection } from "@/components/settings/SettingsSection";
import type { MetadataConfigContract } from "@contracts/config";

const MEDIA = { mobile: "@media (max-width: 640px)" };

const useStyles = makeStyles({
    section: {
        display: "flex",
        width: "100%",
        minWidth: 0,
        flexDirection: "column",
        gap: tokens.spacingVerticalS,
    },
    row: {
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "space-between",
        flexWrap: "wrap",
        columnGap: tokens.spacingHorizontalM,
        rowGap: tokens.spacingVerticalXS,
        padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
        borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
        "&:last-child": { borderBottom: "none" },
        [MEDIA.mobile]: {
            padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalS}`,
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
    control: {
        width: "192px",
        maxWidth: "100%",
    },
    mutedText: { color: tokens.colorNeutralForeground2 },
});

type MetadataSettings = Partial<MetadataConfigContract> | null | undefined;

export interface MetadataFilesSettingsSectionProps {
    metadataSettings: MetadataSettings;
    updateMetadataSettings: (updates: Partial<MetadataConfigContract>) => void | Promise<void>;
}

export const MetadataFilesSettingsSection = ({
    metadataSettings,
    updateMetadataSettings,
}: MetadataFilesSettingsSectionProps) => {
    const styles = useStyles();
    const writeAudioTagsPolicy = metadataSettings?.write_audio_tags_policy ?? "no";

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
                <Switch aria-label={options.title} checked={options.checked} onChange={(_, data) => options.onChange(data.checked)} />
            </div>
        </div>
    );

    return (
        <SettingsSection
            id="metadata"
            title="Metadata"
            description="What Discogenius writes into files and keeps beside them in the library."
            className={styles.section}
        >
            <SettingsCard>
                <div className={styles.row}>
                    <div className={styles.rowContent}>
                        <Text weight="semibold">Write audio tags</Text>
                        <Text size={200} className={styles.mutedText}>
                            Embed titles, artists, albums, and MusicBrainz IDs in audio files.
                        </Text>
                    </div>
                    <div className={styles.rowControl}>
                        <Select
                            aria-label="Write audio tags"
                            value={writeAudioTagsPolicy}
                            onChange={(_, data) => updateMetadataSettings({
                                write_audio_tags_policy: data.value as "no" | "new_files" | "all_files" | "sync",
                            })}
                            className={styles.control}
                        >
                            <option value="no">Off</option>
                            <option value="new_files">New downloads only</option>
                            <option value="all_files">All files</option>
                            <option value="sync">New files, and after metadata refresh</option>
                        </Select>
                    </div>
                </div>

                {renderToggleRow({
                    title: "Save album covers",
                    description: "Keep cover art in the album folder. Animated covers are kept when available.",
                    checked: metadataSettings?.save_album_cover === true,
                    onChange: (checked) => void updateMetadataSettings({ save_album_cover: checked }),
                })}

                <div className={styles.row}>
                    <div className={styles.rowContent}>
                        <Text weight="semibold">Preferred artwork</Text>
                        <Text size={200} className={styles.mutedText}>
                            Prefer catalog artwork or artwork from the streaming service. The other source is used as fallback.
                        </Text>
                    </div>
                    <div className={styles.rowControl}>
                        <Select
                            aria-label="Preferred artwork"
                            value={metadataSettings?.artwork_preference === "provider" ? "provider" : "canonical"}
                            onChange={(_, data) => updateMetadataSettings({
                                artwork_preference: data.value as "canonical" | "provider",
                            })}
                            className={styles.control}
                        >
                            <option value="canonical">Catalog artwork</option>
                            <option value="provider">Streaming service</option>
                        </Select>
                    </div>
                </div>

                {renderToggleRow({
                    title: "Save NFO files",
                    description: "Write sidecar info files next to albums for media servers and scrapers.",
                    checked: metadataSettings?.save_nfo === true,
                    onChange: (checked) => void updateMetadataSettings({ save_nfo: checked }),
                })}
                {renderToggleRow({
                    title: "Save lyrics",
                    description: "Save a lyrics file next to each track. Synced lyrics are used when available.",
                    checked: metadataSettings?.save_lyrics === true,
                    onChange: (checked) => void updateMetadataSettings({ save_lyrics: checked }),
                })}
                {renderToggleRow({
                    title: "Save artist pictures",
                    description: "Keep artist images in the artist folder.",
                    checked: metadataSettings?.save_artist_picture === true,
                    onChange: (checked) => void updateMetadataSettings({ save_artist_picture: checked }),
                })}
                {renderToggleRow({
                    title: "Save video thumbnails",
                    description: "Keep a thumbnail image next to each music video for media servers.",
                    checked: metadataSettings?.save_video_thumbnail === true,
                    onChange: (checked) => void updateMetadataSettings({ save_video_thumbnail: checked }),
                })}
                {renderToggleRow({
                    title: "Embed video thumbnails",
                    description: "Also embed the thumbnail inside the video file when possible.",
                    checked: metadataSettings?.embed_video_thumbnail !== false,
                    onChange: (checked) => void updateMetadataSettings({ embed_video_thumbnail: checked }),
                })}
                {renderToggleRow({
                    title: "Fingerprint imported files",
                    description: "For files you already have, use audio fingerprinting to confirm the correct track before tagging.",
                    checked: metadataSettings?.enable_fingerprinting === true,
                    onChange: (checked) => void updateMetadataSettings({ enable_fingerprinting: checked }),
                })}
            </SettingsCard>
        </SettingsSection>
    );
};

export default MetadataFilesSettingsSection;
