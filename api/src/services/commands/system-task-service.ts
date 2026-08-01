import { db } from "../../database.js";
import type {
  SystemTaskCategoryContract,
  SystemTaskContract,
  SystemTaskRiskContract,
} from "../../contracts/system-task.js";
import { CommandManager } from "./command.js";
import {
  findScheduledSystemTaskDefinitionById,
  getVisibleSystemTaskDefinitions,
  runCommandByName as runRegistryCommandByName,
  runSystemTaskById as runRegistrySystemTaskById,
  type SystemTaskDefinition,
} from "./command-registry.js";
import {
  getScheduledTaskSnapshots,
  updateMonitoringConfig,
  updateScheduledTask,
  type ScheduledTaskKey,
} from "./scheduler.js";
import {CommandQueueManager, type CommandName} from "./command-queue-manager.js";

function normalizeTaskId(value: string): string {
  return String(value || "").trim().toLowerCase();
}

function getRunTimes(taskName: string) {
  const row = db.prepare(`
    SELECT
      MAX(created_at) AS last_queued_time,
      MAX(started_at) AS last_start_time,
      MAX(CASE
        WHEN status IN ('completed', 'failed', 'cancelled') THEN completed_at
        ELSE NULL
      END) AS last_execution,
      MAX(CASE WHEN status = 'completed' THEN completed_at ELSE NULL END) AS last_success_time,
      MAX(CASE WHEN status = 'failed' THEN completed_at ELSE NULL END) AS last_failure_time,
      (
        SELECT terminal.status
        FROM commands terminal
        WHERE terminal.name = ?
          AND terminal.status IN ('completed', 'failed', 'cancelled')
          AND terminal.completed_at IS NOT NULL
        ORDER BY terminal.completed_at DESC, terminal.id DESC
        LIMIT 1
      ) AS last_execution_status
    FROM commands
    WHERE name = ?
  `).get(taskName, taskName) as {
    last_queued_time?: string | null;
    last_start_time?: string | null;
    last_execution?: string | null;
    last_execution_status?: "completed" | "failed" | "cancelled" | null;
    last_success_time?: string | null;
    last_failure_time?: string | null;
  } | undefined;

  return {
    lastQueuedTime: row?.last_queued_time ?? null,
    lastStartTime: row?.last_start_time ?? null,
    lastExecution: row?.last_execution ?? null,
    lastExecutionStatus: row?.last_execution_status ?? null,
    lastSuccessTime: row?.last_success_time ?? null,
    lastFailureTime: row?.last_failure_time ?? null,
  };
}

function isTaskActive(taskName: string) {
  return CommandQueueManager.listJobsByTypesAndStatuses(
    [taskName as CommandName],
    ["queued", "started"],
    1,
    0,
    { orderBy: "execution" },
  ).length > 0;
}

function mapScheduledTask(snapshot: ReturnType<typeof getScheduledTaskSnapshots>[number]): SystemTaskContract {
  const metadata = findScheduledSystemTaskDefinitionById(snapshot.key);
  const definition = CommandManager.getDefinition(snapshot.taskName);
  const runTimes = getRunTimes(snapshot.taskName);

  return {
    id: snapshot.key,
    kind: "scheduled",
    name: snapshot.name,
    description: metadata?.description || snapshot.name,
    taskName: snapshot.taskName,
    commandName: metadata?.commandName ?? null,
    category: metadata?.category ?? "maintenance",
    riskLevel: metadata?.riskLevel ?? "medium",
    canRunNow: Boolean(metadata),
    requiresDiskAccess: definition.requiresDiskAccess,
    isExclusive: definition.isExclusive,
    isTypeExclusive: definition.isTypeExclusive,
    isLongRunning: definition.isLongRunning,
    intervalMinutes: snapshot.intervalMinutes,
    enabled: snapshot.enabled,
    active: snapshot.active,
    lastQueuedTime: runTimes.lastQueuedTime,
    lastExecution: runTimes.lastExecution,
    lastExecutionStatus: runTimes.lastExecutionStatus,
    lastSuccessTime: runTimes.lastSuccessTime,
    lastFailureTime: runTimes.lastFailureTime,
    lastStartTime: runTimes.lastStartTime,
    nextExecution: snapshot.nextRunAt,
  };
}

function mapManualTask(definition: SystemTaskDefinition): SystemTaskContract {
  const commandDefinition = CommandManager.getDefinition(definition.taskName);
  const runTimes = getRunTimes(definition.taskName);

  return {
    id: definition.id,
    kind: "manual",
    name: definition.name,
    description: definition.description,
    taskName: definition.taskName,
    commandName: definition.commandName,
    category: definition.category,
    riskLevel: definition.riskLevel,
    canRunNow: true,
    requiresDiskAccess: commandDefinition.requiresDiskAccess,
    isExclusive: commandDefinition.isExclusive,
    isTypeExclusive: commandDefinition.isTypeExclusive,
    isLongRunning: commandDefinition.isLongRunning,
    intervalMinutes: null,
    enabled: null,
    active: isTaskActive(definition.taskName),
    lastQueuedTime: runTimes.lastQueuedTime,
    lastExecution: runTimes.lastExecution,
    lastExecutionStatus: runTimes.lastExecutionStatus,
    lastSuccessTime: runTimes.lastSuccessTime,
    lastFailureTime: runTimes.lastFailureTime,
    lastStartTime: runTimes.lastStartTime,
    nextExecution: null,
  };
}

export function listSystemTasks(): SystemTaskContract[] {
  const scheduled = getScheduledTaskSnapshots().map(mapScheduledTask);
  const manual = getVisibleSystemTaskDefinitions().filter((definition) => definition.kind === "manual").map(mapManualTask);

  return [...scheduled, ...manual].sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === "scheduled" ? -1 : 1;
    }

    const categoryCompare = left.category.localeCompare(right.category);
    if (categoryCompare !== 0) {
      return categoryCompare;
    }

    return left.name.localeCompare(right.name);
  });
}

export function getSystemTask(id: string): SystemTaskContract | null {
  const normalizedId = normalizeTaskId(id);
  return listSystemTasks().find((task) => task.id === normalizedId) ?? null;
}

export function runSystemTask(id: string): number {
  return runRegistrySystemTaskById(normalizeTaskId(id));
}

export function runCommandByName(commandName: string): number {
  return runRegistryCommandByName(commandName);
}

export function updateSystemTaskSchedule(id: string, updates: { enabled?: boolean; intervalMinutes?: number }): SystemTaskContract {
  const normalizedId = normalizeTaskId(id);
  const task = getSystemTask(normalizedId);

  if (!task) {
    throw new Error(`Unknown system task: ${id}`);
  }

  if (task.kind !== "scheduled") {
    throw new Error(`System task ${task.name} does not have editable schedule settings`);
  }

  if (normalizedId === "monitoring-cycle") {
    // Persist the interval first. Enabling monitoring starts the scheduler
    // immediately, so the first tick must already observe the complete PATCH
    // instead of briefly running with the previous interval.
    if (updates.intervalMinutes !== undefined) {
      updateScheduledTask("monitoring-cycle", {
        intervalMinutes: updates.intervalMinutes,
      });
    }
    if (updates.enabled !== undefined) {
      updateMonitoringConfig({
        enable_active_monitoring: updates.enabled,
      });
    }
  } else {
    updateScheduledTask(normalizedId as ScheduledTaskKey, {
      enabled: updates.enabled,
      intervalMinutes: updates.intervalMinutes,
    });
  }

  const updatedTask = getSystemTask(normalizedId);
  if (!updatedTask) {
    throw new Error(`Failed to reload updated system task: ${id}`);
  }

  return updatedTask;
}
