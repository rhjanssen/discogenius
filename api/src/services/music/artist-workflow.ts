import { CommandTrigger } from "../commands/command-trigger.js";
import { ARTIST_WORKFLOW_COMMAND_NAMES, CommandNames, CommandQueueService } from "../commands/command-queue.js";
import type { RescanFoldersCommand } from "../commands/command-bodies.js";
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
  "monitoring-intake": {
    monitorArtist: true,
    refreshMetadata: true,
    scanLibrary: true,
    backfillMetadata: true,
    curate: true,
    queueDownloads: false,
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

export function getArtistWorkflowPhases(workflow: ArtistWorkflow): WorkflowPhases {
  return WORKFLOW_PHASES[workflow];
}

export function buildRefreshArtistCommand(params: {
  artistId: string;
  artistName: string;
  workflow: ArtistWorkflow;
  forceUpdate?: boolean;
  expandCreditedArtists?: boolean;
  scanDepth?: "basic" | "deep";
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
    includeSimilarArtists: false,
    seedSimilarArtists: false,
    forceDownloadQueue: phases.queueDownloads,
    forceUpdate: Boolean(params.forceUpdate),
    expandCreditedArtists: params.expandCreditedArtists === true,
    scanDepth: params.scanDepth ?? "deep",
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
  expandCreditedArtists?: boolean;
  scanDepth?: "basic" | "deep";
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
          expandCreditedArtists: params.expandCreditedArtists,
          scanDepth: params.scanDepth,
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
  expandCreditedArtists?: boolean;
  scanDepth?: "basic" | "deep";
  priority?: number;
  trigger?: number;
}) {
  const { type, payload } = buildArtistWorkflowEntryJob(params);
  return CommandQueueService.addJob(
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
  expandCreditedArtists?: boolean;
  scanDepth?: "basic" | "deep";
  priority?: number;
  trigger?: number;
}) {
  return queueArtistWorkflow({
    artistId: params.artistId,
    artistName: params.artistName,
    workflow: params.monitored ? "monitoring-intake" : "metadata-refresh",
    forceUpdate: params.forceUpdate,
    expandCreditedArtists: params.expandCreditedArtists === true,
    scanDepth: params.scanDepth,
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
  return CommandQueueService.addJob(
    CommandNames.RescanFolders,
    {
      addNewArtists: options.addNewArtists ?? false,
      artistIds: options.artistIds,
      monitorArtist: options.monitorArtist ?? true,
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
    const jobId = queueArtistWorkflow({
      artistId: String(artist.id),
      artistName: artist.name,
      workflow,
      priority,
      trigger,
    });

    if (jobId !== -1) {
      queued += 1;
    }

    options.onProgress?.({
      processed: index + 1,
      total: artists.length,
      queued,
      artistId: String(artist.id),
      artistName: artist.name,
      queuedJob: jobId !== -1,
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
