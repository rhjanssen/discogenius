/**
 * Command System - command/task management
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

import { db } from '../../database.js';
import {CommandModel} from "./command-model.js";
import {CommandNames, isCommandName} from "./command-names.js";
import {type CommandName} from "./command-queue-manager.js";
import {
    getCommandDefinition,
    getCommandTypesForQueueCategory,
    type CommandDefinition,
    type CommandQueueCategory,
} from './command-registry.js';
import type { CommandBodyCommon } from './command-bodies.js';

export interface CanStartCommandOptions {
    /** Job types to ignore when evaluating running-job exclusivity (e.g. download types for the Scheduler). */
    excludeRunningTypes?: readonly string[];
}

// ============================================================================
// Command Manager Service
// ============================================================================

export class CommandManager {
    /**
     * Check if a command can be started based on exclusivity rules.
     * When payload is provided, dynamic exclusivity overrides are applied
     * (e.g. RescanFolders with addNewArtists becomes exclusive).
     */
    static canStartCommand(jobType: string, payload?: CommandBodyCommon, refId?: string | null, options?: CanStartCommandOptions): { canStart: boolean; reason?: string } {
        const definition = this.getDefinition(jobType);

        // Dynamic exclusivity: RescanFolders with addNewArtists behaves as exclusive + type-exclusive
        const isLibraryWideScan = jobType === CommandNames.RescanFolders && (payload as any)?.addNewArtists === true;
        const effectiveIsExclusive = definition.isExclusive || isLibraryWideScan;
        const effectiveIsTypeExclusive = definition.isTypeExclusive || isLibraryWideScan;

        // Get currently processing jobs, excluding types from a different processor pipeline
        const excludeSet = options?.excludeRunningTypes && options.excludeRunningTypes.length > 0
            ? new Set(options.excludeRunningTypes)
            : null;
        const allProcessing = db.prepare(`
            SELECT name, ref_id, payload FROM commands WHERE status = 'started'
        `).all() as Array<{ name: string; ref_id: string | null; payload: string | null }>;
        const processingJobs = excludeSet
            ? allProcessing.filter(j => !excludeSet.has(j.name))
            : allProcessing;

        if (processingJobs.length === 0) {
            return { canStart: true };
        }

        // Check for exclusive commands currently running
        for (const running of processingJobs) {
            const runningDef = this.getDefinition(running.name);
            let runningIsExclusive = runningDef.isExclusive;
            // Check if a running RescanFolders job is a library-wide scan
            if (running.name === CommandNames.RescanFolders && !runningIsExclusive) {
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
            const sameTypeRunning = processingJobs.find(j => j.name === jobType);
            if (sameTypeRunning) {
                return {
                    canStart: false,
                    reason: `Another ${definition.name} command is already running`
                };
            }
        }

        // Check per-ref exclusivity (e.g. only one RefreshArtist per artist at a time)
        if (definition.isPerRefExclusive && refId) {
            const sameRefRunning = processingJobs.find(j => j.name === jobType && j.ref_id === refId);
            if (sameRefRunning) {
                return {
                    canStart: false,
                    reason: `A ${definition.name} for this item is already running`,
                };
            }
        }

        // Optional command-level max concurrency cap
        if (definition.maxConcurrent !== undefined) {
            const runningSameTypeCount = processingJobs.filter(j => j.name === jobType).length;
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
                const def = this.getDefinition(j.name);
                return def.requiresDiskAccess;
            });
            if (diskAccessRunning) {
                const runningDef = this.getDefinition(diskAccessRunning.name);
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
        downloads: { queued: number; started: number; failed: number };
        scans: { queued: number; started: number; failed: number };
        other: { queued: number; started: number; failed: number };
    } {
        const downloadTypes = new Set(getCommandTypesForQueueCategory('downloads'));
        const scanTypes = new Set(getCommandTypesForQueueCategory('scans'));
        const stats = db.prepare(`
            SELECT
                name,
                status,
                COUNT(*) as count
            FROM commands
            WHERE status IN ('queued', 'started', 'failed')
            GROUP BY name, status
        `).all() as Array<{ name: string; status: string; count: number }>;

        const result = {
            downloads: { queued: 0, started: 0, failed: 0 },
            scans: { queued: 0, started: 0, failed: 0 },
            other: { queued: 0, started: 0, failed: 0 },
        };

        for (const stat of stats) {
            const category: keyof typeof result = downloadTypes.has(stat.name as CommandName)
                ? 'downloads'
                : scanTypes.has(stat.name as CommandName)
                    ? 'scans'
                    : 'other';
            const status = stat.status as 'queued' | 'started' | 'failed';
            if (result[category] && result[category][status] !== undefined) {
                result[category][status] = stat.count;
            }
        }

        return result;
    }

    /**
     * Get all currently running commands
     */
    static getRunningCommands(): Array<CommandModel & { definition: CommandDefinition }> {
        const jobs = db.prepare(`
            SELECT * FROM commands WHERE status = 'started'
        `).all() as any[];

        return jobs.flatMap((job) => {
            const jobType = String(job.name);
            if (!isCommandName(jobType)) {
                return [];
            }

            const hydrated = {
                ...job,
                type: jobType,
                payload: JSON.parse(job.payload || '{}'),
            } as CommandModel;

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
            UPDATE commands 
            SET status = 'cancelled', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
            WHERE status = 'queued' AND name IN (${placeholders})
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
            DELETE FROM commands 
            WHERE status IN ('completed', 'cancelled') 
            AND completed_at < ?
        `).run(cutoffDate.toISOString());

        return result.changes;
    }

    /**
     * Get download history (completed downloads)
     */
    static getDownloadHistory(limit: number = 50): CommandModel[] {
        const jobs = db.prepare(`
            SELECT * FROM commands 
            WHERE name LIKE 'Download%' AND status IN ('completed', 'failed')
            ORDER BY completed_at DESC
            LIMIT ?
        `).all(limit) as any[];

        return jobs.flatMap((job) => {
            if (!isCommandName(job.name)) {
                return [];
            }

            return [{
                ...job,
                type: job.name,
                payload: JSON.parse(job.payload || '{}'),
            } as CommandModel];
        });
    }
}

export default CommandManager;

