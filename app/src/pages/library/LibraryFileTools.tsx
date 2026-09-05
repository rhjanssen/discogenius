/**
 * Selection-scoped rename and tag-writing tools for the Library.
 * Settings keeps naming templates and tag-writing policy; actions live on Library selection bars.
 */
import { useCallback, useRef, useState, type ReactElement, type ReactNode } from "react";
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Spinner,
  Text,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import {
  Tag24Regular,
  Rename24Regular,
  Tag24Filled,
  Rename24Filled,
  Dismiss24Regular,
  Dismiss24Filled,
  Person16Regular,
  bundleIcon,
} from "@fluentui/react-icons";
import { api } from "@/services/api";
import { useToast } from "@/hooks/useToast";
import { dispatchActivityRefresh, dispatchLibraryUpdated } from "@/utils/appEvents";
import {
  RenamePreviewDialog,
  type RenamePreviewItem,
  RetagPreviewDialog,
  type RetagPreviewItem,
} from "@/components/mediafiles/FileMaintenanceDialogs";

const Rename24 = bundleIcon(Rename24Filled, Rename24Regular);
const Tag24 = bundleIcon(Tag24Filled, Tag24Regular);
const Dismiss24 = bundleIcon(Dismiss24Filled, Dismiss24Regular);

export type LibraryFileMaintenanceScope = {
  artistIds?: string[];
  artistNames?: string[];
  albumIds?: string[];
};

export type LibraryFileMaintenanceApi = {
  busy: boolean;
  renameLoading: boolean;
  retagLoading: boolean;
  openRenamePreview: (scope: LibraryFileMaintenanceScope) => void;
  openRetagPreview: (scope: LibraryFileMaintenanceScope) => void;
  renameIcon: ReactNode;
  retagIcon: ReactNode;
  dialogs: ReactElement;
};

const useStyles = makeStyles({
  bulkDialog: {
    maxWidth: "520px",
    width: "100%",
  },
  dialogContent: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalM,
  },
  artistList: {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    maxHeight: "180px",
    overflowY: "auto",
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  artistItem: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground1,
  },
  artistIcon: {
    color: tokens.colorNeutralForeground3,
    flexShrink: 0,
  },
  artistName: {
    overflowWrap: "anywhere",
    minWidth: 0,
  },
  moreArtistsText: {
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground3,
    fontStyle: "italic",
    paddingTop: "2px",
  },
});

function uniqueIds(values: Array<string | number | null | undefined> | undefined): string[] {
  if (!values?.length) return [];
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))];
}

export function useLibraryFileMaintenance(): LibraryFileMaintenanceApi {
  const styles = useStyles();
  const { toast } = useToast();
  const pendingScopeRef = useRef<LibraryFileMaintenanceScope>({});

  const [renamePreviewOpen, setRenamePreviewOpen] = useState(false);
  const [renameBulkOpen, setRenameBulkOpen] = useState(false);
  const [renamePreviewItems, setRenamePreviewItems] = useState<RenamePreviewItem[]>([]);
  const [renameApplying, setRenameApplying] = useState(false);
  const [renameLoading, setRenameLoading] = useState(false);

  const [retagPreviewOpen, setRetagPreviewOpen] = useState(false);
  const [retagBulkOpen, setRetagBulkOpen] = useState(false);
  const [retagPreviewItems, setRetagPreviewItems] = useState<RetagPreviewItem[]>([]);
  const [retagApplying, setRetagApplying] = useState(false);
  const [retagLoading, setRetagLoading] = useState(false);

  const openRenamePreview = useCallback(async (scope: LibraryFileMaintenanceScope) => {
    const artistIds = uniqueIds(scope.artistIds);
    const albumIds = uniqueIds(scope.albumIds);
    if (artistIds.length === 0 && albumIds.length === 0) {
      toast({
        title: "Nothing selected",
        description: "Select one or more items before previewing renames.",
        variant: "destructive",
      });
      return;
    }

    pendingScopeRef.current = { artistIds, albumIds, artistNames: scope.artistNames };
    if (albumIds.length === 0 && artistIds.length > 1) {
      // Lidarr deliberately confirms a bulk artist rename without reading every
      // file into an enormous preview. Precise previews remain available from
      // an artist or album page.
      setRenameBulkOpen(true);
      return;
    }

    setRenameLoading(true);
    try {
      const chunks: RenamePreviewItem[] = [];
      if (albumIds.length > 0) {
        for (const albumId of albumIds) {
          const response = await api.getLibraryRenamePreview({ albumId, limit: 1000 }) as { items?: RenamePreviewItem[] };
          chunks.push(...(response.items || []));
        }
      } else {
        for (const artistId of artistIds) {
          const response = await api.getLibraryRenamePreview({ artistId, limit: 1000 }) as { items?: RenamePreviewItem[] };
          chunks.push(...(response.items || []));
        }
      }

      const seen = new Set<number>();
      const items = chunks.filter((item) => {
        const id = Number(item.id);
        if (!Number.isFinite(id) || seen.has(id)) return false;
        seen.add(id);
        return Boolean(item.missing || item.conflict || item.needs_rename || item.drop_duplicate);
      });
      setRenamePreviewItems(items);
      setRenamePreviewOpen(true);
    } catch (error) {
      toast({
        title: "Rename preview failed",
        description: error instanceof Error ? error.message : "Could not load the rename preview.",
        variant: "destructive",
      });
    } finally {
      setRenameLoading(false);
    }
  }, [toast]);

  const handleApplyRenames = useCallback(async (ids?: number[]) => {
    setRenameApplying(true);
    try {
      if (ids?.length) {
        const result: any = await api.applyLibraryRenames({ ids });
        toast({
          title: "Rename queued",
          description: result?.message || `Queued rename for ${ids.length} file(s).`,
        });
      } else {
        const { artistIds = [], albumIds = [] } = pendingScopeRef.current;
        let queued = 0;
        if (albumIds.length > 0) {
          for (const albumId of albumIds) {
            await api.applyLibraryRenames({ applyAll: true, albumId });
            queued += 1;
          }
        } else {
          for (const artistId of artistIds) {
            await api.applyLibraryRenames({ applyAll: true, artistId });
            queued += 1;
          }
        }
        toast({
          title: "Rename queued",
          description: `Queued rename for ${queued} selected scope${queued === 1 ? "" : "s"}.`,
        });
      }
      setRenamePreviewOpen(false);
      dispatchActivityRefresh();
      dispatchLibraryUpdated();
    } catch (error) {
      toast({
        title: "Failed to queue rename",
        description: error instanceof Error ? error.message : "Could not queue rename.",
        variant: "destructive",
      });
    } finally {
      setRenameApplying(false);
    }
  }, [toast]);

  const handleApplyBulkRenames = useCallback(async () => {
    const artistIds = uniqueIds(pendingScopeRef.current.artistIds);
    if (artistIds.length === 0) return;

    setRenameBulkOpen(false);
    setRenameApplying(true);
    try {
      const result: any = await api.applyLibraryRenames({ applyAll: true, artistIds });
      toast({
        title: "Rename queued",
        description: result?.message || `Queued rename for ${artistIds.length} selected artist${artistIds.length === 1 ? "" : "s"}.`,
      });
      dispatchActivityRefresh();
      dispatchLibraryUpdated();
    } catch (error) {
      toast({
        title: "Failed to queue rename",
        description: error instanceof Error ? error.message : "Could not queue rename.",
        variant: "destructive",
      });
    } finally {
      setRenameApplying(false);
    }
  }, [toast]);

  const openRetagPreview = useCallback(async (scope: LibraryFileMaintenanceScope) => {
    const artistIds = uniqueIds(scope.artistIds);
    const albumIds = uniqueIds(scope.albumIds);
    if (artistIds.length === 0 && albumIds.length === 0) {
      toast({
        title: "Nothing selected",
        description: "Select one or more items before previewing tags.",
        variant: "destructive",
      });
      return;
    }

    pendingScopeRef.current = { artistIds, albumIds, artistNames: scope.artistNames };
    if (albumIds.length === 0 && artistIds.length > 1) {
      // Lidarr deliberately confirms a bulk artist retag without reading every
      // file into an enormous preview. Precise previews remain available from
      // an artist or album page.
      setRetagBulkOpen(true);
      return;
    }

    setRetagLoading(true);
    try {
      const chunks: RetagPreviewItem[] = [];
      if (albumIds.length > 0) {
        for (const albumId of albumIds) {
          const response = await api.getRetagPreview({ albumId, limit: 1000 }) as { items?: RetagPreviewItem[] };
          chunks.push(...(response.items || []));
        }
      } else {
        for (const artistId of artistIds) {
          const response = await api.getRetagPreview({ artistId, limit: 1000 }) as { items?: RetagPreviewItem[] };
          chunks.push(...(response.items || []));
        }
      }

      const seen = new Set<number>();
      const items = chunks.filter((item) => {
        const id = Number(item.id);
        if (!Number.isFinite(id) || seen.has(id)) return false;
        seen.add(id);
        return true;
      });
      setRetagPreviewItems(items);
      setRetagPreviewOpen(true);
    } catch (error) {
      toast({
        title: "Retag preview failed",
        description: error instanceof Error ? error.message : "Could not load the retag preview.",
        variant: "destructive",
      });
    } finally {
      setRetagLoading(false);
    }
  }, [toast]);

  const handleApplyBulkRetags = useCallback(async () => {
    const artistIds = uniqueIds(pendingScopeRef.current.artistIds);
    if (artistIds.length === 0) return;

    setRetagBulkOpen(false);
    setRetagApplying(true);
    try {
      const result: any = await api.applyRetags({ applyAll: true, artistIds });
      toast({
        title: "Write Tags queued",
        description: result?.message || `Queued tag writing for ${artistIds.length} selected artist${artistIds.length === 1 ? "" : "s"}.`,
      });
      dispatchActivityRefresh();
      dispatchLibraryUpdated();
    } catch (error) {
      toast({
        title: "Failed to queue tag writing",
        description: error instanceof Error ? error.message : "Could not queue tag writing.",
        variant: "destructive",
      });
    } finally {
      setRetagApplying(false);
    }
  }, [toast]);

  const handleApplyRetags = useCallback(async (ids?: number[]) => {
    if (!ids?.length) return;
    setRetagApplying(true);
    try {
      const result: any = await api.applyRetags({ ids });
      toast({
        title: "Write Tags queued",
        description: result?.message || `Queued tag writing for ${ids.length} file(s).`,
      });
      setRetagPreviewOpen(false);
      dispatchActivityRefresh();
      dispatchLibraryUpdated();
    } catch (error) {
      toast({
        title: "Failed to queue tag writing",
        description: error instanceof Error ? error.message : "Could not queue tag writing.",
        variant: "destructive",
      });
    } finally {
      setRetagApplying(false);
    }
  }, [toast]);

  const busy = renameLoading || renameApplying || retagLoading || retagApplying;
  const artistCount = pendingScopeRef.current.artistIds?.length ?? 0;
  const artistNames = pendingScopeRef.current.artistNames ?? [];

  const dialogs = (
    <>
      <RenamePreviewDialog
        open={renamePreviewOpen}
        items={renamePreviewItems}
        applying={renameApplying}
        title="Preview Rename (selected)"
        onOpenChange={setRenamePreviewOpen}
        onApply={handleApplyRenames}
      />
      <RetagPreviewDialog
        open={retagPreviewOpen}
        items={retagPreviewItems}
        applying={retagApplying}
        title="Write Tags (selected)"
        onOpenChange={setRetagPreviewOpen}
        onApply={handleApplyRetags}
      />

      {/* Bulk Rename modal (Lidarr OrganizeSelectedArtists parity) */}
      <Dialog open={renameBulkOpen} onOpenChange={(_, data) => setRenameBulkOpen(data.open)}>
        <DialogSurface className={styles.bulkDialog}>
          <DialogBody>
            <DialogTitle
              action={
                <Button
                  appearance="subtle"
                  aria-label="Close organize dialog"
                  icon={<Dismiss24 />}
                  onClick={() => setRenameBulkOpen(false)}
                />
              }
            >
              Organize Selected Artists
            </DialogTitle>
            <DialogContent className={styles.dialogContent}>
              <MessageBar intent="info" layout="multiline">
                <MessageBarBody>
                  <MessageBarTitle>Tip:</MessageBarTitle>
                  To preview a rename before applying, select &quot;Cancel&quot;, then select any artist name and use the Organize icon.
                </MessageBarBody>
              </MessageBar>
              <Text weight="semibold">
                Are you sure you want to organize all files in the {artistCount} selected artist{artistCount === 1 ? "" : "s"}?
              </Text>
              {artistNames.length > 0 && (
                <div className={styles.artistList}>
                  {artistNames.slice(0, 50).map((name, i) => (
                    <div className={styles.artistItem} key={`${name}-${i}`}>
                      <Person16Regular className={styles.artistIcon} />
                      <span className={styles.artistName}>{name}</span>
                    </div>
                  ))}
                  {artistNames.length > 50 && (
                    <span className={styles.moreArtistsText}>
                      + {artistNames.length - 50} more artists
                    </span>
                  )}
                </div>
              )}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setRenameBulkOpen(false)}>Cancel</Button>
              <Button
                appearance="primary"
                icon={renameApplying ? <Spinner size="tiny" /> : <Rename24 />}
                disabled={renameApplying}
                onClick={() => void handleApplyBulkRenames()}
              >
                Organize
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Bulk Retag modal (Lidarr RetagSelectedArtists parity) */}
      <Dialog open={retagBulkOpen} onOpenChange={(_, data) => setRetagBulkOpen(data.open)}>
        <DialogSurface className={styles.bulkDialog}>
          <DialogBody>
            <DialogTitle
              action={
                <Button
                  appearance="subtle"
                  aria-label="Close retag dialog"
                  icon={<Dismiss24 />}
                  onClick={() => setRetagBulkOpen(false)}
                />
              }
            >
              Retag Selected Artists
            </DialogTitle>
            <DialogContent className={styles.dialogContent}>
              <MessageBar intent="info" layout="multiline">
                <MessageBarBody>
                  <MessageBarTitle>Tip:</MessageBarTitle>
                  To preview the tags that will be written, select &quot;Cancel&quot;, then select any artist name and use the Write Tags icon.
                </MessageBarBody>
              </MessageBar>
              <Text weight="semibold">
                Are you sure you want to retag all files in the {artistCount} selected artist{artistCount === 1 ? "" : "s"}?
              </Text>
              {artistNames.length > 0 && (
                <div className={styles.artistList}>
                  {artistNames.slice(0, 50).map((name, i) => (
                    <div className={styles.artistItem} key={`${name}-${i}`}>
                      <Person16Regular className={styles.artistIcon} />
                      <span className={styles.artistName}>{name}</span>
                    </div>
                  ))}
                  {artistNames.length > 50 && (
                    <span className={styles.moreArtistsText}>
                      + {artistNames.length - 50} more artists
                    </span>
                  )}
                </div>
              )}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setRetagBulkOpen(false)}>Cancel</Button>
              <Button
                appearance="primary"
                icon={retagApplying ? <Spinner size="tiny" /> : <Tag24 />}
                disabled={retagApplying}
                onClick={() => void handleApplyBulkRetags()}
              >
                Write Tags
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </>
  );

  return {
    busy,
    renameLoading,
    retagLoading,
    openRenamePreview: (scope) => void openRenamePreview(scope),
    openRetagPreview: (scope) => void openRetagPreview(scope),
    renameIcon: renameLoading ? <Spinner size="tiny" /> : <Rename24 />,
    retagIcon: retagLoading ? <Spinner size="tiny" /> : <Tag24 />,
    dialogs,
  };
}
