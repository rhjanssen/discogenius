/**
 * Command queue ordering + row hydration helpers.
 *
 * The SQL `ORDER BY` builders and the in-memory priority comparators mirror
 * Lidarr's `CommandPriorityComparer` / `CommandQueue` ordering; `safeParsePayload`
 * + `hydrateJobRow` turn a raw `commands` row into a typed `CommandModel`. Pure
 * functions (no `CommandQueueService` dependency) so they're independently
 * testable (see queue-ordering.test.ts) and don't form an import cycle.
 */

import { CommandTrigger } from "./command-trigger.js";
import type { CommandBodyCommon } from "./command-bodies.js";
import { isCommandName, type CommandName } from "./command-names.js";
import type { AnyCommandBody, CommandModel, CommandModelRecordBase } from "./command-model.js";

export function isObjectPayload(value: unknown): value is CommandBodyCommon {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function safeParsePayload(raw: unknown, jobId?: number): CommandBodyCommon {
    if (isObjectPayload(raw)) return raw;
    if (typeof raw !== 'string') return {};

    try {
        const parsed = JSON.parse(raw);
        return isObjectPayload(parsed) ? parsed : {};
    } catch (error) {
        console.warn(`[Queue] Failed to parse payload for job ${jobId ?? 'unknown'}; using empty payload`, error);
        return {};
    }
}

export function buildTypeInClause(types: readonly string[]): string {
    return types.map(() => '?').join(',');
}

export function parseSqliteDate(value: unknown): number {
    if (!value) {
        return 0;
    }

    if (typeof value === "string") {
        const normalized = value.includes("T") || value.includes("Z")
            ? value
            : value.replace(" ", "T") + "Z";
        return new Date(normalized).getTime() || 0;
    }

    return new Date(value as string | number | Date).getTime() || 0;
}

function buildColumnName(column: string, alias?: string): string {
    return alias ? `${alias}.${column}` : column;
}

export function buildExecutionOrderClause(alias?: string): string {
    const priority = buildColumnName("priority", alias);
    const trigger = buildColumnName("trigger", alias);
    const queueOrder = buildColumnName("queue_order", alias);
    const createdAt = buildColumnName("created_at", alias);
    const id = buildColumnName("id", alias);

    return `
                ${priority} DESC,
                ${trigger} DESC,
                COALESCE(${queueOrder}, 2147483647) ASC,
                ${createdAt} ASC,
                ${id} ASC
            `;
}

export function buildDurableQueueOrderClause(alias?: string): string {
    const queueOrder = buildColumnName("queue_order", alias);
    const createdAt = buildColumnName("created_at", alias);
    const id = buildColumnName("id", alias);

    return `
                COALESCE(${queueOrder}, 2147483647) ASC,
                ${createdAt} ASC,
                ${id} ASC
            `;
}

export function buildLiveActivityOrderClause(alias?: string): string {
    const status = buildColumnName("status", alias);
    const priority = buildColumnName("priority", alias);
    const trigger = buildColumnName("trigger", alias);
    const queueOrder = buildColumnName("queue_order", alias);
    const createdAt = buildColumnName("created_at", alias);
    const startedAt = buildColumnName("started_at", alias);
    const updatedAt = buildColumnName("updated_at", alias);
    const id = buildColumnName("id", alias);

    return `
                CASE
                    WHEN ${status} = 'started' THEN 0
                    WHEN ${status} = 'queued' THEN 1
                    ELSE 2
                END ASC,
                CASE
                    WHEN ${status} = 'started' THEN COALESCE(${updatedAt}, ${startedAt}, ${createdAt})
                END DESC,
                CASE
                    WHEN ${status} = 'started' THEN ${id}
                END DESC,
                CASE
                    WHEN ${status} = 'queued' THEN ${priority}
                END DESC,
                CASE
                    WHEN ${status} = 'queued' THEN ${trigger}
                END DESC,
                CASE
                    WHEN ${status} = 'queued' THEN COALESCE(${queueOrder}, 2147483647)
                END ASC,
                CASE
                    WHEN ${status} = 'queued' THEN ${createdAt}
                END ASC,
                CASE
                    WHEN ${status} = 'queued' THEN ${id}
                END ASC,
                ${id} DESC
            `;
}

export function buildHistoryOrderClause(alias?: string): string {
    const completedAt = buildColumnName("completed_at", alias);
    const updatedAt = buildColumnName("updated_at", alias);
    const startedAt = buildColumnName("started_at", alias);
    const createdAt = buildColumnName("created_at", alias);
    const id = buildColumnName("id", alias);

    return `
                ${completedAt} DESC,
                ${updatedAt} DESC,
                ${startedAt} DESC,
                ${createdAt} DESC,
                ${id} DESC
            `;
}

export function hydrateJobRow(row: { name: string; payload: unknown; id: number } & Record<string, unknown>): CommandModel | null {
    if (!isCommandName(row.name)) {
        console.warn(`[TaskQueue] Encountered unknown job type ${String(row.name)} for job ${row.id}; skipping typed hydration`);
        return null;
    }

    return {
        ...(row as Omit<CommandModelRecordBase<CommandName>, 'payload'> & { payload: unknown }),
        name: row.name,
        payload: safeParsePayload(row.payload, row.id) as AnyCommandBody,
    } as CommandModel;
}

export function compareJobsByExecutionOrder(left: CommandModel, right: CommandModel): number {
    if (left.priority !== right.priority) {
        return right.priority - left.priority;
    }

    const leftTrigger = left.trigger ?? CommandTrigger.Unspecified;
    const rightTrigger = right.trigger ?? CommandTrigger.Unspecified;
    if (leftTrigger !== rightTrigger) {
        return rightTrigger - leftTrigger;
    }

    const leftQueueOrder = left.queue_order ?? Number.MAX_SAFE_INTEGER;
    const rightQueueOrder = right.queue_order ?? Number.MAX_SAFE_INTEGER;
    if (leftQueueOrder !== rightQueueOrder) {
        return leftQueueOrder - rightQueueOrder;
    }

    const leftCreatedAt = parseSqliteDate(left.created_at);
    const rightCreatedAt = parseSqliteDate(right.created_at);
    if (leftCreatedAt !== rightCreatedAt) {
        return leftCreatedAt - rightCreatedAt;
    }

    return left.id - right.id;
}

export function compareJobsByDurableQueueOrder(left: CommandModel, right: CommandModel): number {
    const leftQueueOrder = left.queue_order ?? Number.MAX_SAFE_INTEGER;
    const rightQueueOrder = right.queue_order ?? Number.MAX_SAFE_INTEGER;
    if (leftQueueOrder !== rightQueueOrder) {
        return leftQueueOrder - rightQueueOrder;
    }

    const leftCreatedAt = parseSqliteDate(left.created_at);
    const rightCreatedAt = parseSqliteDate(right.created_at);
    if (leftCreatedAt !== rightCreatedAt) {
        return leftCreatedAt - rightCreatedAt;
    }

    return left.id - right.id;
}

export function sortJobsByExecutionOrder<T extends CommandModel>(jobs: T[]): T[] {
    return jobs.sort(compareJobsByExecutionOrder);
}
