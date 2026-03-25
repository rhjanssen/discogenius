import { db } from "../database.js";
import { JobTypes, TaskQueueService } from "./queue.js";
import { Config, getConfigSection } from "./config.js";
import { LibraryFilesService } from "./library-files.js";
import { getQualityRank, type QualityProfile, type LibraryType } from "../repositories/MediaRepository.js";
import { readIntEnv } from "../utils/env.js";

interface Album {
    id: string;
    title: string;
    version?: string;
    type: string;
    quality: string;
    cover?: string | null;
    explicit: number;
    num_tracks: number;
    monitor: number;
    tracks?: Track[];
    tags?: string[]; // Populated from albums.quality column
    monitor_lock?: number;
    redundant?: string;
    module?: string;
    group_type?: string;
    version_group_id?: number; // Groups related album versions together
    mb_primary?: string | null;
    mb_secondary?: string | null;
}

interface Track {
    id: string;
    isrc: string;
    title: string;
}

export class RedundancyService {
    private static readonly REDUNDANCY_YIELD_EVERY = readIntEnv("DISCOGENIUS_REDUNDANCY_YIELD_EVERY", 20, 10);

    private static async yieldToEventLoop(): Promise<void> {
        await new Promise<void>((resolve) => setImmediate(resolve));
    }

    private static async maybeYield(counter: number): Promise<void> {
        if (counter > 0 && counter % this.REDUNDANCY_YIELD_EVERY === 0) {
            await this.yieldToEventLoop();
        }
    }

    static async processRedundancy(artistId: string, libraryType: 'music' | 'atmos' | 'video' = 'music'): Promise<{ newAlbums: number; upgradedAlbums: number }> {
        console.log(`⚖️ [Redundancy] Processing ${libraryType} curation for artist ${artistId}...`);

        try {
            const monitoringConfig = getConfigSection("monitoring");
            const curationConfig = getConfigSection("filtering");
            const qualityConfig = Config.getQualityConfig();

            // 1. Get ALL albums for artist (via album_artists, not albums.artist_id)
            const allArtistAlbums = db.prepare(`
                SELECT a.*, aa.group_type as group_type, aa.module as module, aa.version_group_id as version_group_id
                FROM albums a
                JOIN album_artists aa ON a.id = aa.album_id
                WHERE aa.artist_id = ?
            `).all(artistId) as Album[];

            if (allArtistAlbums.length === 0) {
                console.log(`   No albums found for artist ${artistId} (${libraryType}).`);
                return { newAlbums: 0, upgradedAlbums: 0 };
            }

            // 2. Fetch tracks for ALL albums (quality info is now in albums.quality)
            const albumIds = allArtistAlbums.map(a => a.id);
            const tracks = db.prepare(`
                SELECT id, album_id, isrc, title
                FROM media
                WHERE album_id IN (${albumIds.map(() => '?').join(',')})
                  AND type != 'Music Video'
            `).all(...albumIds) as (Track & { album_id: string })[];

            // Map tracks to albums
            const tracksByAlbum = new Map<string, Track[]>();
            let trackMappingCounter = 0;
            for (const track of tracks) {
                if (!tracksByAlbum.has(track.album_id)) {
                    tracksByAlbum.set(track.album_id, []);
                }
                tracksByAlbum.get(track.album_id)!.push(track);
                trackMappingCounter++;
                await this.maybeYield(trackMappingCounter);
            }

            for (const album of allArtistAlbums) {
                album.tracks = tracksByAlbum.get(album.id) || [];
                // Quality tag (LOSSLESS, HIRES_LOSSLESS, DOLBY_ATMOS) is now in album.quality
                album.tags = album.quality ? [album.quality.toUpperCase()] : [];
            }

            console.log(`   Analyzing ${allArtistAlbums.length} albums with ${tracks.length} tracks...`);

            // 3. Filter by library type (Atmos vs Normal Music)
            let qualifiedAlbums = allArtistAlbums;
            if (libraryType === 'atmos') {
                // Atmos library: Only albums tagged DOLBY_ATMOS
                qualifiedAlbums = allArtistAlbums.filter(a => (a.quality || '').toUpperCase() === 'DOLBY_ATMOS');
                console.log(`   ${qualifiedAlbums.length} albums with DOLBY_ATMOS quality`);
            } else if (libraryType === 'music') {
                // Normal music: Only stereo albums (LOSSLESS or HIRES_LOSSLESS)
                const stereoQualities = ['LOSSLESS', 'HIRES_LOSSLESS'];
                qualifiedAlbums = allArtistAlbums.filter(a => stereoQualities.includes((a.quality || '').toUpperCase()));
                console.log(`   ${qualifiedAlbums.length} albums with stereo quality (LOSSLESS/HIRES_LOSSLESS)`);
            }

            // 3b. Apply category filters BEFORE redundancy selection.
            // This prevents excluded releases (e.g. compilations) from "shadowing" included ones during subset selection.
            const normalizePrimary = (album: Album): 'album' | 'ep' | 'single' => {
                const raw = (album.mb_primary || '').toString().trim().toLowerCase();
                if (raw === 'album' || raw === 'ep' || raw === 'single') return raw;

                const t = (album.type || '').toString().trim().toUpperCase();
                if (t === 'SINGLE') return 'single';
                if (t === 'EP') return 'ep';
                return 'album';
            };

            const isIncludedByCategory = (album: Album): boolean => {
                const mod = (album.module || '').toString().toUpperCase();
                if (mod.includes('APPEARS_ON')) {
                    return curationConfig.include_appears_on === true;
                }

                const secondary = (album.mb_secondary || '').toString().trim().toLowerCase();
                if (secondary) {
                    switch (secondary) {
                        case 'compilation': return curationConfig.include_compilation !== false;
                        case 'soundtrack': return curationConfig.include_soundtrack !== false;
                        case 'live': return curationConfig.include_live !== false;
                        case 'remix': return curationConfig.include_remix !== false;
                        case 'dj-mix': return curationConfig.include_remix !== false;
                        case 'demo': return false;
                        default: return true;
                    }
                }

                const primary = normalizePrimary(album);
                switch (primary) {
                    case 'single': return curationConfig.include_single !== false;
                    case 'ep': return curationConfig.include_ep !== false;
                    case 'album':
                    default: return curationConfig.include_album !== false;
                }
            };

            const includedAlbums = qualifiedAlbums.filter(isIncludedByCategory);
            const includedAlbumIds = new Set(includedAlbums.map(a => a.id));
            console.log(`   After category filters: ${includedAlbums.length} included, ${qualifiedAlbums.length - includedAlbums.length} excluded`);

            const redundancyEnabled = curationConfig?.enable_redundancy_filter !== false;

            // Track redundancy decisions (duplicates/subsets/etc)
            const redundancyMap = new Map<string, string>(); // redundantId -> chosen/supersetId

            let candidatesForDedup: Album[] = includedAlbums;

            // When redundancy is disabled, keep all versions/editions (no version-group curation and no subset removal).
            // We still apply quality + explicit selection for identical track sets (handled below).
            if (redundancyEnabled) {
                // 4. GROUP BY VERSION GROUP (or fallback to title)
                // CRITICAL: Use includedAlbums (not qualifiedAlbums) to prevent excluded categories
                // (e.g. compilations) from "shadowing" included albums during version selection
                const versionGroups = this.groupByVersionGroup(includedAlbums);
                console.log(`   Grouped into ${versionGroups.size} version groups`);

                // 5. RANK WITHIN GROUPS - Select best from each group
                const bestByVersionGroup: Album[] = [];
                let versionSelectionCounter = 0;

                for (const group of versionGroups.values()) {
                    const best = this.selectBestInGroup(group, curationConfig, qualityConfig, libraryType);
                    bestByVersionGroup.push(best);

                    // Mark others in group as redundant
                    for (const album of group) {
                        if (album.id !== best.id) {
                            redundancyMap.set(album.id, best.id);
                        }
                    }

                    versionSelectionCounter++;
                    await this.maybeYield(versionSelectionCounter);
                }

                console.log(`   ${bestByVersionGroup.length} releases after version grouping`);
                candidatesForDedup = bestByVersionGroup;
            } else {
                console.log(`   Redundancy disabled: keeping all versions/editions (no version-group curation)`);
            }

            // Helper: Get ISRC Set
            const getIsrcSet = (album: Album) => {
                return new Set(album.tracks?.map(t => t.isrc).filter(Boolean));
            };

            // Helper: Get Track Name Set (Normalized)
            const getTrackNameSet = (album: Album) => {
                return new Set(album.tracks?.map(t => t.title.toLowerCase().replace(/[^a-z0-9]/g, "")).filter(Boolean));
            };

            // 6. UNIFIED ISRC DEDUPLICATION
            // Group releases by identical ISRC sets, pick best in each group.
            // This must also run for Atmos so explicit-vs-clean variants still resolve
            // to one canonical release and the redundant badge/path stays consistent.
            const resolveEqualTrackSets = async (albums: Album[]): Promise<Album[]> => {
                const uniqueAlbums: Album[] = [];
                const albumsByIsrcSet = new Map<string, Album[]>();
                let isrcGroupingCounter = 0;

                for (const album of albums) {
                    const isrcs = Array.from(getIsrcSet(album)).sort().join('|');
                    if (!isrcs) {
                        // If no tracks/ISRCs, treat as unique
                        uniqueAlbums.push(album);
                        isrcGroupingCounter++;
                        await this.maybeYield(isrcGroupingCounter);
                        continue;
                    }
                    if (!albumsByIsrcSet.has(isrcs)) {
                        albumsByIsrcSet.set(isrcs, []);
                    }
                    albumsByIsrcSet.get(isrcs)!.push(album);
                    isrcGroupingCounter++;
                    await this.maybeYield(isrcGroupingCounter);
                }

                for (const group of albumsByIsrcSet.values()) {
                    // Pick best in group using consistent ranking logic
                    const best = this.selectBestInGroup(group, curationConfig, qualityConfig, libraryType);
                    uniqueAlbums.push(best);

                    // Mark others as redundant
                    for (const album of group) {
                        if (album.id !== best.id) {
                            redundancyMap.set(album.id, best.id);
                        }
                    }

                    isrcGroupingCounter++;
                    await this.maybeYield(isrcGroupingCounter);
                }

                return uniqueAlbums;
            };

            const deduped = await resolveEqualTrackSets(candidatesForDedup);
            console.log(`   After ISRC dedup: ${deduped.length} releases (from ${candidatesForDedup.length}) [quality/explicit dedup applied]`);

            // 7. UNIFIED SUBSET FILTERING
            // Drop any release whose tracks are a subset of another release
            const filterSubsets = async (albums: Album[]): Promise<Album[]> => {
                const result: Album[] = [];
                let subsetFilteringCounter = 0;

                // Sort by track count descending (larger albums first for efficiency)
                const sorted = [...albums].sort((a, b) => (b.num_tracks || 0) - (a.num_tracks || 0));

                for (const cand of sorted) {
                    subsetFilteringCounter++;
                    await this.maybeYield(subsetFilteringCounter);

                    const candIsrcs = getIsrcSet(cand);
                    const candNames = getTrackNameSet(cand);

                    let isSubset = false;
                    // Check against all albums already kept (which are larger or equal)
                    for (const sup of result) {
                        subsetFilteringCounter++;
                        await this.maybeYield(subsetFilteringCounter);

                        if (cand.id === sup.id) continue;

                        const supIsrcs = getIsrcSet(sup);
                        const supNames = getTrackNameSet(sup);

                        // Check ISRC Subset
                        let isIsrcSubset = false;
                        if (candIsrcs.size > 0 && supIsrcs.size > 0) {
                            isIsrcSubset = [...candIsrcs].every(i => supIsrcs.has(i));
                        }

                        // Check Name Subset (fallback if ISRCs missing)
                        let isNameSubset = false;
                        if (candNames.size > 0 && supNames.size > 0) {
                            isNameSubset = [...candNames].every(n => supNames.has(n));
                        }

                        if (isIsrcSubset || isNameSubset) {
                            isSubset = true;
                            // Mark as redundant
                            redundancyMap.set(cand.id, sup.id);
                            break;
                        }
                    }

                    if (!isSubset) {
                        result.push(cand);
                    }
                }
                return result;
            };

            let finalSelection = deduped;
            if (redundancyEnabled) {
                console.log(`   Curating subsets (unified)...`);
                finalSelection = await filterSubsets(deduped);
            } else {
                console.log(`   Redundancy disabled: skipping subset curation`);
            }
            const finalIds = new Set(finalSelection.map(a => a.id));

            // Count by type for logging
            const albumCount = finalSelection.filter(a => (a.type || '').toUpperCase() === 'ALBUM').length;
            const epCount = finalSelection.filter(a => (a.type || '').toUpperCase() === 'EP').length;
            const singleCount = finalSelection.filter(a => (a.type || '').toUpperCase() === 'SINGLE').length;
            const otherCount = finalSelection.length - albumCount - epCount - singleCount;
            console.log(`   Final selection: ${albumCount} albums, ${epCount} EPs, ${singleCount} singles, ${otherCount} other`);

            // --- Apply Updates only to albums that qualify for this library type ---
            const updates: any[] = [];
            let newAlbums = 0;
            const upgradedAlbums = 0;
            let albumUpdatePrepCounter = 0;

            // CRITICAL: Only process albums that qualify for this library type
            // This prevents the atmos pass from overwriting stereo albums (and vice versa)
            for (const album of qualifiedAlbums) {
                albumUpdatePrepCounter++;
                await this.maybeYield(albumUpdatePrepCounter);

                let shouldMonitor = false;
                let redundantOf = null;

                const includedByCategory = includedAlbumIds.has(album.id);

                if (includedByCategory && finalIds.has(album.id)) {
                    shouldMonitor = true;
                } else if (includedByCategory) {
                    shouldMonitor = false;
                    // Included, but filtered out by redundancy/version selection
                    redundantOf = redundancyMap.get(album.id) || null;
                } else {
                    // Excluded by category filter
                    shouldMonitor = false;
                    redundantOf = "filtered";
                }

                // Lock mechanism: Respect manual lock
                if (album.monitor_lock === 1) {
                    // If locked, do not change monitoring status!
                    // Effectively we skip adding it to updates list to preserve current state.
                    // OR we force it to its current monitored state?
                    // Better to skipping update entirely.
                    continue;
                }

                const nextMonitor = shouldMonitor ? 1 : 0;
                const nextRedundant = redundantOf ?? null;
                const currentRedundant = album.redundant ?? null;
                if (Number(album.monitor || 0) === nextMonitor && currentRedundant === nextRedundant) {
                    continue;
                }

                // Prepare update
                updates.push({
                    id: album.id,
                    monitor: nextMonitor,
                    redundant: nextRedundant,
                });

                if (shouldMonitor && !album.monitor) newAlbums++;
            }

            // Batch Update DB
            // Re-check monitor_lock at write time to avoid races with lock toggles while yielded processing is in flight.
            const updateStmt = db.prepare(`
                UPDATE albums SET 
                    monitor = ?, 
                    redundant = ?
                WHERE id = ?
                  AND (monitor_lock = 0 OR monitor_lock IS NULL)
            `);

            if (updates.length > 0) {
                db.transaction(() => {
                    for (const update of updates) {
                        updateStmt.run(
                            update.monitor,
                            update.redundant,
                            update.id
                        );
                    }
                })();
            }

            console.log(`   Updated ${updates.length} albums.`);

            // --- Video Logic ---
            // Videos are controlled by the filtering config's include_videos setting
            const shouldMonitorVideos = curationConfig.include_videos !== false;
            const videos = db.prepare("SELECT * FROM media WHERE artist_id = ? AND type = 'Music Video'").all(artistId) as any[];

            const videoUpdates: any[] = [];
            let videoUpdatePrepCounter = 0;
            for (const video of videos) {
                videoUpdatePrepCounter++;
                await this.maybeYield(videoUpdatePrepCounter);

                // Only update if not locked
                const v: any = video;
                if (v.monitor_lock === 1) continue;
                const nextMonitor = shouldMonitorVideos ? 1 : 0;
                if (Number(v.monitor || 0) === nextMonitor) continue;

                videoUpdates.push({ id: video.id, monitor: nextMonitor });
            }

            // Re-check monitor_lock at write time to avoid races with lock toggles while yielded processing is in flight.
            const vidUpdateStmt = db.prepare("UPDATE media SET monitor = ? WHERE id = ? AND type = 'Music Video' AND (monitor_lock = 0 OR monitor_lock IS NULL)");
            if (videoUpdates.length > 0) {
                db.transaction(() => {
                    for (const update of videoUpdates) {
                        vidUpdateStmt.run(update.monitor, update.id);
                    }
                })();
            }
            console.log(`   Updated ${videoUpdates.length} videos.`);

            console.log(`✅ [Redundancy] Artist ${artistId} filtering complete.`);
            return { newAlbums, upgradedAlbums };
        } finally {
            // Processing complete
        }
    }

    static async queueMonitoredItems(
        artistId?: string
    ): Promise<{ albums: number; tracks: number; videos: number }> {
        console.log(`[Queue] Queueing monitored items${artistId ? ` for artist ${artistId}` : ''}...`);

        const filteringConfig = getConfigSection("filtering");
        const allowVideos = filteringConfig?.include_videos !== false;

        const hasActiveJob = (types: string[], refId: string) => {
            const placeholders = types.map(() => '?').join(', ');
            const existing = db.prepare(`
                SELECT id FROM job_queue
                WHERE type IN (${placeholders}) AND ref_id = ? AND status IN ('pending', 'processing')
            `).get(...types, refId);
            return Boolean(existing);
        };

        const hasActiveAlbumWork = (albumId: string) => {
            if (hasActiveJob([JobTypes.DownloadAlbum, JobTypes.ImportDownload], albumId)) {
                return true;
            }

            const trackWork = db.prepare(`
                SELECT 1
                FROM job_queue jq
                JOIN media m ON m.id = jq.ref_id
                WHERE m.album_id = ?
                  AND jq.type IN ('DownloadTrack', 'ImportDownload')
                  AND jq.status IN ('pending', 'processing')
                LIMIT 1
            `).get(albumId);

            return Boolean(trackWork);
        };

        const hasImportedTrackFile = (mediaIdColumn: string) => `
            EXISTS (
                SELECT 1
                FROM library_files lf
                WHERE lf.media_id = ${mediaIdColumn}
                  AND lf.file_type = 'track'
            )
        `;

        const hasImportedVideoFile = (mediaIdColumn: string) => `
            EXISTS (
                SELECT 1
                FROM library_files lf
                WHERE lf.media_id = ${mediaIdColumn}
                  AND lf.file_type = 'video'
            )
        `;

        const formatAlbumTitle = (title: string, version?: string | null) => {
            const base = title || 'Unknown Album';
            const v = (version || '').trim();
            if (!v) return base;
            if (base.toLowerCase().includes(v.toLowerCase())) return base;
            return `${base} (${v})`;
        };

        const formatTrackTitle = (title: string, version?: string | null) => {
            const base = title || 'Unknown Track';
            const v = (version || '').trim();
            if (!v) return base;
            if (base.toLowerCase().includes(v.toLowerCase())) return base;
            return `${base} (${v})`;
        };

        // 1) Albums monitored at release level
        let albumsQuery = `
            SELECT DISTINCT
                a.id,
                a.title,
                a.version,
                a.cover,
                a.quality,
                a.artist_id,
                ar.name as artist_name
            FROM albums a
            LEFT JOIN artists ar ON ar.id = a.artist_id
        `;
        const albumsWhere: string[] = ["a.monitor = 1"];
        const albumsParams: any[] = [];

        if (artistId) {
            albumsQuery += " JOIN album_artists aa ON a.id = aa.album_id";
            albumsWhere.push("aa.artist_id = ?");
            albumsParams.push(artistId);
        }

        albumsQuery += ` WHERE ${albumsWhere.join(" AND ")}`;

        const albums = db.prepare(albumsQuery).all(...albumsParams) as any[];

        let albumJobs = 0;
        let trackJobs = 0;
        let videoJobs = 0;
        const albumQueuedAsAlbum = new Set<string>();

        for (const album of albums) {
            const albumId = String(album.id);

            const counts = db.prepare(`
                SELECT
                    COUNT(*) as total_tracks,
                    SUM(CASE WHEN m.monitor = 1 THEN 1 ELSE 0 END) as monitored_tracks,
                    SUM(CASE WHEN m.monitor = 1 AND NOT ${hasImportedTrackFile('m.id')} THEN 1 ELSE 0 END) as monitored_missing
                FROM media m
                WHERE album_id = ?
                  AND type != 'Music Video'
            `).get(albumId) as any;

            const totalTracks = Number(counts?.total_tracks || 0);
            const monitoredTracks = Number(counts?.monitored_tracks || 0);
            const monitoredMissing = Number(counts?.monitored_missing || 0);

            const albumTitleFull = formatAlbumTitle(album.title, album.version);

            // Album artist display name (prefer main artist_name; fall back to album_artists list)
            const albumArtists = db.prepare(`
                SELECT a.name
                FROM album_artists aa
                JOIN artists a ON aa.artist_id = a.id
                WHERE aa.album_id = ?
            `).all(albumId) as any[];
            const artistNames = albumArtists.map(a => a.name).filter(Boolean);
            const artistName = album.artist_name || artistNames[0] || 'Unknown';

            // If tracks are missing from DB, fall back to album-level download (unless already fully downloaded)
            if (totalTracks === 0) {
                const hasImportedTracks = db.prepare(`
                    SELECT 1
                    FROM library_files lf
                    WHERE lf.album_id = ?
                      AND lf.file_type = 'track'
                    LIMIT 1
                `).get(albumId);

                if (hasImportedTracks) {
                    continue;
                }
                if (!hasActiveAlbumWork(albumId)) {
                    TaskQueueService.addJob(JobTypes.DownloadAlbum, {
                        url: `https://listen.tidal.com/album/${albumId}`,
                        type: 'album',
                        tidalId: albumId,
                        title: albumTitleFull,
                        artist: artistName,
                        cover: album.cover || null,
                        quality: album.quality,
                        artists: artistNames,
                        description: `${albumTitleFull} by ${artistName}`,
                    }, albumId);
                    albumJobs++;
                }
                albumQueuedAsAlbum.add(albumId);
                continue;
            }

            // Nothing left to download for monitored tracks
            if (monitoredMissing <= 0) {
                continue;
            }

            // If every track is monitored, prefer a single album job
            if (monitoredTracks === totalTracks) {
                if (!hasActiveAlbumWork(albumId)) {
                    TaskQueueService.addJob(JobTypes.DownloadAlbum, {
                        url: `https://listen.tidal.com/album/${albumId}`,
                        type: 'album',
                        tidalId: albumId,
                        title: albumTitleFull,
                        artist: artistName,
                        cover: album.cover || null,
                        quality: album.quality,
                        artists: artistNames,
                        description: `${albumTitleFull} by ${artistName}`,
                    }, albumId);
                    albumJobs++;
                }
                albumQueuedAsAlbum.add(albumId);
                continue;
            }

            // Otherwise, queue only monitored+missing tracks
            const tracks = db.prepare(`
                SELECT
                    m.id as track_id,
                    m.title as track_title,
                    m.version as track_version,
                    m.quality as track_quality
                FROM media m
                WHERE m.album_id = ?
                  AND m.type != 'Music Video'
                  AND m.monitor = 1
                  AND NOT ${hasImportedTrackFile('m.id')}
            `).all(albumId) as any[];

            for (const track of tracks) {
                const trackId = String(track.track_id);
                if (!trackId) continue;
                if (hasActiveJob([JobTypes.DownloadTrack, JobTypes.ImportDownload], trackId)) continue;
                if (hasActiveJob([JobTypes.DownloadAlbum, JobTypes.ImportDownload], albumId)) continue;

                const trackTitle = formatTrackTitle(track.track_title || 'Unknown Track', track.track_version);

                TaskQueueService.addJob(JobTypes.DownloadTrack, {
                    url: `https://listen.tidal.com/track/${trackId}`,
                    type: 'track',
                    tidalId: trackId,
                    title: trackTitle,
                    artist: artistName,
                    cover: album.cover || null,
                    quality: track.track_quality || album.quality || null,
                    artists: [artistName, ...artistNames].filter(Boolean),
                    albumId,
                    albumTitle: albumTitleFull,
                    description: `${trackTitle} on ${albumTitleFull} by ${artistName}`,
                }, trackId);
                trackJobs++;
            }
        }

        // 2) Tracks monitored individually on albums that are not monitored
        let tracksQuery = `
            SELECT
                m.id as track_id,
                m.title as track_title,
                m.version as track_version,
                m.quality as track_quality,
                a.id as album_id,
                a.title as album_title,
                a.version as album_version,
                a.cover as album_cover,
                a.quality as album_quality,
                ar.name as artist_name
            FROM media m
            JOIN albums a ON a.id = m.album_id
            LEFT JOIN artists ar ON ar.id = a.artist_id
            WHERE m.type != 'Music Video'
              AND m.monitor = 1
              AND NOT ${hasImportedTrackFile('m.id')}
              AND COALESCE(a.monitor, 0) = 0
        `;
        const trackParams: any[] = [];
        if (artistId) {
            tracksQuery += `
              AND EXISTS (
                SELECT 1 FROM album_artists aa
                WHERE aa.album_id = a.id AND aa.artist_id = ?
              )
            `;
            trackParams.push(artistId);
        }

        const individuallyMonitoredTracks = db.prepare(tracksQuery).all(...trackParams) as any[];
        for (const row of individuallyMonitoredTracks) {
            const trackId = String(row.track_id);
            if (!trackId) continue;
            if (hasActiveJob([JobTypes.DownloadTrack, JobTypes.ImportDownload], trackId)) continue;

            const albumId = String(row.album_id);
            if (albumQueuedAsAlbum.has(albumId)) continue;
            if (hasActiveJob([JobTypes.DownloadAlbum, JobTypes.ImportDownload], albumId)) continue;

            const albumTitleFull = formatAlbumTitle(row.album_title, row.album_version);
            const artistName = row.artist_name || 'Unknown';
            const trackTitle = formatTrackTitle(row.track_title || 'Unknown Track', row.track_version);

            TaskQueueService.addJob(JobTypes.DownloadTrack, {
                url: `https://listen.tidal.com/track/${trackId}`,
                type: 'track',
                tidalId: trackId,
                title: trackTitle,
                artist: artistName,
                cover: row.album_cover || null,
                quality: row.track_quality || row.album_quality || null,
                artists: [artistName],
                albumId,
                albumTitle: albumTitleFull,
                description: `${trackTitle} on ${albumTitleFull} by ${artistName}`,
            }, trackId);
            trackJobs++;
        }

        // 3) Videos (if enabled)
        if (allowVideos) {
            let videosQuery = `
                SELECT
                    m.id as video_id,
                    m.title as video_title,
                    m.quality as video_quality,
                    m.artist_id as artist_id,
                    ar.name as artist_name,
                    a.cover as album_cover
                FROM media m
                LEFT JOIN artists ar ON ar.id = m.artist_id
                LEFT JOIN albums a ON a.id = m.album_id
                WHERE m.type = 'Music Video'
                  AND m.monitor = 1
                  AND NOT ${hasImportedVideoFile('m.id')}
            `;
            const videoParams: any[] = [];
            if (artistId) {
                videosQuery += " AND m.artist_id = ?";
                videoParams.push(artistId);
            }

            const videos = db.prepare(videosQuery).all(...videoParams) as any[];
            for (const video of videos) {
                const videoId = String(video.video_id);
                if (!videoId) continue;
                if (hasActiveJob([JobTypes.DownloadVideo, JobTypes.ImportDownload], videoId)) continue;

                const artistName = video.artist_name || 'Unknown';
                const title = video.video_title || 'Unknown Video';

                TaskQueueService.addJob(JobTypes.DownloadVideo, {
                    url: `https://listen.tidal.com/video/${videoId}`,
                    type: 'video',
                    tidalId: videoId,
                    title,
                    artist: artistName,
                    cover: video.album_cover || null,
                    quality: video.video_quality || null,
                    artists: [artistName],
                    description: `${title} by ${artistName}`,
                }, videoId);
                videoJobs++;
            }
        }

        console.log(`[Queue] Ensured queue has ${albumJobs} albums, ${trackJobs} tracks, ${videoJobs} videos.`);
        return { albums: albumJobs, tracks: trackJobs, videos: videoJobs };
    }

    /**
     * Group albums by version_group_id (pre-computed from Other Versions API)
     * Falls back to title-based grouping for albums without version_group_id
     * 
     * Note: Explicit/clean versions have identical titles - they are differentiated
     * by the explicit column in the database, not by title variations.
     */
    private static groupByVersionGroup(albums: Album[]): Map<string, Album[]> {
        const groups = new Map<string, Album[]>();

        for (const album of albums) {
            // Use version_group_id if available, otherwise fall back to title-based key
            let groupKey: string;
            if (album.version_group_id) {
                groupKey = `vg:${album.version_group_id}`;
            } else {
                // Fallback to title-based grouping
                // Explicit/clean have the same title - differentiated by explicit column
                const name = album.title || '';
                const version = album.version || '';
                groupKey = `title:${(name + (version ? ` ${version}` : '')).toLowerCase().replace(/[^a-z0-9]/g, '')}`;
            }

            if (!groups.has(groupKey)) {
                groups.set(groupKey, []);
            }
            groups.get(groupKey)!.push(album);
        }

        return groups;
    }

    /**
     * Select best album from a group based on ranking
     * Ranks by: quality > explicit preference > highest ID (newest version)
     */
    private static selectBestInGroup(group: Album[], curationConfig: any, qualityConfig: any, libraryType: 'music' | 'atmos' | 'video' = 'music'): Album {
        if (group.length === 0) {
            throw new Error('Cannot select best from empty group');
        }

        if (group.length === 1) {
            return group[0];
        }

        return group.reduce((best, current) => {
            const bestRank = this.rankAlbumForComparison(best, curationConfig, qualityConfig, libraryType);
            const currentRank = this.rankAlbumForComparison(current, curationConfig, qualityConfig, libraryType);

            // 1. Quality first (HIRES_LOSSLESS vs LOSSLESS based on config)
            if (currentRank.quality !== bestRank.quality) {
                return currentRank.quality > bestRank.quality ? current : best;
            }

            // 2. Explicit preference (based on config)
            if (currentRank.explicit !== bestRank.explicit) {
                return currentRank.explicit > bestRank.explicit ? current : best;
            }

            // 3. Final tie-breaker: higher ID (newer version)
            return Number(current.id) > Number(best.id) ? current : best;
        });
    }

    /**
     * Rank album for comparison
     * Returns quality and explicit ranking for multi-criteria sorting
     */
    private static rankAlbumForComparison(album: Album, curationConfig: any, qualityConfig: any, libraryType: 'music' | 'atmos' | 'video' = 'music'): {
        quality: number;
        explicit: number;
    } {
        // Explicit preference from curation config
        const preferExplicit = curationConfig?.prefer_explicit !== undefined ? curationConfig.prefer_explicit : true;
        let explicit = 0;
        if (preferExplicit) {
            // Prefer explicit: explicit=1, clean=0
            explicit = album.explicit ? 1 : 0;
        } else {
            // Prefer clean: clean=1, explicit=0
            explicit = album.explicit ? 0 : 1;
        }

        // Quality ranking using getQualityRank from MediaRepository
        const qualityTier = (qualityConfig?.audio_quality || 'max') as QualityProfile;

        // Determine library type for quality ranking - use the passed libraryType
        // This ensures Atmos albums get rank -1 when processing the music library
        const effectiveLibraryType: LibraryType = libraryType === 'atmos' ? 'dolby_atmos' : libraryType === 'video' ? 'music_video' : 'music';

        // Get quality from tags array or album.quality directly
        const qualityTag = album.tags?.[0] || album.quality || 'LOSSLESS';

        // Use the centralized quality ranking function
        // - Max profile: HIRES_LOSSLESS > LOSSLESS, exclude DOLBY_ATMOS
        // - High/Normal/Low: LOSSLESS > HIRES_LOSSLESS, exclude DOLBY_ATMOS
        // - Dolby Atmos library: Only DOLBY_ATMOS included
        const quality = getQualityRank(qualityTag, qualityTier, effectiveLibraryType);

        return { quality, explicit };
    }

    /**
     * Process redundancy for all library types based on config
     * When include_atmos is enabled, also processes Atmos albums as a separate pass
     * 
     * @param artistId - Artist ID to process
     * @param options.skipDownloadQueue - If true, apply curation only and do not queue downloads
     */
    static async processAll(
        artistId: string,
        options: { skipDownloadQueue?: boolean; forceDownloadQueue?: boolean } = {}
    ): Promise<{ newAlbums: number; upgradedAlbums: number }> {
        const curationConfig = getConfigSection("filtering");
        const monitoringConfig = getConfigSection("monitoring");

        // Always process music first
        const musicResult = await this.processRedundancy(artistId, 'music');
        let totalNew = musicResult.newAlbums;
        let totalUpgraded = musicResult.upgradedAlbums;

        // If Atmos is enabled, also process Atmos albums
        if (curationConfig.include_atmos === true) {
            console.log(`🎧 [Redundancy] Also processing Dolby Atmos for artist ${artistId}...`);
            const atmosResult = await this.processRedundancy(artistId, 'atmos');
            totalNew += atmosResult.newAlbums;
            totalUpgraded += atmosResult.upgradedAlbums;
        } else {
            // CRITICAL: If Atmos is disabled, ensure we UNMONITOR any Atmos albums that might have been monitored previously
            // Otherwise, turning off the toggle doesn't stop monitoring existing items.
            // Use album_artists join (not albums.artist_id) to match the same set of albums that curation processes.
            db.prepare(`
                UPDATE albums 
                SET monitor = 0, redundant = 'filtered'
                WHERE id IN (
                    SELECT a.id FROM albums a
                    JOIN album_artists aa ON a.id = aa.album_id
                    WHERE aa.artist_id = ? AND UPPER(a.quality) = 'DOLBY_ATMOS' AND a.monitor = 1 AND a.monitor_lock = 0
                )
            `).run(artistId);

            // Also update tracks on those Atmos albums
            db.prepare(`
                UPDATE media
                SET monitor = 0
                WHERE album_id IN (
                    SELECT a.id FROM albums a
                    JOIN album_artists aa ON a.id = aa.album_id
                    WHERE aa.artist_id = ? AND UPPER(a.quality) = 'DOLBY_ATMOS'
                ) AND type != 'Music Video' AND monitor = 1 AND monitor_lock = 0
            `).run(artistId);
        }

        // Cascade to tracks after all processing
        await this.cascadeToTracks(artistId);

        if (monitoringConfig.remove_unmonitored_files === true) {
            const cleanup = LibraryFilesService.pruneUnmonitoredFiles(artistId);
            if (cleanup.deleted > 0 || cleanup.missing > 0 || cleanup.errors > 0) {
                console.log(`[LibraryFiles] Cleanup for artist ${artistId}: ${cleanup.deleted} deleted, ${cleanup.missing} missing, ${cleanup.errors} errors.`);
            }
        }

        // Always prune metadata files whose type was disabled in config
        // (independent of remove_unmonitored_files — this is about settings, not monitoring)
        const metaCleanup = LibraryFilesService.pruneDisabledMetadataFiles(artistId);
        if (metaCleanup.deleted > 0 || metaCleanup.missing > 0 || metaCleanup.errors > 0) {
            console.log(`[LibraryFiles] Disabled metadata cleanup for artist ${artistId}: ${metaCleanup.deleted} deleted, ${metaCleanup.missing} missing, ${metaCleanup.errors} errors.`);
        }

        // Intentionally avoid a full empty-directory sweep per artist here.
        // Prune methods already perform targeted parent cleanup, and repeated full-tree scans
        // can block API responsiveness when curation backlogs process many artists.

        // Queue downloads based on the triggering flow.
        // Full monitoring passes should queue downloads, while standalone curation actions opt out.
        const shouldQueueDownloads = options.forceDownloadQueue === true || options.skipDownloadQueue !== true;
        if (!shouldQueueDownloads) {
            console.log(
                `[Queue] Skipping auto-download queue for artist ${artistId} ` +
                `(skipDownloadQueue=${options.skipDownloadQueue}, forceDownloadQueue=${options.forceDownloadQueue}).`
            );
        } else {
            const queued = await this.queueMonitoredItems(artistId);
            const total = queued.albums + queued.tracks + queued.videos;
            console.log(`[Queue] Auto-download queued ${total} item(s) for artist ${artistId} (${queued.albums} albums, ${queued.tracks} tracks, ${queued.videos} videos).`);
        }

        return { newAlbums: totalNew, upgradedAlbums: totalUpgraded };
    }

    /**
     * Ensure all tracks inherit monitor status from their parent album
     * This is called after album monitoring is applied to sync tracks
     */
    static async cascadeToTracks(artistId: string): Promise<void> {
        console.log(`[Redundancy] Cascading monitor status to tracks for artist ${artistId}...`);

        const result = db.prepare(`
            UPDATE media
            SET monitor = (
                SELECT a.monitor
                FROM albums a
                WHERE a.id = media.album_id
            )
            WHERE type != 'Music Video'
              AND album_id IN (
                SELECT aa.album_id
                FROM album_artists aa
                WHERE aa.artist_id = ?
              )
              AND (monitor_lock = 0 OR monitor_lock IS NULL)
              AND monitor != (
                SELECT a.monitor
                FROM albums a
                WHERE a.id = media.album_id
              )
        `).run(artistId);

        const updatedTracks = (result as any).changes || 0;

        if (updatedTracks > 0) {
            console.log(`[Redundancy] Updated ${updatedTracks} tracks to match album monitor status`);
        }
    }
}
