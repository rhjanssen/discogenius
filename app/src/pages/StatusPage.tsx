import { useQuery } from "@tanstack/react-query";
import {
    Badge,
    Caption1,
    Spinner,
    Text,
    Title1,
    makeStyles,
    mergeClasses,
    tokens,
} from "@fluentui/react-components";
import {
    CheckmarkCircle16Regular,
    ErrorCircle16Regular,
    Warning16Regular,
} from "@fluentui/react-icons";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { api } from "@/services/api";
import type {
    HealthCheckResultContract,
    HealthCheckStatusContract,
    HealthOverallStatusContract,
} from "@contracts/system-status";
import type { StreamingProviderStatus } from "@/services/api";

const useStyles = makeStyles({
    container: {
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalM,
        padding: tokens.spacingVerticalM,
        maxWidth: "900px",
        margin: "0 auto",
        width: "100%",
        boxSizing: "border-box",
    },
    header: {
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalS,
        marginBottom: tokens.spacingVerticalM,
    },
    mutedText: {
        color: tokens.colorNeutralForeground3,
    },
    card: {
        backgroundColor: `color-mix(in srgb, ${tokens.colorNeutralBackground1} 60%, transparent)`,
        backdropFilter: "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
        borderRadius: tokens.borderRadiusMedium,
        overflow: "hidden",
        border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    },
    row: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: tokens.spacingHorizontalM,
        padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
        borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    },
    rowLast: {
        borderBottom: "none",
    },
    rowMain: {
        display: "flex",
        alignItems: "center",
        gap: tokens.spacingHorizontalS,
        minWidth: 0,
    },
    rowContent: {
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalXXS,
        minWidth: 0,
    },
    statusIconOk: {
        color: tokens.colorPaletteGreenForeground1,
        flexShrink: 0,
    },
    statusIconWarning: {
        color: tokens.colorPaletteYellowForeground1,
        flexShrink: 0,
    },
    statusIconError: {
        color: tokens.colorPaletteRedForeground1,
        flexShrink: 0,
    },
    capabilityRow: {
        display: "flex",
        flexWrap: "wrap",
        gap: tokens.spacingHorizontalXS,
        padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    },
    emptyState: {
        padding: tokens.spacingVerticalXL,
        textAlign: "center",
    },
    loading: {
        display: "flex",
        justifyContent: "center",
        padding: tokens.spacingVerticalXXXL,
    },
});

function statusIcon(status: HealthCheckStatusContract, styles: ReturnType<typeof useStyles>) {
    if (status === "ok") {
        return <CheckmarkCircle16Regular className={styles.statusIconOk} />;
    }
    if (status === "warning") {
        return <Warning16Regular className={styles.statusIconWarning} />;
    }
    return <ErrorCircle16Regular className={styles.statusIconError} />;
}

function overallBadgeColor(status: HealthOverallStatusContract): "success" | "warning" | "danger" {
    if (status === "healthy") return "success";
    if (status === "degraded") return "warning";
    return "danger";
}

function CheckRow({
    check,
    styles,
    last,
}: {
    check: HealthCheckResultContract;
    styles: ReturnType<typeof useStyles>;
    last?: boolean;
}) {
    return (
        <div className={mergeClasses(styles.row, last ? styles.rowLast : undefined)}>
            <div className={styles.rowMain}>
                {statusIcon(check.status, styles)}
                <div className={styles.rowContent}>
                    <Text size={300}>{check.message}</Text>
                    <Caption1 className={styles.mutedText}>{check.scope}</Caption1>
                </div>
            </div>
        </div>
    );
}

function ProviderRow({
    provider,
    styles,
    last,
}: {
    provider: StreamingProviderStatus;
    styles: ReturnType<typeof useStyles>;
    last?: boolean;
}) {
    const caps = provider.capabilities;
    const chips = [
        { label: "Downloads", value: caps.audioDownloads },
        { label: "Spatial audio", value: caps.spatialAudio },
        { label: "Music videos", value: caps.videoDownloads || caps.musicVideos },
        { label: "Previews", value: caps.audioPreviews },
    ].filter((chip) => chip.value);

    return (
        <div className={mergeClasses(styles.row, last ? styles.rowLast : undefined)}
            style={{ flexDirection: "column", alignItems: "stretch", gap: tokens.spacingVerticalXS }}
        >
            <div className={styles.rowMain}>
                {provider.authenticated
                    ? <CheckmarkCircle16Regular className={styles.statusIconOk} />
                    : <Warning16Regular className={styles.statusIconWarning} />}
                <div className={styles.rowContent}>
                    <Text size={300} weight="semibold">{provider.name}</Text>
                    <Caption1 className={styles.mutedText}>
                        {provider.authenticated ? "Connected" : "Not connected"}
                        {provider.isDefault ? " · Default provider" : ""}
                    </Caption1>
                </div>
            </div>
            {chips.length > 0 ? (
                <div className={styles.capabilityRow}>
                    {chips.map((chip) => (
                        <Badge key={chip.label} appearance="tint" color="informative">{chip.label}</Badge>
                    ))}
                </div>
            ) : null}
        </div>
    );
}

const StatusPage = () => {
    const styles = useStyles();

    const { data: status, isLoading: statusLoading } = useQuery({
        queryKey: ["system-status"],
        queryFn: () => api.getSystemStatus(),
        refetchInterval: 30000,
    });

    const { data: providersResponse, isLoading: providersLoading } = useQuery({
        queryKey: ["streaming-providers", "status-page"],
        queryFn: () => api.getStreamingProviders(),
        refetchInterval: 30000,
    });

    const { data: overview } = useQuery({
        queryKey: ["status-overview", "status-page"],
        queryFn: () => api.getStatusOverview(),
        refetchInterval: 30000,
    });

    const isLoading = statusLoading || providersLoading;
    const providers = (providersResponse?.providers ?? []).filter(
        (provider) => provider.authenticated || provider.management.canDisconnect,
    );

    const pathChecks = status
        ? [
            status.paths.config,
            status.paths.database,
            status.paths.download,
            status.paths.library.music,
            status.paths.library.spatial,
            status.paths.library.video,
            status.paths.runtime.tiddl,
            status.tools.ffmpeg,
            status.tools.tiddl,
        ]
        : [];

    return (
        <div className={styles.container}>
            <div className={styles.header}>
                <Title1>System Status</Title1>
                <Text className={styles.mutedText}>
                    Cross-cutting health, download-backend, and provider connectivity diagnostics.
                </Text>
            </div>

            {isLoading ? (
                <div className={styles.loading}>
                    <Spinner label="Loading status…" />
                </div>
            ) : (
                <>
                    <SettingsSection
                        id="health"
                        title="Health"
                        description="Paths, tools, and runtime requirements Discogenius depends on."
                        actions={status ? (
                            <Badge appearance="filled" color={overallBadgeColor(status.status)}>
                                {status.status === "healthy" ? "All checks passed" : status.status}
                            </Badge>
                        ) : undefined}
                    >
                        <div className={styles.card}>
                            {pathChecks.map((check, index) => (
                                <CheckRow
                                    key={check.scope}
                                    check={check}
                                    styles={styles}
                                    last={index === pathChecks.length - 1}
                                />
                            ))}
                        </div>
                    </SettingsSection>

                    <SettingsSection
                        id="download-backend"
                        title="Download Backend"
                        description="tiddl: the TIDAL download/tagging backend Discogenius drives."
                        actions={status ? (
                            <Badge appearance="filled" color={overallBadgeColor(status.backends.tiddl.status)}>
                                {status.backends.tiddl.available ? "Available" : "Unavailable"}
                            </Badge>
                        ) : undefined}
                    >
                        <div className={styles.card}>
                            {status?.backends.tiddl.checks.length ? (
                                status.backends.tiddl.checks.map((check, index) => (
                                    <CheckRow
                                        key={check.scope}
                                        check={check}
                                        styles={styles}
                                        last={index === status.backends.tiddl.checks.length - 1 && status.backends.tiddl.notes.length === 0}
                                    />
                                ))
                            ) : (
                                <div className={styles.emptyState}>
                                    <Caption1 className={styles.mutedText}>No backend checks reported.</Caption1>
                                </div>
                            )}
                            {status?.backends.tiddl.notes.map((note, index) => (
                                <div
                                    key={note}
                                    className={mergeClasses(
                                        styles.row,
                                        index === (status.backends.tiddl.notes.length - 1) ? styles.rowLast : undefined,
                                    )}
                                >
                                    <Caption1 className={styles.mutedText}>{note}</Caption1>
                                </div>
                            ))}
                        </div>
                    </SettingsSection>

                    <SettingsSection
                        id="providers"
                        title="Providers"
                        description="Connectivity and capabilities for each streaming provider."
                    >
                        <div className={styles.card}>
                            {providers.length > 0 ? (
                                providers.map((provider, index) => (
                                    <ProviderRow
                                        key={provider.id}
                                        provider={provider}
                                        styles={styles}
                                        last={index === providers.length - 1 && !overview?.rateLimitMetrics}
                                    />
                                ))
                            ) : (
                                <div className={styles.emptyState}>
                                    <Caption1 className={styles.mutedText}>No provider connected.</Caption1>
                                </div>
                            )}
                            {overview?.rateLimitMetrics ? (
                                <div className={mergeClasses(styles.row, styles.rowLast)}>
                                    <div className={styles.rowContent}>
                                        <Text size={300}>Request pacing</Text>
                                        <Caption1 className={styles.mutedText}>
                                            {`One request every ${Math.round(overview.rateLimitMetrics.currentIntervalMs)} ms`}
                                            {` · recent rate-limit responses: ${overview.rateLimitMetrics.recent429Rate}`}
                                            {overview.rateLimitMetrics.rateLimitUntil
                                                ? ` · throttled until ${new Date(overview.rateLimitMetrics.rateLimitUntil).toLocaleTimeString()}`
                                                : ""}
                                        </Caption1>
                                    </div>
                                </div>
                            ) : null}
                        </div>
                    </SettingsSection>

                    <SettingsSection
                        id="import-unmatched"
                        title="Import"
                        description="Provider artists that could not be matched to a MusicBrainz artist. They were skipped during import and are not monitored — fix the name on the provider or add the artist manually by MusicBrainz search."
                        actions={status && status.imports.unmatchedArtists.length > 0 ? (
                            <Badge appearance="filled" color="warning">
                                {`${status.imports.unmatchedArtists.length} not monitored`}
                            </Badge>
                        ) : undefined}
                    >
                        <div className={styles.card}>
                            {status && status.imports.unmatchedArtists.length > 0 ? (
                                status.imports.unmatchedArtists.map((artist, index) => (
                                    <div
                                        key={`${artist.provider}:${artist.providerId}`}
                                        className={mergeClasses(
                                            styles.row,
                                            index === status.imports.unmatchedArtists.length - 1 ? styles.rowLast : undefined,
                                        )}
                                    >
                                        <div className={styles.rowMain}>
                                            <Warning16Regular className={styles.statusIconWarning} />
                                            <div className={styles.rowContent}>
                                                <Text size={300}>{artist.name}</Text>
                                                <Caption1 className={styles.mutedText}>
                                                    {artist.status === "ambiguous"
                                                        ? "Several MusicBrainz artists match this name"
                                                        : "No MusicBrainz artist found"}
                                                    {` · ${artist.provider}`}
                                                </Caption1>
                                            </div>
                                        </div>
                                    </div>
                                ))
                            ) : (
                                <div className={styles.emptyState}>
                                    <Caption1 className={styles.mutedText}>
                                        Every imported provider artist has a MusicBrainz identity.
                                    </Caption1>
                                </div>
                            )}
                        </div>
                    </SettingsSection>
                </>
            )}
        </div>
    );
};

export default StatusPage;
