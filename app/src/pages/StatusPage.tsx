import { useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
    Badge,
    Button,
    Caption1,
    Spinner,
    Text,
    Title1,
    makeStyles,
    mergeClasses,
    tokens,
} from "@fluentui/react-components";
import {
    UnmatchedArtistMatchDialog,
    type UnmatchedArtistTarget,
} from "@/components/settings/UnmatchedArtistMatchDialog";
import {
  CheckmarkCircle16Regular,
  ErrorCircle16Regular,
  Warning16Regular,
  CheckmarkCircle16Filled,
  ErrorCircle16Filled,
  Warning16Filled,
  bundleIcon
} from "@fluentui/react-icons";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { glassSurfaceStyles } from "@/components/ui/glassSurfaceStyles";
import { ErrorState } from "@/components/ui/ContentState";
import { api } from "@/services/api";
import type {
    HealthCheckResultContract,
    HealthCheckStatusContract,
    HealthOverallStatusContract,
} from "@contracts/system-status";
import type { ProviderDiagnosticResult, ProviderDiagnosticsResponse, StreamingProviderStatus } from "@/services/api";

const CheckmarkCircle16 = bundleIcon(CheckmarkCircle16Filled, CheckmarkCircle16Regular);
const ErrorCircle16 = bundleIcon(ErrorCircle16Filled, ErrorCircle16Regular);
const Warning16 = bundleIcon(Warning16Filled, Warning16Regular);

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
        ...glassSurfaceStyles,
        overflow: "hidden",
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
    diagnosticList: {
        display: "grid",
        gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
        gap: tokens.spacingHorizontalS,
        padding: `0 ${tokens.spacingHorizontalM} ${tokens.spacingVerticalS}`,
        "@media (max-width: 700px)": {
            gridTemplateColumns: "1fr",
        },
    },
    diagnosticItem: {
        display: "flex",
        alignItems: "flex-start",
        gap: tokens.spacingHorizontalXS,
        minWidth: 0,
        padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
        borderRadius: tokens.borderRadiusMedium,
        backgroundColor: `color-mix(in srgb, ${tokens.colorNeutralBackground2} 70%, transparent)`,
    },
    rowActions: {
        display: "flex",
        alignItems: "center",
        gap: tokens.spacingHorizontalXS,
        flexShrink: 0,
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
        return <CheckmarkCircle16 className={styles.statusIconOk} />;
    }
    if (status === "warning") {
        return <Warning16 className={styles.statusIconWarning} />;
    }
    return <ErrorCircle16 className={styles.statusIconError} />;
}

function diagnosticIcon(status: ProviderDiagnosticResult["status"], styles: ReturnType<typeof useStyles>) {
    if (status === "ok") {
        return <CheckmarkCircle16 className={styles.statusIconOk} />;
    }
    if (status === "warning" || status === "disabled" || status === "unknown") {
        return <Warning16 className={styles.statusIconWarning} />;
    }
    return <ErrorCircle16 className={styles.statusIconError} />;
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
    diagnostics,
    diagnosticsLoading,
    diagnosticsError,
    onRetryDiagnostics,
    styles,
    last,
}: {
    provider: StreamingProviderStatus;
    diagnostics?: ProviderDiagnosticsResponse;
    diagnosticsLoading?: boolean;
    diagnosticsError?: Error;
    onRetryDiagnostics?: () => void;
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

    const diagnosticRows = diagnostics?.diagnostics ?? [];
    const hasDiagnosticError = Boolean(diagnosticsError)
        || diagnosticRows.some((diagnostic) => diagnostic.status === "error");
    const hasDiagnosticWarning = diagnosticRows.some((diagnostic) =>
        diagnostic.status === "warning" || diagnostic.status === "disabled" || diagnostic.status === "unknown",
    );

    return (
        <div className={mergeClasses(styles.row, last ? styles.rowLast : undefined)}
            style={{ flexDirection: "column", alignItems: "stretch", gap: tokens.spacingVerticalXS }}
        >
            <div className={styles.rowMain}>
                {hasDiagnosticError
                    ? <ErrorCircle16 className={styles.statusIconError} />
                    : provider.authenticated && !hasDiagnosticWarning
                    ? <CheckmarkCircle16 className={styles.statusIconOk} />
                    : <Warning16 className={styles.statusIconWarning} />}
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
            {diagnosticsLoading ? (
                <div className={styles.capabilityRow}>
                    <Spinner size="tiny" label={`Checking ${provider.name}`} />
                </div>
            ) : diagnosticsError ? (
                <div className={styles.capabilityRow} role="alert">
                    <ErrorCircle16 className={styles.statusIconError} />
                    <Text size={200}>{`Diagnostics unavailable: ${diagnosticsError.message}`}</Text>
                    {onRetryDiagnostics ? (
                        <Button size="small" appearance="secondary" onClick={onRetryDiagnostics}>
                            Retry
                        </Button>
                    ) : null}
                </div>
            ) : diagnosticRows.length > 0 ? (
                <div className={styles.diagnosticList}>
                    {diagnosticRows.map((diagnostic) => (
                        <div key={diagnostic.kind} className={styles.diagnosticItem}>
                            {diagnosticIcon(diagnostic.status, styles)}
                            <div className={styles.rowContent}>
                                <Text size={200}>{diagnostic.message}</Text>
                                <Caption1 className={styles.mutedText}>{diagnostic.kind}</Caption1>
                            </div>
                        </div>
                    ))}
                </div>
            ) : null}
        </div>
    );
}

const StatusPage = () => {
    const styles = useStyles();
    const queryClient = useQueryClient();
    const [matchTarget, setMatchTarget] = useState<UnmatchedArtistTarget | null>(null);

    const ignoreMutation = useMutation({
        mutationFn: ({ provider, providerId }: { provider: string; providerId: string }) =>
            api.ignoreUnmatchedArtist(provider, providerId),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: ["system-status"] });
        },
    });

    const {
        data: status,
        isLoading: statusLoading,
        error: statusError,
        refetch: refetchStatus,
    } = useQuery({
        queryKey: ["system-status"],
        queryFn: () => api.getSystemStatus(),
        refetchInterval: 30000,
    });

    const {
        data: providersResponse,
        isLoading: providersLoading,
        error: providersError,
        refetch: refetchProviders,
    } = useQuery({
        queryKey: ["streaming-providers", "status-page"],
        queryFn: () => api.getStreamingProviders(),
        refetchInterval: 30000,
    });
    const providerDiagnosticsQueries = useQueries({
        queries: (providersResponse?.providers ?? []).map((provider) => ({
            queryKey: ["provider-diagnostics", provider.id],
            queryFn: () => api.getProviderDiagnostics(provider.id),
            refetchInterval: 30000,
            staleTime: 30000,
        })),
    });

    const {
        data: overview,
        isLoading: overviewLoading,
        error: overviewError,
        refetch: refetchOverview,
    } = useQuery({
        queryKey: ["status-overview", "status-page"],
        queryFn: () => api.getStatusOverview(),
        refetchInterval: 30000,
    });

    const isLoading = statusLoading || providersLoading || overviewLoading;
    const pageError = [statusError, providersError, overviewError]
        .find((queryError): queryError is Error => queryError instanceof Error)
        ?? ([statusError, providersError, overviewError].some(Boolean)
            ? new Error("One or more status requests failed.")
            : null);
    const providers = providersResponse?.providers ?? [];
    const diagnosticsByProvider = new Map<string, {
        data?: ProviderDiagnosticsResponse;
        isLoading: boolean;
        error?: Error;
        retry?: () => void;
    }>();
    providers.forEach((provider, index) => {
        const query = providerDiagnosticsQueries[index];
        diagnosticsByProvider.set(provider.id, {
            data: query?.data,
            isLoading: Boolean(query?.isLoading),
            error: query?.error instanceof Error
                ? query.error
                : query?.error
                    ? new Error("Provider diagnostics request failed.")
                    : undefined,
            retry: query ? () => void query.refetch() : undefined,
        });
    });

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
    const runtimeChecks = status
        ? [
            status.subsystems.database.schema,
            status.subsystems.database.wal,
            status.subsystems.database.storage,
            status.subsystems.database.deep,
            status.subsystems.commandQueue,
            status.subsystems.scheduledTasks,
            status.subsystems.imports,
            status.subsystems.statistics,
            status.subsystems.catalog,
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
            ) : pageError ? (
                <ErrorState
                    title="Couldn’t load system status"
                    error={pageError}
                    minHeight="320px"
                    actions={(
                        <Button
                            appearance="primary"
                            onClick={() => {
                                void Promise.all([
                                    refetchStatus(),
                                    refetchProviders(),
                                    refetchOverview(),
                                ]);
                            }}
                        >
                            Try again
                        </Button>
                    )}
                />
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
                        id="runtime"
                        title="Runtime & Recovery"
                        description="Database integrity, queue liveness, scheduled work, imports, statistics, and catalog readiness."
                        actions={status ? (
                            <Badge
                                appearance="filled"
                                color={status.controls.downloadQueue.isPaused ? "warning" : "success"}
                            >
                                {status.controls.downloadQueue.isPaused
                                    ? "Downloads paused (saved)"
                                    : "Downloads running"}
                            </Badge>
                        ) : undefined}
                    >
                        <div className={styles.card}>
                            {runtimeChecks.map((check, index) => (
                                <CheckRow
                                    key={check.scope}
                                    check={check}
                                    styles={styles}
                                    last={index === runtimeChecks.length - 1}
                                />
                            ))}
                        </div>
                    </SettingsSection>

                    <SettingsSection
                        id="download-backend"
                        title="Download Backend"
                        description="tiddl: the TIDAL download and tagging backend."
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
                                        diagnostics={diagnosticsByProvider.get(provider.id)?.data}
                                        diagnosticsLoading={diagnosticsByProvider.get(provider.id)?.isLoading}
                                        diagnosticsError={diagnosticsByProvider.get(provider.id)?.error}
                                        onRetryDiagnostics={diagnosticsByProvider.get(provider.id)?.retry}
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
                        description="Provider artists that were not linked automatically. Pick the right MusicBrainz artist with Find match, or use Ignore for entries that have nothing to match (karaoke channels, misspelled duplicates)."
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
                                            <Warning16 className={styles.statusIconWarning} />
                                            <div className={styles.rowContent}>
                                                <Text size={300}>{artist.name}</Text>
                                                <Caption1 className={styles.mutedText}>
                                                    {artist.status === "ambiguous"
                                                        ? "Several MusicBrainz artists match this name"
                                                        : "No safe automatic match"}
                                                    {` · ${artist.provider}`}
                                                </Caption1>
                                            </div>
                                        </div>
                                        <div className={styles.rowActions}>
                                            <Button
                                                size="small"
                                                appearance="secondary"
                                                onClick={() => setMatchTarget({
                                                    provider: artist.provider,
                                                    providerId: artist.providerId,
                                                    name: artist.name,
                                                })}
                                            >
                                                Find match
                                            </Button>
                                            <Button
                                                size="small"
                                                appearance="subtle"
                                                disabled={ignoreMutation.isPending}
                                                onClick={() => ignoreMutation.mutate({ provider: artist.provider, providerId: artist.providerId })}
                                            >
                                                Ignore
                                            </Button>
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

                    <UnmatchedArtistMatchDialog
                        target={matchTarget}
                        onClose={() => setMatchTarget(null)}
                    />
                </>
            )}
        </div>
    );
};

export default StatusPage;
