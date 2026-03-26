import { db } from "../database.js";
import type {
  SystemTaskCategoryContract,
  SystemTaskContract,
  SystemTaskRiskContract,
} from "../contracts/system-task.js";
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
} from "./monitoring-scheduler.js";
import { TaskQueueService, type JobType } from "./queue.js";

function normalizeTaskId(value: string): string {
  return String(value || "").trim().toLowerCase();
}

function getRunTimes(taskName: string) {
  const row = db.prepare(`
    SELECT started_at, completed_at, created_at
    FROM job_queue
    WHERE type = ?
    ORDER BY COALESCE(started_at, created_at) DESC, id DESC
    LIMIT 1
  `).get(taskName) as { started_at?: string | null; completed_at?: string | null; created_at?: string | null } | undefined;

  return {
    lastStartTime: row?.started_at ?? row?.created_at ?? null,
    lastExecution: row?.completed_at ?? row?.created_at ?? null,
  };
}

function isTaskActive(taskName: string) {
  return TaskQueueService.listJobsByTypesAndStatuses(
    [taskName as JobType],
    ["pending", "processing"],
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
    lastExecution: runTimes.lastExecution ?? snapshot.lastQueuedAt,
    lastStartTime: runTimes.lastStartTime ?? snapshot.lastQueuedAt,
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
    lastExecution: runTimes.lastExecution,
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
    const monitoringUpdates: Record<string, unknown> = {};
    if (updates.enabled !== undefined) {
      monitoringUpdates.enable_active_monitoring = updates.enabled;
    }
    if (updates.intervalMinutes !== undefined) {
      monitoringUpdates.scan_interval_hours = Math.max(1, Math.round(updates.intervalMinutes / 60));
    }
    updateMonitoringConfig(monitoringUpdates);
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
