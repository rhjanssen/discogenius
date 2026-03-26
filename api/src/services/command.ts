/**
 * Command System - Lidarr-inspired command/task management
 * 
 * This module provides a centralized command queue with:
 * - Type-based exclusivity (only one scan at a time, etc.)
 * - Disk access exclusivity (prevent concurrent disk operations)
 * - Priority ordering with manual trigger boost
 * - Deduplication of equivalent commands
 * 
 * Commands are categorized into:
 * - Download*  : Download operations (handled by DownloadProcessor)
 * - Scan*      : Metadata scanning (handled by Scheduler)
 * - Import*    : File import operations
 * - Library    : Library maintenance (rename, cleanup)
 * - System     : System tasks (backup, cleanup)
 */

import { db } from '../database.js';
import { Job, JobTypes, isJobType, type JobType } from './queue.js';
import {
    getCommandDefinition,
    getCommandTypesForQueueCategory,
    type CommandDefinition,
    type CommandQueueCategory,
} from './command-registry.js';
import type { QueuePayloadCommon } from './job-payloads.js';

// ============================================================================
// Command Manager Service
// ============================================================================

export class CommandManager {
    /**
     * Check if a command can be started based on exclusivity rules.
     * When payload is provided, dynamic exclusivity overrides are applied
     * (e.g. RescanFolders with addNewArtists becomes exclusive).
     */
    static canStartCommand(jobType: string, payload?: QueuePayloadCommon, refId?: string | null): { canStart: boolean; reason?: string } {
        const definition = this.getDefinition(jobType);

        // Dynamic exclusivity: RescanFolders with addNewArtists behaves as exclusive + type-exclusive
        const isLibraryWideScan = jobType === JobTypes.RescanFolders && (payload as any)?.addNewArtists === true;
        const effectiveIsExclusive = definition.isExclusive || isLibraryWideScan;
        const effectiveIsTypeExclusive = definition.isTypeExclusive || isLibraryWideScan;

        // Get currently processing jobs
        const processingJobs = db.prepare(`
            SELECT type, ref_id, payload FROM job_queue WHERE status = 'processing'
        `).all() as Array<{ type: string; ref_id: string | null; payload: string | null }>;

        if (processingJobs.length === 0) {
            return { canStart: true };
        }

        // Check for exclusive commands currently running
        for (const running of processingJobs) {
            const runningDef = this.getDefinition(running.type);
            let runningIsExclusive = runningDef.isExclusive;
            // Check if a running RescanFolders job is a library-wide scan
            if (running.type === JobTypes.RescanFolders && !runningIsExclusive) {
                try {
                    const runningPayload = JSON.parse(running.payload || '{}');
                    if (runningPayload.addNewArtists === true) {
                        runningIsExclusive = true;
                    }
                } catch { /* ignore parse errors */ }
            }
            if (runningIsExclusive) {
                return {
                    canStart: false,
                    reason: `Exclusive command "${runningDef.name}" is running`
                };
            }
        }

        // If this command is exclusive, check if anything is running
        if (effectiveIsExclusive && processingJobs.length > 0) {
            return {
                canStart: false,
                reason: `Cannot start exclusive command while ${processingJobs.length} commands are running`
            };
        }

        // Check type exclusivity
        if (effectiveIsTypeExclusive) {
            const sameTypeRunning = processingJobs.find(j => j.type === jobType);
            if (sameTypeRunning) {
                return {
                    canStart: false,
                    reason: `Another ${definition.name} command is already running`
                };
            }
        }

        // Check per-ref exclusivity (e.g. only one RefreshArtist per artist at a time)
        if (definition.isPerRefExclusive && refId) {
            const sameRefRunning = processingJobs.find(j => j.type === jobType && j.ref_id === refId);
            if (sameRefRunning) {
                return {
                    canStart: false,
                    reason: `A ${definition.name} for this item is already running`,
                };
            }
        }

        // Optional command-level max concurrency cap
        if (definition.maxConcurrent !== undefined) {
            const runningSameTypeCount = processingJobs.filter(j => j.type === jobType).length;
            if (runningSameTypeCount >= definition.maxConcurrent) {
                return {
                    canStart: false,
                    reason: `${definition.name} reached max concurrency (${runningSameTypeCount}/${definition.maxConcurrent})`,
                };
            }
        }

        // Check disk access exclusivity
        if (definition.requiresDiskAccess) {
            const diskAccessRunning = processingJobs.find(j => {
                const def = this.getDefinition(j.type);
                return def.requiresDiskAccess;
            });
            if (diskAccessRunning) {
                const runningDef = this.getDefinition(diskAccessRunning.type);
                return {
                    canStart: false,
                    reason: `Disk-intensive command "${runningDef.name}" is running`
                };
            }
        }

        return { canStart: true };
    }

    /**
     * Get command definition by job type
     */
    static getDefinition(jobType: string): CommandDefinition {
        return getCommandDefinition(jobType);
    }

    /**
     * Get queue statistics grouped by category
     */
    static getTaskQueueStats(): {
        downloads: { pending: number; processing: number; failed: number };
        scans: { pending: number; processing: number; failed: number };
        other: { pending: number; processing: number; failed: number };
    } {
        const downloadTypes = new Set(getCommandTypesForQueueCategory('downloads'));
        const scanTypes = new Set(getCommandTypesForQueueCategory('scans'));
        const stats = db.prepare(`
            SELECT
                type,
                status,
                COUNT(*) as count
            FROM job_queue
            WHERE status IN ('pending', 'processing', 'failed')
            GROUP BY type, status
        `).all() as Array<{ type: string; status: string; count: number }>;

        const result = {
            downloads: { pending: 0, processing: 0, failed: 0 },
            scans: { pending: 0, processing: 0, failed: 0 },
            other: { pending: 0, processing: 0, failed: 0 },
        };

        for (const stat of stats) {
            const category: keyof typeof result = downloadTypes.has(stat.type as JobType)
                ? 'downloads'
                : scanTypes.has(stat.type as JobType)
                    ? 'scans'
                    : 'other';
            const status = stat.status as 'pending' | 'processing' | 'failed';
            if (result[category] && result[category][status] !== undefined) {
                result[category][status] = stat.count;
            }
        }

        return result;
    }

    /**
     * Get all currently running commands
     */
    static getRunningCommands(): Array<Job & { definition: CommandDefinition }> {
        const jobs = db.prepare(`
            SELECT * FROM job_queue WHERE status = 'processing'
        `).all() as any[];

        return jobs.flatMap((job) => {
            const jobType = String(job.type);
            if (!isJobType(jobType)) {
                return [];
            }

            const hydrated = {
                ...job,
                type: jobType,
                payload: JSON.parse(job.payload || '{}'),
            } as Job;

            return [{
                ...hydrated,
                definition: this.getDefinition(jobType),
            }];
        });
    }

    /**
     * Cancel all commands of a specific category
     */
    static cancelByCategory(category: CommandQueueCategory): number {
        const jobTypes = getCommandTypesForQueueCategory(category);
        if (jobTypes.length === 0) {
            return 0;
        }

        const placeholders = jobTypes.map(() => '?').join(', ');

        const result = db.prepare(`
            UPDATE job_queue 
            SET status = 'cancelled', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
            WHERE status = 'pending' AND type IN (${placeholders})
        `).run(...jobTypes);

        return result.changes;
    }

    /**
     * Clean up old completed/cancelled jobs
     */
    static cleanupOldJobs(olderThanDays: number = 7): number {
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

        const result = db.prepare(`
            DELETE FROM job_queue 
            WHERE status IN ('completed', 'cancelled') 
            AND completed_at < ?
        `).run(cutoffDate.toISOString());

        return result.changes;
    }

    /**
     * Get download history (completed downloads)
     */
    static getDownloadHistory(limit: number = 50): Job[] {
        const jobs = db.prepare(`
            SELECT * FROM job_queue 
            WHERE type LIKE 'Download%' AND status IN ('completed', 'failed')
            ORDER BY completed_at DESC
            LIMIT ?
        `).all(limit) as any[];

        return jobs.flatMap((job) => {
            if (!isJobType(job.type)) {
                return [];
            }

            return [{
                ...job,
                type: job.type,
                payload: JSON.parse(job.payload || '{}'),
            } as Job];
        });
    }
}

export default CommandManager;

