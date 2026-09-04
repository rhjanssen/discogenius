import { db } from "../../database.js";
import { RefreshArtistService } from "./refresh-artist-service.js";
import { DiskScanService, type ScanResult } from "../mediafiles/library-scan.js";
import { parseScanFileFilter } from "../mediafiles/scan-file-filter.js";
import { CurationService } from "./curation-service.js";
import { DownloadMissingService, type DownloadMissingResult } from "./download-missing-service.js";
import { ArtistStatisticsService } from "./artist-statistics-service.js";
import { isArtistLibraryMonitored } from "./managed-artists.js";
import { getArtistWorkflowPhases, type ArtistWorkflow } from "./artist-workflow.js";
import { appEvents, AppEvent } from "../commands/app-events.js";
import { CommandTrigger } from "../commands/command-trigger.js";
import type { RescanFoldersCommand } from "../commands/command-bodies.js";
import { yieldToEventLoop } from "../../utils/concurrent.js";

export interface ExecuteArtistPipelineOptions {
    artistId: string;
    artistName?: string;
    workflow: ArtistWorkflow;
    monitorArtist?: boolean;
    monitorAlbums?: boolean;
    hydrateCatalog?: boolean;
    hydrateAlbumTracks?: boolean;
    forceUpdate?: boolean;
    skipMetadataBackfill?: boolean;
    monitoringCycle?: RescanFoldersCommand["monitoringCycle"];
    commandId?: number;
    workerId?: string;
    trigger?: number;
    priority?: number;
    onProgress?: (progress: number, phaseDescription: string) => void;
    yieldToEventLoop?: () => Promise<void>;
    isCancelled?: () => boolean;
}

export interface ArtistPipelineResult {
    artistId: string;
    artistMbid: string | null;
    metadataChanged: boolean;
    isNewArtist: boolean;
    scanResult?: ScanResult;
    downloadsQueued?: DownloadMissingResult;
}

export class ArtistPipelineService {
    static async executeArtistIntake(
        artistId: string,
        options: Partial<ExecuteArtistPipelineOptions> = {},
    ): Promise<ArtistPipelineResult> {
        return this.executePipeline({
            artistId,
            workflow: "monitoring-intake",
            ...options,
        });
    }

    static async executePipeline(options: ExecuteArtistPipelineOptions): Promise<ArtistPipelineResult> {
        const { artistId, workflow } = options;
        const artistName = options.artistName || artistId;
        const phases = getArtistWorkflowPhases(workflow);
        const cooperativeYield = options.yieldToEventLoop ?? yieldToEventLoop;
        const isCancelled = options.isCancelled ?? (() => false);

        options.onProgress?.(5, "preparing artist refresh");

        // ---------------------------------------------------------------------
        // Phase 1: Metadata Refresh
        // ---------------------------------------------------------------------
        const refreshResult = await RefreshArtistService.refreshArtist(artistId, {
            monitorArtist: options.monitorArtist ?? phases.monitorArtist,
            monitorAlbums: options.monitorAlbums ?? (phases.curate || phases.backfillMetadata || phases.queueDownloads),
            hydrateCatalog: options.hydrateCatalog ?? phases.refreshMetadata,
            hydrateAlbumTracks: options.hydrateAlbumTracks ?? (phases.curate || phases.backfillMetadata || phases.queueDownloads),
            forceUpdate: options.forceUpdate ?? false,
            deferProviderMatching: true,
            progress: (event) => {
                if (event.kind === "status") {
                    options.onProgress?.(10, "refreshing metadata");
                }
            },
        });

        ArtistStatisticsService.refresh([artistId]);

        if (isCancelled()) {
            return {
                artistId,
                artistMbid: refreshResult.artistMbid,
                metadataChanged: refreshResult.metadataChanged,
                isNewArtist: refreshResult.isNewArtist,
            };
        }

        // Collaborator cataloguing loop
        if (
            isArtistLibraryMonitored(artistId)
            && refreshResult.creditedArtistMbids.length > 0
        ) {
            const uniqueMbids = Array.from(new Set(refreshResult.creditedArtistMbids));
            const marks = uniqueMbids.map(() => "?").join(", ");
            const untouched = db.prepare(`
                SELECT mbid, name
                FROM ArtistMetadata
                WHERE mbid IN (${marks})
                  AND content_hash IS NULL
                ORDER BY name COLLATE NOCASE, mbid
            `).all(...uniqueMbids) as Array<{ mbid: string; name: string }>;

            for (let index = 0; index < untouched.length; index += 1) {
                if (isCancelled()) break;
                const credited = untouched[index];
                options.onProgress?.(
                    20 + Math.floor(((index + 1) / Math.max(untouched.length, 1)) * 5),
                    `cataloguing collaborator ${index + 1}/${untouched.length}: ${credited.name}`,
                );
                await RefreshArtistService.refreshArtist(credited.mbid, {
                    monitorArtist: false,
                    hydrateCatalog: true,
                    hydrateAlbumTracks: true,
                    deferProviderMatching: true,
                    forceUpdate: false,
                });
                await cooperativeYield();
            }
        }

        const isMonitored = isArtistLibraryMonitored(artistId);
        if (!isMonitored) {
            RefreshArtistService.markArtistRefreshComplete(artistId);
            options.onProgress?.(100, "metadata refresh complete (unmonitored)");
            return {
                artistId,
                artistMbid: refreshResult.artistMbid,
                metadataChanged: refreshResult.metadataChanged,
                isNewArtist: refreshResult.isNewArtist,
            };
        }

        // ---------------------------------------------------------------------
        // Phase 2: Provider Matching
        // ---------------------------------------------------------------------
        options.onProgress?.(25, "matching provider availability");

        await RefreshArtistService.matchArtistProviders(
            artistId,
            refreshResult.artistMbid ?? null,
            {
                forceUpdate: options.forceUpdate ?? false,
                progress: (event) => {
                    if (event.kind === "albums_total") {
                        options.onProgress?.(
                            event.total > 0 ? 30 : 45,
                            event.total > 0
                                ? `found ${event.total} provider releases`
                                : "no provider releases found",
                        );
                        return;
                    }
                    if (event.kind === "album") {
                        const total = Math.max(event.total, 1);
                        const progress = Math.min(48, 30 + Math.round((event.index / total) * 18));
                        options.onProgress?.(
                            progress,
                            `fetching tracklists (${event.index}/${event.total})`,
                        );
                        return;
                    }
                    if (event.kind === "album_tracks") {
                        const total = Math.max(event.total, 1);
                        const progress = Math.min(52, 48 + Math.round((event.index / total) * 4));
                        options.onProgress?.(
                            progress,
                            `scanning tracks (${event.index}/${event.total}: ${event.title})`,
                        );
                        return;
                    }
                    if (event.kind === "status") {
                        options.onProgress?.(52, event.message);
                    }
                },
            },
            refreshResult.shouldHydrateCatalog,
        );

        if (refreshResult.shouldHydrateCatalog) {
            RefreshArtistService.markArtistRefreshComplete(artistId);
        }

        ArtistStatisticsService.refresh([artistId]);

        if (isCancelled()) {
            return {
                artistId,
                artistMbid: refreshResult.artistMbid,
                metadataChanged: refreshResult.metadataChanged,
                isNewArtist: refreshResult.isNewArtist,
            };
        }

        appEvents.emit(AppEvent.ARTIST_REFRESH_COMPLETE, {
            commandId: options.commandId,
            workerId: options.workerId,
            artistId,
            artistName,
            workflow,
            scanLibrary: phases.scanLibrary,
            metadataChanged: refreshResult.metadataChanged,
            isNewArtist: refreshResult.isNewArtist,
            monitoringCycle: options.monitoringCycle,
            trigger: options.trigger ?? CommandTrigger.Unspecified,
            priority: options.priority ?? 0,
            handledInline: true,
        });

        // ---------------------------------------------------------------------
        // Phase 3: Folder Scan (if scanLibrary phase is true)
        // ---------------------------------------------------------------------
        let scanResult: ScanResult | undefined;
        if (phases.scanLibrary) {
            options.onProgress?.(55, "scanning artist folder");

            const filter = parseScanFileFilter(
                refreshResult.metadataChanged || refreshResult.isNewArtist ? "matched" : "known",
                "matched",
            );

            scanResult = await DiskScanService.scan({
                artistIds: [artistId],
                filter,
                trackUnmappedFiles: true,
                onProgress: (event) => {
                    const p = Math.min(72, 55 + Math.round((event.progress / 100) * 17));
                    options.onProgress?.(p, `scanning files - ${event.message}`);
                },
            });

            if (!options.skipMetadataBackfill) {
                options.onProgress?.(72, "backfilling metadata files");
                try {
                    await DiskScanService.fillMissingMetadataFiles(artistId);
                } catch (error) {
                    console.warn(`[ArtistPipelineService] Failed to backfill metadata files for artist ${artistId}:`, error);
                }
            }

            ArtistStatisticsService.refresh([artistId]);

            if (isCancelled()) {
                return {
                    artistId,
                    artistMbid: refreshResult.artistMbid,
                    metadataChanged: refreshResult.metadataChanged,
                    isNewArtist: refreshResult.isNewArtist,
                    scanResult,
                };
            }

            appEvents.emit(AppEvent.ARTIST_SCANNED, {
                commandId: options.commandId,
                workerId: options.workerId,
                artistId,
                artistName,
                workflow,
                monitoringCycle: options.monitoringCycle,
                skipCuration: !phases.curate,
                skipMetadataBackfill: options.skipMetadataBackfill ?? false,
                trigger: options.trigger ?? CommandTrigger.Unspecified,
                priority: options.priority ?? 0,
                handledInline: true,
            });
        }

        // ---------------------------------------------------------------------
        // Phase 4: Curation (if curate phase is true)
        // ---------------------------------------------------------------------
        if (phases.curate) {
            options.onProgress?.(75, "applying release monitoring rules");

            await CurationService.processAll(artistId);
            ArtistStatisticsService.refresh([artistId]);

            if (isCancelled()) {
                return {
                    artistId,
                    artistMbid: refreshResult.artistMbid,
                    metadataChanged: refreshResult.metadataChanged,
                    isNewArtist: refreshResult.isNewArtist,
                    scanResult,
                };
            }

            appEvents.emit(AppEvent.ARTIST_CURATED, {
                commandId: options.commandId,
                workerId: options.workerId,
                artistId,
                artistName,
                workflow,
                monitoringCycle: options.monitoringCycle,
                trigger: options.trigger ?? CommandTrigger.Unspecified,
                priority: options.priority ?? 0,
                handledInline: true,
            });
        }

        // ---------------------------------------------------------------------
        // Phase 5: Queue Missing Downloads (if queueDownloads && monitoring-intake)
        // ---------------------------------------------------------------------
        let downloadsQueued: DownloadMissingResult | undefined;
        if (phases.queueDownloads && workflow === "monitoring-intake") {
            options.onProgress?.(90, "checking and queueing missing downloads");
            try {
                downloadsQueued = await DownloadMissingService.queueMonitoredItems(artistId);
                ArtistStatisticsService.refresh([artistId]);
                const total = (downloadsQueued?.albums ?? 0) + (downloadsQueued?.tracks ?? 0) + (downloadsQueued?.videos ?? 0);
                options.onProgress?.(
                    100,
                    total > 0
                        ? `intake complete - queued ${total} missing download(s)`
                        : (downloadsQueued?.alreadyQueued ?? 0) > 0
                            ? `intake complete - ${downloadsQueued?.alreadyQueued} download(s) already queued`
                            : "intake complete - library up to date",
                );
            } catch (error) {
                console.warn(`[ArtistPipelineService] Failed to queue missing downloads for artist ${artistId}:`, error);
            }
        } else {
            options.onProgress?.(100, "artist processing complete");
        }

        return {
            artistId,
            artistMbid: refreshResult.artistMbid,
            metadataChanged: refreshResult.metadataChanged,
            isNewArtist: refreshResult.isNewArtist,
            scanResult,
            downloadsQueued,
        };
    }
}
