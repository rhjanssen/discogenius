import { db, withDbWrite } from "../../database.js";
import { emitLibraryUpdated } from "../commands/app-events.js";
import { invalidateReleaseGroupDownloadStatus } from "../download/download-state.js";
import { queueAcquisitionPlan } from "./acquisition-plan-executor.js";
import { LibraryFilesService } from "../mediafiles/library-files.js";
import {
    monitorAlbumInLibraries,
    resolveScopedLibraryIds,
    unmonitorAlbumInLibraries,
    type AlbumLibraryScope,
} from "./library-album-monitoring.js";
import { ArtistStatisticsService } from "./artist-statistics-service.js";
import { clearUserExclusions } from "./library-user-decisions.js";
import { LibraryCurationService } from "./library-curation-service.js";
import { ACQUISITION_PLANNER_VERSION, getAcquisitionProviderPriority } from "./acquisition-planning-service.js";

export class AlbumCommandService {
    private static releaseGroupExists(releaseGroupMbid: string): { id: number; mbid: string } | null {
        return db.prepare("SELECT id, mbid FROM Albums WHERE mbid = ?")
            .get(releaseGroupMbid) as { id: number; mbid: string } | null;
    }

    private static setReleaseGroupMonitored(
        releaseGroupMbid: string,
        monitored: boolean,
        scope: AlbumLibraryScope,
    ): boolean {
        const releaseGroup = this.releaseGroupExists(releaseGroupMbid);
        if (!releaseGroup) {
            return false;
        }

        const libraryIds = resolveScopedLibraryIds(db, scope);
        db.transaction(() => {
            if (monitored) {
                monitorAlbumInLibraries(db, releaseGroup.id, libraryIds, {
                    reason: "user",
                    actor: "user",
                });
            } else {
                unmonitorAlbumInLibraries(db, releaseGroup.id, libraryIds, { actor: "user" });
            }
        })();

        if (!monitored) {
            LibraryFilesService.pruneUnmonitoredForReleaseGroup(releaseGroupMbid, { immediate: true });
        }

        ArtistStatisticsService.refreshForReleaseGroupMbids([releaseGroupMbid]);
        emitLibraryUpdated({
            reason: monitored ? "album-monitored" : "album-unmonitored",
            releaseGroupMbids: [releaseGroupMbid],
            libraryIds,
        });
        return true;
    }

    /**
     * Lock or unlock an Album in the named Libraries.
     *
     * A lock protects an Album that is monitored; it is not a way to record an
     * opinion about one that is not. Locking therefore never creates a
     * `LibraryAlbums` row — an unmonitored Album has nothing to protect, and a
     * row created to hold a lock would claim the Album is monitored.
     */
    private static setReleaseGroupMonitoredLock(
        releaseGroupMbid: string,
        locked: boolean,
        scope: AlbumLibraryScope,
    ): { success: boolean; status?: number; message?: string } {
        const releaseGroup = this.releaseGroupExists(releaseGroupMbid);
        if (!releaseGroup) {
            return { success: false, status: 404, message: "Release group not found" };
        }

        const libraryIds = resolveScopedLibraryIds(db, scope);
        let changes = 0;
        if (libraryIds.length > 0) {
            const update = db.prepare(`
                UPDATE LibraryAlbums
                SET locked = ?, selection_mode = 'manual', reason = 'user',
                    updated_at = CURRENT_TIMESTAMP
                WHERE library_id = ? AND release_group_id = ?
            `);
            db.transaction(() => {
                for (const libraryId of libraryIds) {
                    changes += update.run(Number(locked), libraryId, releaseGroup.id).changes;
                }
            })();
        }

        if (changes === 0) {
            return {
                success: false,
                status: 409,
                message: "Cannot change lock on an unmonitored album",
            };
        }

        // One Album-level lock, one meaning, one row. Curation, acquisition
        // planning and the edition-selection UX all read LibraryAlbums.locked;
        // there is no second per-edition lock to propagate to and therefore
        // none to drift out of step with this one. The lock covers the
        // monitored state, the curated edition set, the representative edition
        // and the selected acquisition plan alike.
        invalidateReleaseGroupDownloadStatus(releaseGroupMbid);
        return { success: true };
    }

    /** Set release-group wanted state in the Libraries the caller named. */
    static setAlbumMonitored(
        albumId: string,
        monitored: boolean,
        scope: AlbumLibraryScope,
    ): { success: boolean; albumId: string; monitored: boolean; message?: string; status?: number } {
        if (this.setReleaseGroupMonitored(albumId, monitored, scope)) {
            invalidateReleaseGroupDownloadStatus(albumId);
            return { success: true, albumId, monitored };
        }

        return { success: false, albumId, monitored, message: 'Release group not found', status: 404 };
    }

    /** Mark a release group wanted and queue its selected provider offer. */
    static async addAlbum(albumId: string, shouldDownload: boolean, requestedSlot?: string | null): Promise<{ success: boolean; albumId?: string; commandId?: number | null; commandIds?: number[]; status?: number; message?: string }> {
        return withDbWrite(() => db.transaction(() => this.addAlbumWithinTransaction(albumId, shouldDownload, requestedSlot))());
    }

    private static addAlbumWithinTransaction(albumId: string, shouldDownload: boolean, requestedSlot?: string | null): { success: boolean; albumId?: string; commandId?: number | null; commandIds?: number[]; status?: number; message?: string } {
        if (!this.releaseGroupExists(albumId)) {
            return { success: false, status: 404, message: 'Release group not found' };
        }

        this.setReleaseGroupMonitored(albumId, true, { kind: "all-audio-libraries" });
        const normalizedPlanIds = (db.prepare(`
            SELECT plan.id
            FROM SelectedAcquisitionPlans plan
            JOIN LibraryEditions library_release
              ON library_release.id = plan.library_edition_id
            JOIN Libraries library ON library.id = library_release.library_id
            JOIN AlbumEditions release ON release.id = library_release.edition_id
            JOIN Albums release_group ON release_group.id = release.release_group_id
            WHERE release_group.mbid = ?
              AND plan.state = 'current'
              AND library.enabled = 1
              AND (
                ? IS NULL
                OR LOWER(library.name) = LOWER(?)
                OR (? = 'stereo' AND LOWER(library.name) NOT LIKE '%spatial%')
              )
            ORDER BY library.id, plan.id
        `).all(
            albumId,
            requestedSlot ?? null,
            requestedSlot ?? null,
            requestedSlot ?? null,
        ) as Array<{ id: number }>).map(({ id }) => id);
        if (shouldDownload && normalizedPlanIds.length === 0) {
            return {
                success: false,
                status: 409,
                message: requestedSlot
                    ? `No current acquisition plan exists for the ${requestedSlot} library.`
                    : "No current acquisition plan exists for this release group. Connect a provider and refresh the artist before downloading.",
            };
        }
        const commandIds: number[] = [];
        if (shouldDownload) {
            for (const planId of normalizedPlanIds) {
                const queued = queueAcquisitionPlan(db, planId);
                if (queued.commandId != null) commandIds.push(queued.commandId);
            }
            return { success: true, albumId, commandId: commandIds[0] ?? null, commandIds };
        }

        return { success: true, albumId, commandId: commandIds[0] ?? null, commandIds };
    }

    /** Update album monitored and/or monitor_lock state in the named Libraries. */
    static updateAlbum(
        albumId: string,
        monitored: boolean | undefined,
        monitoredLock: boolean | undefined,
        scope: AlbumLibraryScope,
    ): { success: boolean; albumId?: string; monitored?: boolean; status?: number; message?: string } {
        if (monitored === undefined && monitoredLock === undefined) {
            return { success: true };
        }

        if (this.releaseGroupExists(albumId)) {
            if (monitored !== undefined) {
                this.setReleaseGroupMonitored(albumId, monitored, scope);
            }
            if (monitoredLock !== undefined) {
                const lockResult = this.setReleaseGroupMonitoredLock(albumId, monitoredLock, scope);
                if (!lockResult.success) {
                    return {
                        success: false,
                        albumId,
                        monitored,
                        status: lockResult.status,
                        message: lockResult.message,
                    };
                }
            }
            return { success: true, albumId, monitored };
        }
        return { success: false, status: 404, message: 'Release group not found' };
    }

    /**
     * Unlock curation for every album in every library. Monitored editions and
     * user exclusions stay as they are; only the lock and the manual selection
     * mode go, so the next curation pass may choose again. Touches no files.
     */
    static unlockAllAlbums(): { before: number; after: number; unlocked: number } {
        const count = () => (db.prepare("SELECT COUNT(*) AS n FROM LibraryAlbums WHERE locked = 1").get() as { n: number }).n;
        const before = count();
        const unlocked = db.transaction(() => {
            db.prepare(`
                UPDATE LibraryEditions
                SET selection_mode = 'auto', decision = 'curation', updated_at = CURRENT_TIMESTAMP
                WHERE selection_mode = 'manual' OR decision = 'user'
            `).run();
            return db.prepare(`
                UPDATE LibraryAlbums
                SET locked = 0, selection_mode = 'auto', decision = 'curation', updated_at = CURRENT_TIMESTAMP
                WHERE locked = 1 OR selection_mode = 'manual' OR decision = 'user'
            `).run().changes;
        })();
        return { before, after: count(), unlocked };
    }

    /**
     * Clear a user decision and let the active monitoring mode choose again.
     * Exclusions, the album lock, and manual edition choices all go.
     */
    static revertAlbumToAutomatic(albumId: string): { success: boolean; status?: number; message?: string } {
        const releaseGroup = this.releaseGroupExists(albumId);
        if (!releaseGroup) return { success: false, status: 404, message: "Release group not found" };

        const libraryIds = resolveScopedLibraryIds(db, { kind: "all-audio-libraries" });
        db.transaction(() => {
            const clearEdition = db.prepare(`
                UPDATE LibraryEditions
                SET selection_mode = 'auto',
                    decision = 'curation',
                    plan_selection_mode = 'auto',
                    preferred_plan_key = NULL,
                    reason = 'curation',
                    updated_at = CURRENT_TIMESTAMP
                WHERE library_id = ?
                  AND edition_id IN (SELECT id FROM AlbumEditions WHERE release_group_id = ?)
            `);
            const clearAlbum = db.prepare(`
                UPDATE LibraryAlbums
                SET locked = 0,
                    selection_mode = 'auto',
                    decision = 'curation',
                    reason = 'curation',
                    updated_at = CURRENT_TIMESTAMP
                WHERE library_id = ? AND release_group_id = ?
            `);
            for (const libraryId of libraryIds) {
                clearUserExclusions(db, libraryId, releaseGroup.id);
                clearEdition.run(libraryId, releaseGroup.id);
                clearAlbum.run(libraryId, releaseGroup.id);
            }
        })();

        const artists = db.prepare(`
            SELECT DISTINCT library_artist.library_id AS library_id,
                            library_artist.id AS library_artist_id
            FROM Albums album
            JOIN ArtistMetadata artist ON artist.mbid = album.artist_mbid
            JOIN LibraryArtists library_artist
              ON library_artist.artist_metadata_id = artist.id
            JOIN Libraries library
              ON library.id = library_artist.library_id AND library.enabled = 1
            WHERE album.id = ?
        `).all(releaseGroup.id) as Array<{ library_id: number; library_artist_id: number }>;
        const byLibrary = new Map<number, number[]>();
        for (const row of artists) {
            const list = byLibrary.get(row.library_id) || [];
            list.push(row.library_artist_id);
            byLibrary.set(row.library_id, list);
        }
        const curation = new LibraryCurationService(db);
        for (const [libraryId, libraryArtistIds] of byLibrary) {
            curation.curateLibrary({
                libraryId,
                providerPriority: getAcquisitionProviderPriority(),
                acquisitionPlannerVersion: ACQUISITION_PLANNER_VERSION,
                curationVersion: 1,
                scope: { libraryArtistIds },
            });
        }
        invalidateReleaseGroupDownloadStatus(albumId);
        emitLibraryUpdated({
            reason: "album-decision-cleared",
            releaseGroupMbids: [albumId],
            libraryIds,
        });
        return { success: true };
    }

}


