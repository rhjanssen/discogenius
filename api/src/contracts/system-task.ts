import {
  expectArray,
  expectBoolean,
  expectNullableNumber,
  expectNullableString,
  expectNumber,
  expectOneOf,
  expectRecord,
  expectString,
} from "./runtime.js";

export const SYSTEM_TASK_KIND_VALUES = ["scheduled", "manual"] as const;
export type SystemTaskKindContract = (typeof SYSTEM_TASK_KIND_VALUES)[number];

export const SYSTEM_TASK_CATEGORY_VALUES = ["monitoring", "downloads", "metadata", "maintenance", "library"] as const;
export type SystemTaskCategoryContract = (typeof SYSTEM_TASK_CATEGORY_VALUES)[number];

export const SYSTEM_TASK_RISK_VALUES = ["low", "medium", "high"] as const;
export type SystemTaskRiskContract = (typeof SYSTEM_TASK_RISK_VALUES)[number];

export interface SystemTaskContract {
  id: string;
  kind: SystemTaskKindContract;
  name: string;
  description: string;
  taskName: string;
  commandName: string | null;
  category: SystemTaskCategoryContract;
  riskLevel: SystemTaskRiskContract;
  canRunNow: boolean;
  requiresDiskAccess: boolean;
  isExclusive: boolean;
  isTypeExclusive: boolean;
  isLongRunning: boolean;
  intervalMinutes: number | null;
  enabled: boolean | null;
  active: boolean;
  lastExecution: string | null;
  lastStartTime: string | null;
  nextExecution: string | null;
}

export interface UpdateSystemTaskRequestContract {
  enabled?: boolean;
  intervalMinutes?: number;
}

export interface RunSystemTaskResponseContract {
  id: number;
}

export function parseSystemTaskContract(value: unknown, label = "systemTask"): SystemTaskContract {
  const record = expectRecord(value, label);

  return {
    id: expectString(record.id, `${label}.id`),
    kind: expectOneOf(record.kind, SYSTEM_TASK_KIND_VALUES, `${label}.kind`),
    name: expectString(record.name, `${label}.name`),
    description: expectString(record.description, `${label}.description`),
    taskName: expectString(record.taskName, `${label}.taskName`),
    commandName: expectNullableString(record.commandName, `${label}.commandName`) ?? null,
    category: expectOneOf(record.category, SYSTEM_TASK_CATEGORY_VALUES, `${label}.category`),
    riskLevel: expectOneOf(record.riskLevel, SYSTEM_TASK_RISK_VALUES, `${label}.riskLevel`),
    canRunNow: expectBoolean(record.canRunNow, `${label}.canRunNow`),
    requiresDiskAccess: expectBoolean(record.requiresDiskAccess, `${label}.requiresDiskAccess`),
    isExclusive: expectBoolean(record.isExclusive, `${label}.isExclusive`),
    isTypeExclusive: expectBoolean(record.isTypeExclusive, `${label}.isTypeExclusive`),
    isLongRunning: expectBoolean(record.isLongRunning, `${label}.isLongRunning`),
    intervalMinutes: expectNullableNumber(record.intervalMinutes, `${label}.intervalMinutes`) ?? null,
    enabled: record.enabled === null || record.enabled === undefined
      ? null
      : expectBoolean(record.enabled, `${label}.enabled`),
    active: expectBoolean(record.active, `${label}.active`),
    lastExecution: expectNullableString(record.lastExecution, `${label}.lastExecution`) ?? null,
    lastStartTime: expectNullableString(record.lastStartTime, `${label}.lastStartTime`) ?? null,
    nextExecution: expectNullableString(record.nextExecution, `${label}.nextExecution`) ?? null,
  };
}

export function parseSystemTaskListContract(value: unknown): SystemTaskContract[] {
  return expectArray(value, "systemTasks", (item, index) => parseSystemTaskContract(item, `systemTasks[${index}]`));
}

export function parseRunSystemTaskResponseContract(value: unknown): RunSystemTaskResponseContract {
  const record = expectRecord(value, "runSystemTask");
  return {
    id: expectNumber(record.id, "runSystemTask.id"),
  };
}
