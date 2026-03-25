import type {
  SystemTaskCategoryContract,
  SystemTaskRiskContract,
} from "../contracts/system-task.js";
import { JobTypes, type JobType } from "./queue.js";
import {
  queueCleanupTempFiles,
  queueCompactDatabase,
  queueConfigPrune,
  queueCurationPass,
  queueDownloadMissingForce,
  queueDownloadMissingPass,
  queueHealthCheck,
  queueHousekeepingPass,
  queueMetadataRefreshPass,
  queueMonitoringCyclePass,
  queueRefreshAllMonitored,
  queueRescanAllRoots,
  queueRescanFoldersPass,
  queueUpdateLibraryMetadata,
  queueCheckUpgradesPass,
} from "./monitoring-scheduler.js";

export interface CommandDefinition {
  type: JobType;
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
  taskName: JobType;
  category: SystemTaskCategoryContract;
  riskLevel: SystemTaskRiskContract;
  visibleInSystemTasks: boolean;
  run: () => number;
}

export type CommandQueueCategory = "downloads" | "scans" | "other";

const COMMAND_QUEUE_CATEGORY_TYPES = {
  downloads: [
    JobTypes.DownloadTrack,
    JobTypes.DownloadVideo,
    JobTypes.DownloadAlbum,
    JobTypes.DownloadPlaylist,
    JobTypes.ImportDownload,
  ],
  scans: [
    JobTypes.RefreshArtist,
    JobTypes.ScanAlbum,
    JobTypes.ScanPlaylist,
    JobTypes.RefreshMetadata,
    JobTypes.ApplyCuration,
    JobTypes.DownloadMissing,
    JobTypes.CheckUpgrades,
    JobTypes.CurateArtist,
    JobTypes.RescanFolders,
    JobTypes.Housekeeping,
    JobTypes.ConfigPrune,
    JobTypes.ApplyRenames,
    JobTypes.ApplyRetags,
  ],
} satisfies Record<Exclude<CommandQueueCategory, "other">, readonly JobType[]>;

export const PENDING_ACTIVITY_JOB_TYPES = COMMAND_QUEUE_CATEGORY_TYPES.scans;

export const COMMAND_DEFINITIONS = {
  [JobTypes.DownloadTrack]: {
    type: JobTypes.DownloadTrack,
    name: "Download Track",
    requiresDiskAccess: false,
    isTypeExclusive: false,
    isExclusive: false,
    isLongRunning: false,
  },
  [JobTypes.RefreshAllMonitored]: {
    type: JobTypes.RefreshAllMonitored,
    name: "Refresh All Monitored Artists",
    requiresDiskAccess: false,
    isTypeExclusive: true,
    isExclusive: false,
    isLongRunning: true,
  },
  [JobTypes.DownloadMissingForce]: {
    type: JobTypes.DownloadMissingForce,
    name: "Download Missing (Force)",
    requiresDiskAccess: false,
    isTypeExclusive: false,
    isExclusive: false,
    isLongRunning: true,
  },
  [JobTypes.RescanAllRoots]: {
    type: JobTypes.RescanAllRoots,
    name: "Rescan All Roots",
    requiresDiskAccess: true,
    isTypeExclusive: true,
    isExclusive: false,
    isLongRunning: true,
  },
  [JobTypes.HealthCheck]: {
    type: JobTypes.HealthCheck,
    name: "Health Check",
    requiresDiskAccess: false,
    isTypeExclusive: true,
    isExclusive: false,
    isLongRunning: false,
  },
  [JobTypes.CompactDatabase]: {
    type: JobTypes.CompactDatabase,
    name: "Compact Database",
    requiresDiskAccess: true,
    isTypeExclusive: true,
    isExclusive: false,
    isLongRunning: false,
  },
  [JobTypes.CleanupTempFiles]: {
    type: JobTypes.CleanupTempFiles,
    name: "Cleanup Temporary Files",
    requiresDiskAccess: true,
    isTypeExclusive: false,
    isExclusive: false,
    isLongRunning: false,
  },
  [JobTypes.UpdateLibraryMetadata]: {
    type: JobTypes.UpdateLibraryMetadata,
    name: "Update Library Metadata",
    requiresDiskAccess: false,
    isTypeExclusive: true,
    isExclusive: false,
    isLongRunning: true,
  },
  [JobTypes.DownloadVideo]: {
    type: JobTypes.DownloadVideo,
    name: "Download Video",
    requiresDiskAccess: false,
    isTypeExclusive: false,
    isExclusive: false,
    isLongRunning: false,
  },
  [JobTypes.DownloadAlbum]: {
    type: JobTypes.DownloadAlbum,
    name: "Download Album",
    requiresDiskAccess: false,
    isTypeExclusive: false,
    isExclusive: false,
    isLongRunning: true,
  },
  [JobTypes.DownloadPlaylist]: {
    type: JobTypes.DownloadPlaylist,
    name: "Download Playlist",
    requiresDiskAccess: false,
    isTypeExclusive: false,
    isExclusive: false,
    isLongRunning: true,
  },
  [JobTypes.RefreshArtist]: {
    type: JobTypes.RefreshArtist,
    name: "Refresh Artist",
    requiresDiskAccess: false,
    isTypeExclusive: false,
    isExclusive: false,
    isLongRunning: true,
    isPerRefExclusive: true,
    maxConcurrent: 1,
  },
  [JobTypes.ScanAlbum]: {
    type: JobTypes.ScanAlbum,
    name: "Scan Album",
    requiresDiskAccess: false,
    isTypeExclusive: false,
    isExclusive: false,
    isLongRunning: false,
  },
  [JobTypes.ScanPlaylist]: {
    type: JobTypes.ScanPlaylist,
    name: "Scan Playlist",
    requiresDiskAccess: false,
    isTypeExclusive: false,
    isExclusive: false,
    isLongRunning: false,
  },
  [JobTypes.RefreshMetadata]: {
    type: JobTypes.RefreshMetadata,
    name: "Refresh Metadata",
    requiresDiskAccess: false,
    isTypeExclusive: true,
    isExclusive: false,
    isLongRunning: true,
  },
  [JobTypes.ApplyCuration]: {
    type: JobTypes.ApplyCuration,
    name: "Apply Curation",
    requiresDiskAccess: false,
    isTypeExclusive: true,
    isExclusive: false,
    isLongRunning: true,
  },
  [JobTypes.DownloadMissing]: {
    type: JobTypes.DownloadMissing,
    name: "Download Missing",
    requiresDiskAccess: false,
    isTypeExclusive: true,
    isExclusive: false,
    isLongRunning: true,
  },
  [JobTypes.CheckUpgrades]: {
    type: JobTypes.CheckUpgrades,
    name: "Check Upgrades",
    requiresDiskAccess: true,
    isTypeExclusive: true,
    isExclusive: false,
    isLongRunning: true,
  },
  [JobTypes.Housekeeping]: {
    type: JobTypes.Housekeeping,
    name: "Housekeeping",
    requiresDiskAccess: true,
    isTypeExclusive: true,
    isExclusive: false,
    isLongRunning: true,
  },
  [JobTypes.CurateArtist]: {
    type: JobTypes.CurateArtist,
    name: "Curate Artist",
    requiresDiskAccess: false,
    isTypeExclusive: false,
    isExclusive: false,
    isLongRunning: true,
    isPerRefExclusive: true,
    maxConcurrent: 1,
  },
  [JobTypes.ImportDownload]: {
    type: JobTypes.ImportDownload,
    name: "Import Download",
    requiresDiskAccess: true,
    isTypeExclusive: false,
    isExclusive: false,
    isLongRunning: false,
  },
  [JobTypes.RescanFolders]: {
    type: JobTypes.RescanFolders,
    name: "Rescan Folders",
    requiresDiskAccess: true,
    isTypeExclusive: false,
    isExclusive: false,
    isLongRunning: true,
  },
  [JobTypes.ConfigPrune]: {
    type: JobTypes.ConfigPrune,
    name: "Prune Configuration",
    requiresDiskAccess: true,
    isTypeExclusive: true,
    isExclusive: false,
    isLongRunning: false,
  },
  [JobTypes.ApplyRenames]: {
    type: JobTypes.ApplyRenames,
    name: "Apply Renames",
    requiresDiskAccess: true,
    isTypeExclusive: true,
    isExclusive: false,
    isLongRunning: true,
  },
  [JobTypes.ApplyRetags]: {
    type: JobTypes.ApplyRetags,
    name: "Apply Retags",
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
    taskName: JobTypes.RescanFolders,
    category: "monitoring",
    riskLevel: "medium",
    visibleInSystemTasks: true,
    run: () => queueMonitoringCyclePass({ trigger: 1, includeRootScan: true }),
  },
  {
    id: "housekeeping",
    kind: "scheduled",
    commandName: "Housekeeping",
    name: "Housekeeping",
    description: "Clean stale runtime state and library housekeeping records.",
    taskName: JobTypes.Housekeeping,
    category: "maintenance",
    riskLevel: "medium",
    visibleInSystemTasks: true,
    run: () => queueHousekeepingPass({ trigger: 1 }),
  },
  {
    id: "refresh-metadata",
    kind: "manual",
    commandName: "RefreshMetadata",
    name: "Refresh Metadata",
    description: "Queue metadata refresh work for managed artists.",
    taskName: JobTypes.RefreshMetadata,
    category: "metadata",
    riskLevel: "medium",
    visibleInSystemTasks: false,
    run: () => queueMetadataRefreshPass({ trigger: 1 }),
  },
  {
    id: "apply-curation",
    kind: "manual",
    commandName: "ApplyCuration",
    name: "Apply Curation",
    description: "Queue a full curation pass for managed artists.",
    taskName: JobTypes.ApplyCuration,
    category: "library",
    riskLevel: "medium",
    visibleInSystemTasks: false,
    run: () => queueCurationPass({ trigger: 1 }),
  },
  {
    id: "download-missing",
    kind: "manual",
    commandName: "DownloadMissing",
    name: "Download Missing",
    description: "Queue missing monitored items for download.",
    taskName: JobTypes.DownloadMissing,
    category: "downloads",
    riskLevel: "medium",
    visibleInSystemTasks: false,
    run: () => queueDownloadMissingPass({ trigger: 1 }),
  },
  {
    id: "check-upgrades",
    kind: "manual",
    commandName: "CheckUpgrades",
    name: "Check Upgrades",
    description: "Scan the library for monitored items that can be upgraded.",
    taskName: JobTypes.CheckUpgrades,
    category: "downloads",
    riskLevel: "medium",
    visibleInSystemTasks: false,
    run: () => queueCheckUpgradesPass({ trigger: 1 }),
  },
  {
    id: "rescan-folders",
    kind: "manual",
    commandName: "RescanFolders",
    name: "Rescan Folders",
    description: "Rescan configured library roots for known artist folders.",
    taskName: JobTypes.RescanFolders,
    category: "library",
    riskLevel: "medium",
    visibleInSystemTasks: false,
    run: () => queueRescanFoldersPass({ trigger: 1, fullProcessing: false }),
  },
  {
    id: "refresh-all-monitored",
    kind: "manual",
    commandName: "RefreshAllMonitored",
    name: "Refresh All Monitored Artists",
    description: "Queue a full refresh pass across all monitored artists.",
    taskName: JobTypes.RefreshAllMonitored,
    category: "metadata",
    riskLevel: "medium",
    visibleInSystemTasks: true,
    run: () => queueRefreshAllMonitored({ trigger: 1 }),
  },
  {
    id: "download-missing-force",
    kind: "manual",
    commandName: "DownloadMissingForce",
    name: "Download Missing (Force)",
    description: "Force a missing-download pass across monitored items.",
    taskName: JobTypes.DownloadMissingForce,
    category: "downloads",
    riskLevel: "medium",
    visibleInSystemTasks: true,
    run: () => queueDownloadMissingForce({ trigger: 1 }),
  },
  {
    id: "rescan-all-roots",
    kind: "manual",
    commandName: "RescanAllRoots",
    name: "Rescan All Roots",
    description: "Scan all configured library roots for new artist folders and unmanaged changes.",
    taskName: JobTypes.RescanAllRoots,
    category: "library",
    riskLevel: "high",
    visibleInSystemTasks: true,
    run: () => queueRescanAllRoots({ trigger: 1 }),
  },
  {
    id: "health-check",
    kind: "manual",
    commandName: "HealthCheck",
    name: "Health Check",
    description: "Run health diagnostics across runtime paths, tools, and downloader capability checks.",
    taskName: JobTypes.HealthCheck,
    category: "maintenance",
    riskLevel: "low",
    visibleInSystemTasks: true,
    run: () => queueHealthCheck({ trigger: 1 }),
  },
  {
    id: "compact-database",
    kind: "manual",
    commandName: "CompactDatabase",
    name: "Compact Database",
    description: "Run SQLite compaction and cleanup maintenance.",
    taskName: JobTypes.CompactDatabase,
    category: "maintenance",
    riskLevel: "high",
    visibleInSystemTasks: true,
    run: () => queueCompactDatabase({ trigger: 1 }),
  },
  {
    id: "cleanup-temp-files",
    kind: "manual",
    commandName: "CleanupTempFiles",
    name: "Cleanup Temporary Files",
    description: "Delete stale temp files left behind by downloads and processing.",
    taskName: JobTypes.CleanupTempFiles,
    category: "maintenance",
    riskLevel: "medium",
    visibleInSystemTasks: true,
    run: () => queueCleanupTempFiles({ trigger: 1 }),
  },
  {
    id: "update-library-metadata",
    kind: "manual",
    commandName: "UpdateLibraryMetadata",
    name: "Update Library Metadata",
    description: "Queue metadata refresh work for the indexed local library surface.",
    taskName: JobTypes.UpdateLibraryMetadata,
    category: "metadata",
    riskLevel: "medium",
    visibleInSystemTasks: true,
    run: () => queueUpdateLibraryMetadata({ trigger: 1 }),
  },
  {
    id: "config-prune",
    kind: "manual",
    commandName: "ConfigPrune",
    name: "Prune Configuration",
    description: "Remove stale config-driven queue and metadata references.",
    taskName: JobTypes.ConfigPrune,
    category: "maintenance",
    riskLevel: "high",
    visibleInSystemTasks: true,
    run: () => queueConfigPrune({ trigger: 1 }),
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
    type: jobType as JobType,
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

export function getCommandTypesForQueueCategory(category: CommandQueueCategory): JobType[] {
  if (category === "downloads") {
    return [...COMMAND_QUEUE_CATEGORY_TYPES.downloads];
  }

  if (category === "scans") {
    return [...COMMAND_QUEUE_CATEGORY_TYPES.scans];
  }

  const excluded = new Set<JobType>([
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
