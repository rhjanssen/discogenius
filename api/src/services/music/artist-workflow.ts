import { CommandTrigger } from "../commands/command-trigger.js";
import {ARTIST_WORKFLOW_COMMAND_NAMES, CommandNames} from "../commands/command-names.js";
import {CommandQueueManager} from "../commands/command-queue-manager.js";
import type { RescanFoldersCommand } from "../commands/command-bodies.js";
import { getConfigSection } from "../config/config.js";
import { getManagedArtists } from "./managed-artists.js";

export type ArtistWorkflow =
  | "metadata-refresh"
  | "refresh-scan"
  | "library-scan"
  | "curation"
  | "monitoring-intake"
  | "full-monitoring";

export type ArtistWorkflowEntryJobType =
  | typeof CommandNames.RefreshArtist
  | typeof CommandNames.RescanFolders
  | typeof CommandNames.CurateArtist;

/**
 * Workflow tiers leave enough room for every monitored handoff to run
 * depth-first before first-degree credited-artist metadata backfill begins.
 */
export const ARTIST_WORKFLOW_PRIORITY = {
  MONITORED_BATCH_BASE: -1,
  CREDITED_ARTIST_BASE: -10,
} as const;

export const CREDITED_ARTIST_HYDRATION_BATCH_SIZE = 25;

export interface CreditedArtistHydrationItem {
  artistId: string;
  artistName: string;
}

/**
 * Queue one bounded first-degree collaborator batch. Any remainder is persisted
 * on the last queued command and handed to the next batch only after that
 * artist's provider match succeeds.
 */
export function queueCreditedArtistHydrationBatch(
  items: readonly CreditedArtistHydrationItem[],
): { queued: number; remaining: number } {
  const unique = [...new Map(
    items
      .filter((item) => item.artistId)
      .map((item) => [item.artistId, item]),
  ).values()];
  const queuedCommandIds: number[] = [];
  let cursor = 0;
  while (cursor < unique.length && queuedCommandIds.length < CREDITED_ARTIST_HYDRATION_BATCH_SIZE) {
    const item = unique[cursor++];
    const commandId = queueArtistWorkflow({
      artistId: item.artistId,
      artistName: item.artistName,
      workflow: "metadata-refresh",
      priority: ARTIST_WORKFLOW_PRIORITY.CREDITED_ARTIST_BASE,
    });
    if (commandId !== -1) queuedCommandIds.push(commandId);
  }
  const continuation = unique.slice(cursor);
  const lastCommandId = queuedCommandIds.at(-1);
  if (lastCommandId != null && continuation.length > 0) {
    CommandQueueManager.updateState(lastCommandId, {
      payloadPatch: { creditedContinuation: continuation },
    });
  }
  return { queued: queuedCommandIds.length, remaining: continuation.length };
}

export function nextArtistWorkflowPriority(priority?: number | null): number {
  const normalized = Number(priority);
  return Number.isFinite(normalized) ? normalized + 1 : 1;
}

export interface ManagedArtistWorkflowProgress {
  processed: number;
  total: number;
  queued: number;
  artistId?: string;
  artistName?: string;
  queuedJob: boolean;
}

type WorkflowPhases = {
  monitorArtist: boolean;
  refreshMetadata: boolean;
  scanLibrary: boolean;
  backfillMetadata: boolean;
  curate: boolean;
  queueDownloads: boolean;
};

const WORKFLOW_PHASES: Record<ArtistWorkflow, WorkflowPhases> = {
  "metadata-refresh": {
    monitorArtist: false,
    refreshMetadata: true,
    scanLibrary: false,
    backfillMetadata: false,
    curate: false,
    queueDownloads: false,
  },
  "refresh-scan": {
    monitorArtist: false,
    refreshMetadata: true,
    scanLibrary: true,
    backfillMetadata: false,
    curate: false,
    queueDownloads: false,
  },
  "library-scan": {
    monitorArtist: false,
    refreshMetadata: false,
    scanLibrary: true,
    backfillMetadata: false,
    curate: false,
    queueDownloads: false,
  },
  curation: {
    monitorArtist: false,
    refreshMetadata: false,
    scanLibrary: false,
    backfillMetadata: false,
    curate: true,
    queueDownloads: false,
  },
  // Lidarr SearchForMissingAlbums after add+scan: monitored intake ends by
  // queueing DownloadMissing for that artist (see handleCurateArtist).
  "monitoring-intake": {
    monitorArtist: true,
    refreshMetadata: true,
    scanLibrary: true,
    backfillMetadata: true,
    curate: true,
    queueDownloads: true,
  },
  "full-monitoring": {
    monitorArtist: true,
    refreshMetadata: true,
    scanLibrary: true,
    backfillMetadata: true,
    curate: true,
    queueDownloads: true,
  },
};

export function isArtistWorkflow(value: unknown): value is ArtistWorkflow {
  return typeof value === "string" && value in WORKFLOW_PHASES;
}

/**
 * Phases for a workflow, validated.
 *
 * Command payloads are persisted JSON, so a stale, hand-queued or
 * partially-migrated row can carry a workflow this build does not know. Returning
 * `undefined` for that case surfaced three frames later as
 * "Cannot read properties of undefined (reading 'scanLibrary')", which names
 * neither the command nor the bad value. Fail here, where both are in hand.
 */
export function getArtistWorkflowPhases(workflow: ArtistWorkflow): WorkflowPhases {
  const phases = WORKFLOW_PHASES[workflow];
  if (!phases) {
    throw new Error(
      `Unknown artist workflow ${JSON.stringify(workflow)}; expected one of ${Object.keys(WORKFLOW_PHASES).join(", ")}`,
    );
  }
  return phases;
}

/**
 * Whether this workflow will queue a CurateArtist command of its own after
 * provider matching finishes.
 *
 * MatchArtistProviders used to curate the whole artist inline *and* be followed
 * by CurateArtist, so every monitored workflow curated twice — and on a
 * prolific artist the redundant second pass is what ran past the command lease
 * and poison-failed. It can only safely skip the inline pass when a real
 * CurateArtist is guaranteed to follow, and that guarantee is exactly this
 * table: the ARTIST_REFRESH_COMPLETE listener only chains at all when
 * `scanLibrary` is set, and only reaches curation when `curate` is.
 *
 * Unknown or absent workflows answer false, so an unrecognised payload curates
 * inline rather than silently not curating at all.
 */
export function workflowQueuesCuration(workflow: unknown): boolean {
  if (!isArtistWorkflow(workflow)) return false;
  const phases = getArtistWorkflowPhases(workflow);
  return phases.scanLibrary && phases.curate;
}

export function buildRefreshArtistCommand(params: {
  artistId: string;
  artistName: string;
  workflow: ArtistWorkflow;
  forceUpdate?: boolean;
  monitoringCycle?: RescanFoldersCommand["monitoringCycle"];
}) {
  const phases = getArtistWorkflowPhases(params.workflow);
  const hydrateCatalog = phases.refreshMetadata;
  const hydrateAlbumTracks = phases.curate || phases.backfillMetadata || phases.queueDownloads;
  return {
    artistId: params.artistId,
    artistName: params.artistName,
    workflow: params.workflow,
    monitorArtist: phases.monitorArtist,
    monitorAlbums: hydrateAlbumTracks,
    hydrateCatalog,
    hydrateAlbumTracks,
    scanLibrary: phases.scanLibrary,
    forceDownloadQueue: phases.queueDownloads,
    forceUpdate: Boolean(params.forceUpdate),
    monitoringCycle: params.monitoringCycle,
  };
}

export function buildMatchArtistProvidersCommand(params: {
  artistId: string;
  artistName: string;
  artistMbid: string | null;
  shouldHydrateCatalog: boolean;
  metadataChanged: boolean;
  isNewArtist: boolean;
  workflow: ArtistWorkflow;
  forceUpdate?: boolean;
  monitoringCycle?: RescanFoldersCommand["monitoringCycle"];
  creditedContinuation?: CreditedArtistHydrationItem[];
}) {
  const phases = getArtistWorkflowPhases(params.workflow);
  return {
    artistId: params.artistId,
    artistName: params.artistName,
    artistMbid: params.artistMbid,
    shouldHydrateCatalog: params.shouldHydrateCatalog,
    metadataChanged: params.metadataChanged,
    isNewArtist: params.isNewArtist,
    workflow: params.workflow,
    scanLibrary: phases.scanLibrary,
    forceDownloadQueue: phases.queueDownloads,
    forceUpdate: Boolean(params.forceUpdate),
    monitoringCycle: params.monitoringCycle,
    creditedContinuation: params.creditedContinuation,
  };
}

export function getArtistWorkflowEntryJobType(workflow: ArtistWorkflow): ArtistWorkflowEntryJobType {
  switch (workflow) {
    case "metadata-refresh":
    case "refresh-scan":
    case "monitoring-intake":
    case "full-monitoring":
      return CommandNames.RefreshArtist;
    case "library-scan":
      return CommandNames.RescanFolders;
    case "curation":
      return CommandNames.CurateArtist;
  }
}

export function buildArtistWorkflowEntryJob(params: {
  artistId: string;
  artistName: string;
  workflow: ArtistWorkflow;
  forceUpdate?: boolean;
  monitoringCycle?: RescanFoldersCommand["monitoringCycle"];
}) {
  switch (params.workflow) {
    case "metadata-refresh":
    case "refresh-scan":
    case "monitoring-intake":
    case "full-monitoring":
      return {
        type: CommandNames.RefreshArtist,
        payload: buildRefreshArtistCommand({
          artistId: params.artistId,
          artistName: params.artistName,
          workflow: params.workflow,
          forceUpdate: params.forceUpdate,
          monitoringCycle: params.monitoringCycle,
        }),
      };
    case "library-scan":
      return {
        type: CommandNames.RescanFolders,
        payload: buildRescanFoldersCommand({
          artistId: params.artistId,
          artistName: params.artistName,
          workflow: params.workflow,
        }),
      };
    case "curation":
      return {
        type: CommandNames.CurateArtist,
        payload: buildCurateArtistCommand({
          artistId: params.artistId,
          artistName: params.artistName,
          workflow: params.workflow,
        }),
      };
  }
}

export function queueArtistWorkflow(params: {
  artistId: string;
  artistName: string;
  workflow: ArtistWorkflow;
  forceUpdate?: boolean;
  monitoringCycle?: RescanFoldersCommand["monitoringCycle"];
  priority?: number;
  trigger?: number;
}) {
  const { type, payload } = buildArtistWorkflowEntryJob(params);
  return CommandQueueManager.push(
    type,
    payload,
    params.artistId,
    params.priority ?? 0,
    params.trigger ?? CommandTrigger.Unspecified,
  );
}

export function queueArtistIntake(params: {
  artistId: string;
  artistName: string;
  monitored: boolean;
  forceUpdate?: boolean;
  monitoringCycle?: RescanFoldersCommand["monitoringCycle"];
  priority?: number;
  trigger?: number;
}) {
  return queueArtistWorkflow({
    artistId: params.artistId,
    artistName: params.artistName,
    workflow: params.monitored ? "monitoring-intake" : "metadata-refresh",
    forceUpdate: params.forceUpdate,
    monitoringCycle: params.monitoringCycle,
    priority: params.priority,
    trigger: params.trigger,
  });
}

export function queueLibraryRescan(options: {
  trigger?: number;
  priority?: number;
  monitorArtist?: boolean;
  fullProcessing?: boolean;
  artistIds?: string[];
  addNewArtists?: boolean;
} = {}) {
  return CommandQueueManager.push(
    CommandNames.RescanFolders,
    {
      addNewArtists: options.addNewArtists ?? false,
      artistIds: options.artistIds,
      monitorArtist: options.monitorArtist ?? getConfigSection("monitoring").monitor_new_artists,
      fullProcessing: options.fullProcessing ?? false,
    } satisfies Partial<RescanFoldersCommand>,
    "rescan-folders",
    options.priority ?? 0,
    options.trigger ?? CommandTrigger.Unspecified,
  );
}

export function queueManagedArtistsWorkflow(
  workflow: Extract<ArtistWorkflow, "metadata-refresh" | "curation" | "full-monitoring">,
  options: {
    trigger?: number;
    priority?: number;
    includeRootScan?: boolean;
    artistIds?: string[];
    onProgress?: (event: ManagedArtistWorkflowProgress) => void;
  } = {},
): { queued: number; artists: number; libraryRescanQueued: boolean } {
  const artists = getManagedArtists({ orderByLastScanned: true, artistIds: options.artistIds });
  const trigger = options.trigger ?? CommandTrigger.Unspecified;
  const priority = options.priority ?? 0;

  let libraryRescanQueued = false;
  if (options.includeRootScan) {
    const libraryRescanJobId = queueLibraryRescan({
      trigger,
      priority,
      monitorArtist: true,
      fullProcessing: workflow === "full-monitoring",
      artistIds: options.artistIds,
    });
    libraryRescanQueued = libraryRescanJobId !== -1;
  }

  let queued = 0;
  options.onProgress?.({
    processed: 0,
    total: artists.length,
    queued,
    queuedJob: false,
  });

  for (let index = 0; index < artists.length; index += 1) {
    const artist = artists[index];
    const commandId = queueArtistWorkflow({
      artistId: String(artist.id),
      artistName: artist.name,
      workflow,
      priority,
      trigger,
    });

    if (commandId !== -1) {
      queued += 1;
    }

    options.onProgress?.({
      processed: index + 1,
      total: artists.length,
      queued,
      artistId: String(artist.id),
      artistName: artist.name,
      queuedJob: commandId !== -1,
    });
  }

  return {
    queued,
    artists: artists.length,
    libraryRescanQueued,
  };
}

export function buildRescanFoldersCommand(params: {
  artistId: string;
  artistName: string;
  workflow: Extract<ArtistWorkflow, "refresh-scan" | "library-scan" | "monitoring-intake" | "full-monitoring">;
  monitoringCycle?: RescanFoldersCommand["monitoringCycle"];
}) {
  const phases = getArtistWorkflowPhases(params.workflow);
  return {
    artistId: params.artistId,
    artistName: params.artistName,
    workflow: params.workflow,
    skipDownloadQueue: !phases.queueDownloads,
    skipCuration: !phases.curate,
    skipMetadataBackfill: !phases.backfillMetadata,
    forceDownloadQueue: phases.queueDownloads,
    monitoringCycle: params.monitoringCycle,
  };
}

export function buildCurateArtistCommand(params: {
  artistId: string;
  artistName: string;
  workflow: Extract<ArtistWorkflow, "curation" | "monitoring-intake" | "full-monitoring">;
  monitoringCycle?: RescanFoldersCommand["monitoringCycle"];
}) {
  const phases = getArtistWorkflowPhases(params.workflow);
  return {
    artistId: params.artistId,
    artistName: params.artistName,
    workflow: params.workflow,
    skipDownloadQueue: !phases.queueDownloads,
    forceDownloadQueue: phases.queueDownloads,
    monitoringCycle: params.monitoringCycle,
  };
}

export function getRedundancyOptionsForWorkflow(
  workflow: Extract<ArtistWorkflow, "curation" | "monitoring-intake" | "full-monitoring">,
) {
  const phases = getArtistWorkflowPhases(workflow);
  return {
    skipDownloadQueue: !phases.queueDownloads,
    forceDownloadQueue: phases.queueDownloads,
  };
}

export function getArtistWorkflowLabel(workflow: unknown): string | null {
  switch (workflow) {
    case "metadata-refresh":
      return "Metadata refresh";
    case "refresh-scan":
      return "Library refresh";
    case "library-scan":
      return "Library scan";
    case "curation":
      return "Curation";
    case "monitoring-intake":
      return "Monitoring";
    case "full-monitoring":
      return "Monitoring";
    default:
      return null;
  }
}
