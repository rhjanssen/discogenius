/**
 * Command queue ordering + row hydration helpers.
 *
 * The SQL `ORDER BY` builders and the in-memory priority comparators define
 * queue execution order; `safeParsePayload` + `hydrateJobRow` turn a raw
 * `commands` row into a typed `CommandModel`. Pure functions (no
 * `CommandQueueManager` dependency) so they're independently testable
 * (see queue-ordering.test.ts) and don't form an import cycle.
 */

import { CommandTrigger } from "./command-trigger.js";
import type { CommandBodyCommon } from "./command-bodies.js";
import { isCatalogHydrationCommand, isCommandName, type CommandName } from "./command-names.js";
import type { AnyCommandBody, CommandModel, CommandModelRecordBase } from "./command-model.js";

export function isObjectPayload(value: unknown): value is CommandBodyCommon {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function safeParsePayload(raw: unknown, commandId?: number): CommandBodyCommon {
    if (isObjectPayload(raw)) return raw;
    if (typeof raw !== 'string') return {};

    try {
        const parsed = JSON.parse(raw);
        return isObjectPayload(parsed) ? parsed : {};
    } catch (error) {
        console.warn(`[Queue] Failed to parse payload for job ${commandId ?? 'unknown'}; using empty payload`, error);
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

/**
 * Persisted trigger values are a storage contract, not a numeric priority.
 * Manual work is intentionally ahead of scheduled work at equal command
 * priority; scheduled work is ahead of unspecified/background work.
 */
export function commandTriggerRank(trigger: number | null | undefined): number {
    if (trigger === CommandTrigger.Manual) return 2;
    if (trigger === CommandTrigger.Scheduled) return 1;
    return 0;
}

export function buildTriggerRankExpression(alias?: string): string {
    const trigger = buildColumnName("trigger", alias);
    return `CASE
                    WHEN ${trigger} = ${CommandTrigger.Manual} THEN 2
                    WHEN ${trigger} = ${CommandTrigger.Scheduled} THEN 1
                    ELSE 0
                END`;
}

export function buildExecutionOrderClause(alias?: string): string {
    const priority = buildColumnName("priority", alias);
    const triggerRank = buildTriggerRankExpression(alias);
    const queueOrder = buildColumnName("queue_order", alias);
    const createdAt = buildColumnName("created_at", alias);
    const id = buildColumnName("id", alias);

    return `
                ${priority} DESC,
                ${triggerRank} DESC,
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

export function buildLiveActivityOrderClause(
    alias?: string,
    queuedOrder: "execution" | "durable" = "execution",
): string {
    const status = buildColumnName("status", alias);
    const priority = buildColumnName("priority", alias);
    const triggerRank = buildTriggerRankExpression(alias);
    const queueOrder = buildColumnName("queue_order", alias);
    const createdAt = buildColumnName("created_at", alias);
    const id = buildColumnName("id", alias);
    const queuedPriorityOrder = queuedOrder === "execution"
        ? `
                CASE
                    WHEN ${status} = 'queued' THEN ${priority}
                END DESC,
                CASE
                    WHEN ${status} = 'queued' THEN ${triggerRank}
                END DESC,`
        : "";

    // Active ('started') items are floated above queued ones, but WITHIN the
    // active bucket they must keep a STABLE position — sorting them by
    // updated_at/started_at made the list reshuffle every second, because the
    // download processor bumps updated_at on each ~1s progress tick, so whichever
    // item ticked last jumped to the top. Ordering active items by their durable
    // queue order (queue_order, created_at, id) — the same key queued items use —
    // keeps each card in place while it downloads/imports.
    return `
                CASE
                    WHEN ${status} = 'started' THEN 0
                    WHEN ${status} = 'queued' THEN 1
                    ELSE 2
                END ASC,
                CASE
                    WHEN ${status} = 'started' THEN COALESCE(${queueOrder}, 2147483647)
                END ASC,
                CASE
                    WHEN ${status} = 'started' THEN ${createdAt}
                END ASC,
                CASE
                    WHEN ${status} = 'started' THEN ${id}
                END ASC,
                ${queuedPriorityOrder}
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

    const leftTriggerRank = commandTriggerRank(left.trigger);
    const rightTriggerRank = commandTriggerRank(right.trigger);
    if (leftTriggerRank !== rightTriggerRank) {
        return rightTriggerRank - leftTriggerRank;
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

/**
 * Keep one command-worker slot free for operator work (housekeeping, curate,
 * download-missing, rename) when catalog hydration would otherwise consume the
 * last idle worker for tens of minutes.
 */
export function shouldDeferCatalogHydration(options: {
    candidateName: string;
    remainingSlotsIncludingThis: number;
    pendingNames: readonly string[];
}): boolean {
    if (options.remainingSlotsIncludingThis > 1) return false;
    if (!isCatalogHydrationCommand(options.candidateName)) return false;
    return options.pendingNames.some((name) => !isCatalogHydrationCommand(name));
}

export function sortJobsByExecutionOrder<T extends CommandModel>(jobs: T[]): T[] {
    return jobs.sort(compareJobsByExecutionOrder);
}
