import type { OverflowAction } from "@/components/overflow/ActionOverflowMenu";

export type ArtistOverflowActionState = {
  isMonitored: boolean;
  isScanBusy: boolean;
  isCurateBusy: boolean;
  hasAlbums: boolean;
  downloadActionDisabled: boolean;
  renameApplying: boolean;
  retagApplying: boolean;
  stripTagsApplying: boolean;
  deleteFilesApplying: boolean;
};

export type ArtistOverflowActionHandlers = {
  syncArtist: () => void;
  curateArtist: () => void;
  startDownloads: () => void;
  openRenamePreview: () => void;
  openRetagPreview: () => void;
  openStripTags: () => void;
  openDeleteFiles: () => void;
};

/**
 * Actions that may move into the responsive overflow menu.
 *
 * Monitoring deliberately stays out of this list. Its high-priority button
 * remains visible and owns the policy menu, so the generic More menu cannot
 * expose a second, conflicting set of policy controls.
 */
export function buildArtistOverflowActions(
  state: ArtistOverflowActionState,
  handlers: ArtistOverflowActionHandlers,
): OverflowAction[] {
  return [
    {
      key: "refresh-scan",
      label: state.isScanBusy ? "Scanning..." : "Refresh & Scan",
      disabled: state.isScanBusy,
      onClick: handlers.syncArtist,
    },
    {
      key: "curate",
      label: state.isCurateBusy ? "Running..." : "Curate",
      disabled: !state.isMonitored || state.isCurateBusy || state.isScanBusy || !state.hasAlbums,
      onClick: handlers.curateArtist,
    },
    {
      key: "download-missing",
      label: "Download Missing",
      disabled: state.downloadActionDisabled,
      onClick: handlers.startDownloads,
    },
    {
      key: "rename-files",
      label: state.renameApplying ? "Loading rename..." : "Preview Rename",
      disabled: state.renameApplying,
      onClick: handlers.openRenamePreview,
    },
    {
      key: "retag-files",
      label: state.retagApplying ? "Loading tags..." : "Write Tags",
      disabled: state.retagApplying,
      onClick: handlers.openRetagPreview,
    },
    {
      key: "strip-tags",
      label: state.stripTagsApplying ? "Queueing..." : "Strip Tags...",
      disabled: state.stripTagsApplying,
      onClick: handlers.openStripTags,
    },
    {
      key: "delete-files",
      label: "Delete files...",
      disabled: state.deleteFilesApplying,
      onClick: handlers.openDeleteFiles,
    },
  ];
}
