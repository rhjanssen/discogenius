import { CommandTrigger } from "./command-trigger.js";
import type {
  SystemTaskCategoryContract,
  SystemTaskRiskContract,
} from "../../contracts/system-task.js";
import {CommandNames} from "./command-names.js";
import {type CommandName} from "./command-queue-manager.js";
import {
  queueCleanupTempFiles,
  queueCompactDatabase,
  queueConfigPrune,
  queueCurationPass,
  queueCheckHealth,
  queueBulkRefreshArtist,
  queueDownloadMissingForce,
  queueDownloadMissingPass,
  queueHousekeepingPass,
  queueMetadataRefreshPass,
  queueMonitoringCyclePass,
  queueRescanAllRoots,
  queueRescanFoldersPass,
  queueUpdateLibraryMetadata,
  queueCheckUpgradesPass,
} from "./scheduler.js";

export interface CommandDefinition {
  type: CommandName;
  name: string;
  requiresDiskAccess: boolean;
  isTypeExclusive: boolean;
  isExclusive: boolean;
  isLongRunning: boolean;
  isPerRefExclusive?: boolean;
  maxConcurrent?: number;
}

export interface SystemTaskDefinition {
  id: string;
  kind: "scheduled" | "manual";
  commandName: string;
  name: string;
  description: string;
  taskName: CommandName;
  category: SystemTaskCategoryContract;
  riskLevel: SystemTaskRiskContract;
  visibleInSystemTasks: boolean;
  run: () => number;
}

export type CommandQueueCategory = "downloads" | "scans" | "other";

const COMMAND_QUEUE_CATEGORY_TYPES = {
  downloads: [
    CommandNames.DownloadTrack,
    CommandNames.DownloadVideo,
    CommandNames.DownloadAlbum,
    CommandNames.ImportDownload,
  ],
  scans: [
    CommandNames.RefreshArtist,
    CommandNames.RefreshAlbum,
    CommandNames.RefreshMetadata,
    CommandNames.ApplyCuration,
    CommandNames.DownloadMissing,
    CommandNames.CheckUpgrades,
    CommandNames.CurateArtist,
    CommandNames.RescanFolders,
    CommandNames.Housekeeping,
    CommandNames.ConfigPrune,
    CommandNames.MoveArtist,
    CommandNames.RenameFiles,
    CommandNames.RenameArtist,
    CommandNames.RetagFiles,
    CommandNames.RetagArtist,
  ],
} satisfies Record<Exclude<CommandQueueCategory, "other">, readonly CommandName[]>;

export const PENDING_ACTIVITY_COMMAND_NAMES = COMMAND_QUEUE_CATEGORY_TYPES.scans;

export const COMMAND_DEFINITIONS = {
  [CommandNames.DownloadTrack]: {
    type: CommandNames.DownloadTrack,
    name: "Download Track",
    requiresDiskAccess: false,
    isTypeExclusive: false,
    isExclusive: false,
    isLongRunning: false,
  },
  [CommandNames.BulkRefreshArtist]: {
    type: CommandNames.BulkRefreshArtist,
    name: "Bulk Refresh Artist",
    requiresDiskAccess: false,
    isTypeExclusive: true,
    isExclusive: false,
    isLongRunning: true,
  },
  [CommandNames.DownloadMissingForce]: {
    type: CommandNames.DownloadMissingForce,
    name: "Download Missing (Force)",
    requiresDiskAccess: false,
    isTypeExclusive: false,
    isExclusive: false,
    isLongRunning: true,
  },
  [CommandNames.RescanAllRoots]: {
    type: CommandNames.RescanAllRoots,
    name: "Rescan All Roots",
    requiresDiskAccess: true,
    isTypeExclusive: true,
    isExclusive: false,
    isLongRunning: true,
  },
  [CommandNames.CheckHealth]: {
    type: CommandNames.CheckHealth,
    name: "Check Health",
    requiresDiskAccess: false,
    isTypeExclusive: true,
    isExclusive: false,
    isLongRunning: false,
  },
  [CommandNames.CompactDatabase]: {
    type: CommandNames.CompactDatabase,
    name: "Compact Database",
    requiresDiskAccess: true,
    isTypeExclusive: true,
    isExclusive: false,
    isLongRunning: false,
  },
  [CommandNames.CleanupTempFiles]: {
    type: CommandNames.CleanupTempFiles,
    name: "Cleanup Temporary Files",
    requiresDiskAccess: true,
    isTypeExclusive: false,
    isExclusive: false,
    isLongRunning: false,
  },
  [CommandNames.UpdateLibraryMetadata]: {
    type: CommandNames.UpdateLibraryMetadata,
    name: "Update Library Metadata",
    requiresDiskAccess: false,
    isTypeExclusive: true,
    isExclusive: false,
    isLongRunning: true,
  },
  [CommandNames.DownloadVideo]: {
    type: CommandNames.DownloadVideo,
    name: "Download Video",
    requiresDiskAccess: false,
    isTypeExclusive: false,
    isExclusive: false,
    isLongRunning: false,
  },
  [CommandNames.DownloadAlbum]: {
    type: CommandNames.DownloadAlbum,
    name: "Download Album",
    requiresDiskAccess: false,
    isTypeExclusive: false,
    isExclusive: false,
    isLongRunning: true,
  },
  [CommandNames.RefreshArtist]: {
    type: CommandNames.RefreshArtist,
    name: "Refresh Artist",
    requiresDiskAccess: false,
    isTypeExclusive: false,
    isExclusive: false,
    isLongRunning: true,
    isPerRefExclusive: true,
    maxConcurrent: 3,
  },
  [CommandNames.RefreshAlbum]: {
    type: CommandNames.RefreshAlbum,
    name: "Refresh Album",
    requiresDiskAccess: false,
    isTypeExclusive: false,
    isExclusive: false,
    isLongRunning: false,
  },
  [CommandNames.RefreshMetadata]: {
    type: CommandNames.RefreshMetadata,
    name: "Refresh Metadata",
    requiresDiskAccess: false,
    isTypeExclusive: true,
    isExclusive: false,
    isLongRunning: true,
  },
  [CommandNames.ApplyCuration]: {
    type: CommandNames.ApplyCuration,
    name: "Apply Curation",
    requiresDiskAccess: false,
    isTypeExclusive: true,
    isExclusive: false,
    isLongRunning: true,
  },
  [CommandNames.DownloadMissing]: {
    type: CommandNames.DownloadMissing,
    name: "Download Missing",
    requiresDiskAccess: false,
    isTypeExclusive: true,
    isExclusive: false,
    isLongRunning: true,
  },
  [CommandNames.CheckUpgrades]: {
    type: CommandNames.CheckUpgrades,
    name: "Check Upgrades",
    requiresDiskAccess: true,
    isTypeExclusive: true,
    isExclusive: false,
    isLongRunning: true,
  },
  [CommandNames.Housekeeping]: {
    type: CommandNames.Housekeeping,
    name: "Housekeeping",
    requiresDiskAccess: true,
    isTypeExclusive: true,
    isExclusive: false,
    isLongRunning: true,
  },
  [CommandNames.CurateArtist]: {
    type: CommandNames.CurateArtist,
    name: "Curate Artist",
    requiresDiskAccess: false,
    isTypeExclusive: false,
    isExclusive: false,
    isLongRunning: true,
    isPerRefExclusive: true,
    maxConcurrent: 3,
  },
  [CommandNames.ImportDownload]: {
    type: CommandNames.ImportDownload,
    name: "Import Download",
    requiresDiskAccess: true,
    isTypeExclusive: false,
    isExclusive: false,
    isLongRunning: false,
  },
  [CommandNames.RescanFolders]: {
    type: CommandNames.RescanFolders,
    name: "Rescan Folders",
    requiresDiskAccess: true,
    isTypeExclusive: false,
    isExclusive: false,
    isPerRefExclusive: true,
    isLongRunning: true,
  },
  [CommandNames.ConfigPrune]: {
    type: CommandNames.ConfigPrune,
    name: "Prune Configuration",
    requiresDiskAccess: true,
    isTypeExclusive: true,
    isExclusive: false,
    isLongRunning: false,
  },
  [CommandNames.MoveArtist]: {
    type: CommandNames.MoveArtist,
    name: "Move Artist",
    requiresDiskAccess: true,
    isTypeExclusive: false,
    isExclusive: false,
    isLongRunning: true,
    isPerRefExclusive: true,
  },
  [CommandNames.RenameFiles]: {
    type: CommandNames.RenameFiles,
    name: "Rename Files",
    requiresDiskAccess: true,
    isTypeExclusive: true,
    isExclusive: false,
    isLongRunning: true,
  },
  [CommandNames.RenameArtist]: {
    type: CommandNames.RenameArtist,
    name: "Rename Artist",
    requiresDiskAccess: true,
    isTypeExclusive: true,
    isExclusive: false,
    isLongRunning: true,
  },
  [CommandNames.RetagFiles]: {
    type: CommandNames.RetagFiles,
    name: "Retag Files",
    requiresDiskAccess: true,
    isTypeExclusive: true,
    isExclusive: false,
    isLongRunning: true,
  },
  [CommandNames.RetagArtist]: {
    type: CommandNames.RetagArtist,
    name: "Retag Artist",
    requiresDiskAccess: true,
    isTypeExclusive: true,
    isExclusive: false,
    isLongRunning: true,
  },
} satisfies Record<string, CommandDefinition>;

const SYSTEM_TASK_DEFINITIONS = [
  {
    id: "monitoring-cycle",
    kind: "scheduled",
    commandName: "MonitoringCycle",
    name: "Monitoring Cycle",
    description: "Refresh due monitored artists and rescan library roots during the configured monitoring window.",
    taskName: CommandNames.RescanFolders,
    category: "monitoring",
    riskLevel: "medium",
    visibleInSystemTasks: false,
    run: () => queueMonitoringCyclePass({ trigger: CommandTrigger.Manual, includeRootScan: true }),
  },
  {
    id: "housekeeping",
    kind: "scheduled",
    commandName: "Housekeeping",
    name: "Housekeeping",
    description: "Clean stale runtime state, repair library housekeeping records, and optimize the SQLite database.",
    taskName: CommandNames.Housekeeping,
    category: "maintenance",
    riskLevel: "medium",
    visibleInSystemTasks: false,
    run: () => queueHousekeepingPass({ trigger: CommandTrigger.Manual }),
  },
  {
    id: "refresh-metadata",
    kind: "manual",
    commandName: "RefreshMetadata",
    name: "Refresh Metadata",
    description: "Queue metadata refresh work for managed artists.",
    taskName: CommandNames.RefreshMetadata,
    category: "metadata",
    riskLevel: "medium",
    visibleInSystemTasks: false,
    run: () => queueMetadataRefreshPass({ trigger: CommandTrigger.Manual }),
  },
  {
    id: "apply-curation",
    kind: "manual",
    commandName: "ApplyCuration",
    name: "Apply Curation",
    description: "Queue a full curation pass for managed artists.",
    taskName: CommandNames.ApplyCuration,
    category: "library",
    riskLevel: "medium",
    visibleInSystemTasks: false,
    run: () => queueCurationPass({ trigger: CommandTrigger.Manual }),
  },
  {
    id: "download-missing",
    kind: "manual",
    commandName: "DownloadMissing",
    name: "Download Missing",
    description: "Queue monitored missing items so download jobs can be processed by the queue.",
    taskName: CommandNames.DownloadMissing,
    category: "downloads",
    riskLevel: "medium",
    visibleInSystemTasks: false,
    run: () => queueDownloadMissingPass({ trigger: CommandTrigger.Manual }),
  },
  {
    id: "check-upgrades",
    kind: "manual",
    commandName: "CheckUpgrades",
    name: "Check Upgrades",
    description: "Scan the library for monitored items that can be upgraded.",
    taskName: CommandNames.CheckUpgrades,
    category: "downloads",
    riskLevel: "medium",
    visibleInSystemTasks: true,
    run: () => queueCheckUpgradesPass({ trigger: CommandTrigger.Manual }),
  },
  {
    id: "rescan-folders",
    kind: "manual",
    commandName: "RescanFolders",
    name: "Rescan Folders",
    description: "Rescan configured library roots for known artist folders.",
    taskName: CommandNames.RescanFolders,
    category: "library",
    riskLevel: "medium",
    visibleInSystemTasks: false,
    run: () => queueRescanFoldersPass({ trigger: CommandTrigger.Manual, fullProcessing: false }),
  },
  {
    id: "refresh-all-monitored",
    kind: "manual",
    commandName: "BulkRefreshArtist",
    name: "Bulk Refresh Artist",
    description: "Queue a full refresh pass across all monitored artists.",
    taskName: CommandNames.BulkRefreshArtist,
    category: "metadata",
    riskLevel: "medium",
    visibleInSystemTasks: true,
    run: () => queueBulkRefreshArtist({ trigger: CommandTrigger.Manual }),
  },
  {
    id: "download-missing-force",
    kind: "manual",
    commandName: "DownloadMissingForce",
    name: "Download Missing (Force)",
    description: "Force a missing-download pass across monitored items.",
    taskName: CommandNames.DownloadMissingForce,
    category: "downloads",
    riskLevel: "medium",
    visibleInSystemTasks: true,
    run: () => queueDownloadMissingForce({ trigger: CommandTrigger.Manual }),
  },
  {
    id: "rescan-all-roots",
    kind: "manual",
    commandName: "RescanAllRoots",
    name: "Rescan All Roots",
    description: "Scan all configured library roots for new artist folders and unmanaged changes.",
    taskName: CommandNames.RescanAllRoots,
    category: "library",
    riskLevel: "high",
    visibleInSystemTasks: true,
    run: () => queueRescanAllRoots({ trigger: CommandTrigger.Manual }),
  },
  {
    id: "health-check",
    kind: "manual",
    commandName: "CheckHealth",
    name: "Check Health",
    description: "Run health diagnostics across runtime paths, tools, and downloader capability checks.",
    taskName: CommandNames.CheckHealth,
    category: "maintenance",
    riskLevel: "low",
    visibleInSystemTasks: true,
    run: () => queueCheckHealth({ trigger: CommandTrigger.Manual }),
  },
  {
    id: "compact-database",
    kind: "manual",
    commandName: "CompactDatabase",
    name: "Compact Database",
    description: "Run SQLite compaction and cleanup maintenance.",
    taskName: CommandNames.CompactDatabase,
    category: "maintenance",
    riskLevel: "high",
    visibleInSystemTasks: false,
    run: () => queueCompactDatabase({ trigger: CommandTrigger.Manual }),
  },
  {
    id: "cleanup-temp-files",
    kind: "manual",
    commandName: "CleanupTempFiles",
    name: "Cleanup Temporary Files",
    description: "Delete stale temp files left behind by downloads and processing.",
    taskName: CommandNames.CleanupTempFiles,
    category: "maintenance",
    riskLevel: "medium",
    visibleInSystemTasks: true,
    run: () => queueCleanupTempFiles({ trigger: CommandTrigger.Manual }),
  },
  {
    id: "update-library-metadata",
    kind: "manual",
    commandName: "UpdateLibraryMetadata",
    name: "Update Library Metadata",
    description: "Queue metadata refresh work for the indexed local library surface.",
    taskName: CommandNames.UpdateLibraryMetadata,
    category: "metadata",
    riskLevel: "medium",
    visibleInSystemTasks: false,
    run: () => queueUpdateLibraryMetadata({ trigger: CommandTrigger.Manual }),
  },
  {
    id: "config-prune",
    kind: "manual",
    commandName: "ConfigPrune",
    name: "Prune Configuration",
    description: "Remove stale config-driven queue and metadata references.",
    taskName: CommandNames.ConfigPrune,
    category: "maintenance",
    riskLevel: "high",
    visibleInSystemTasks: true,
    run: () => queueConfigPrune({ trigger: CommandTrigger.Manual }),
  },
] satisfies readonly SystemTaskDefinition[];

function normalizeCommandName(value: string): string {
  return String(value || "").trim().toLowerCase();
}

export function getCommandDefinition(jobType: string): CommandDefinition {
  const definition = COMMAND_DEFINITIONS[jobType as keyof typeof COMMAND_DEFINITIONS];
  if (definition) {
    return definition;
  }

  return {
    type: jobType as CommandName,
    name: jobType,
    requiresDiskAccess: false,
    isTypeExclusive: false,
    isExclusive: false,
    isLongRunning: false,
  };
}

export function getCommandDefinitions(): CommandDefinition[] {
  return Object.values(COMMAND_DEFINITIONS);
}

export function getCommandTypesForQueueCategory(category: CommandQueueCategory): CommandName[] {
  if (category === "downloads") {
    return [...COMMAND_QUEUE_CATEGORY_TYPES.downloads];
  }

  if (category === "scans") {
    return [...COMMAND_QUEUE_CATEGORY_TYPES.scans];
  }

  const excluded = new Set<CommandName>([
    ...COMMAND_QUEUE_CATEGORY_TYPES.downloads,
    ...COMMAND_QUEUE_CATEGORY_TYPES.scans,
  ]);

  return getCommandDefinitions()
    .map((definition) => definition.type)
    .filter((type, index, values) => values.indexOf(type) === index)
    .filter((type) => !excluded.has(type));
}

export function getVisibleSystemTaskDefinitions(): SystemTaskDefinition[] {
  return SYSTEM_TASK_DEFINITIONS.filter((definition) => definition.visibleInSystemTasks);
}

export function getScheduledSystemTaskDefinitions(): SystemTaskDefinition[] {
  return SYSTEM_TASK_DEFINITIONS.filter((definition) => definition.kind === "scheduled");
}

export function findScheduledSystemTaskDefinitionById(id: string): SystemTaskDefinition | null {
  const normalizedId = String(id || "").trim().toLowerCase();
  return SYSTEM_TASK_DEFINITIONS.find((definition) => definition.kind === "scheduled" && definition.id === normalizedId) ?? null;
}

export function findSystemTaskDefinitionById(id: string): SystemTaskDefinition | null {
  const normalizedId = String(id || "").trim().toLowerCase();
  return SYSTEM_TASK_DEFINITIONS.find((definition) => definition.id === normalizedId) ?? null;
}

export function findSystemTaskDefinitionByCommandName(commandName: string): SystemTaskDefinition | null {
  const normalizedName = normalizeCommandName(commandName);
  return SYSTEM_TASK_DEFINITIONS.find((definition) => normalizeCommandName(definition.commandName) === normalizedName) ?? null;
}

export function runSystemTaskById(id: string): number {
  return findSystemTaskDefinitionById(id)?.run() ?? -1;
}

export function runCommandByName(commandName: string): number {
  return findSystemTaskDefinitionByCommandName(commandName)?.run() ?? -1;
}

