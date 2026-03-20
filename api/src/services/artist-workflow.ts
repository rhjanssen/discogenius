import { ARTIST_WORKFLOW_JOB_TYPES, JobTypes, TaskQueueService } from "./queue.js";
import type { RescanFoldersJobPayload } from "./job-payloads.js";
import { getManagedArtists } from "./managed-artists.js";

export type ArtistWorkflow =
  | "metadata-refresh"
  | "refresh-scan"
  | "library-scan"
  | "curation"
  | "monitoring-intake"
  | "full-monitoring";

export type ArtistWorkflowEntryJobType =
  | typeof JobTypes.RefreshArtist
  | typeof JobTypes.RescanFolders
  | typeof JobTypes.CurateArtist;

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

export function buildRefreshArtistJobPayload(params: {
  artistId: string;
  artistName: string;
  workflow: ArtistWorkflow;
  forceUpdate?: boolean;
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
  };
}

export function getArtistWorkflowEntryJobType(workflow: ArtistWorkflow): ArtistWorkflowEntryJobType {
  switch (workflow) {
    case "metadata-refresh":
    case "refresh-scan":
    case "monitoring-intake":
    case "full-monitoring":
      return JobTypes.RefreshArtist;
    case "library-scan":
      return JobTypes.RescanFolders;
    case "curation":
      return JobTypes.CurateArtist;
  }
}

export function buildArtistWorkflowEntryJob(params: {
  artistId: string;
  artistName: string;
  workflow: ArtistWorkflow;
  forceUpdate?: boolean;
}) {
  switch (params.workflow) {
    case "metadata-refresh":
    case "refresh-scan":
    case "monitoring-intake":
    case "full-monitoring":
      return {
        type: JobTypes.RefreshArtist,
        payload: buildRefreshArtistJobPayload({
          artistId: params.artistId,
          artistName: params.artistName,
          workflow: params.workflow,
          forceUpdate: params.forceUpdate,
        }),
      };
    case "library-scan":
      return {
        type: JobTypes.RescanFolders,
        payload: buildRescanFoldersJobPayload({
          artistId: params.artistId,
          artistName: params.artistName,
          workflow: params.workflow,
        }),
      };
    case "curation":
      return {
        type: JobTypes.CurateArtist,
        payload: buildCurateArtistJobPayload({
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
  priority?: number;
  trigger?: number;
}) {
  const { type, payload } = buildArtistWorkflowEntryJob(params);
  return TaskQueueService.addJob(
    type,
    payload,
    params.artistId,
    params.priority ?? 0,
    params.trigger ?? 0,
  );
}

export function queueLibraryRescan(options: {
  trigger?: number;
  priority?: number;
  monitorArtist?: boolean;
  fullProcessing?: boolean;
  artistIds?: string[];
} = {}) {
  return TaskQueueService.addJob(
    JobTypes.RescanFolders,
    {
      addNewArtists: true,
      artistIds: options.artistIds,
      monitorArtist: options.monitorArtist ?? true,
      fullProcessing: options.fullProcessing ?? false,
    } satisfies Partial<RescanFoldersJobPayload>,
    "rescan-folders",
    options.priority ?? 0,
    options.trigger ?? 0,
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
  const trigger = options.trigger ?? 0;
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

export function buildRescanFoldersJobPayload(params: {
  artistId: string;
  artistName: string;
  workflow: Extract<ArtistWorkflow, "refresh-scan" | "library-scan" | "monitoring-intake" | "full-monitoring">;
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
  };
}

export function buildCurateArtistJobPayload(params: {
  artistId: string;
  artistName: string;
  workflow: Extract<ArtistWorkflow, "curation" | "monitoring-intake" | "full-monitoring">;
}) {
  const phases = getArtistWorkflowPhases(params.workflow);
  return {
    artistId: params.artistId,
    artistName: params.artistName,
    workflow: params.workflow,
    skipDownloadQueue: !phases.queueDownloads,
    forceDownloadQueue: phases.queueDownloads,
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
