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
  Spinner,
  Text,
} from "@fluentui/react-components";
import {
  Tag24Regular,
  Rename24Regular,
  Tag24Filled,
  Rename24Filled,
  bundleIcon,
} from "@fluentui/react-icons";
import { api } from "@/services/api";
import { useToast } from "@/hooks/useToast";
import {
  RenamePreviewDialog,
  type RenamePreviewItem,
  RetagPreviewDialog,
  type RetagPreviewItem,
} from "@/components/mediafiles/FileMaintenanceDialogs";

const Rename24 = bundleIcon(Rename24Filled, Rename24Regular);
const Tag24 = bundleIcon(Tag24Filled, Tag24Regular);

export type LibraryFileMaintenanceScope = {
  artistIds?: string[];
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

function uniqueIds(values: Array<string | number | null | undefined> | undefined): string[] {
  if (!values?.length) return [];
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))];
}

export function useLibraryFileMaintenance(): LibraryFileMaintenanceApi {
  const { toast } = useToast();
  const pendingScopeRef = useRef<LibraryFileMaintenanceScope>({});

  const [renamePreviewOpen, setRenamePreviewOpen] = useState(false);
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

    pendingScopeRef.current = { artistIds, albumIds };
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

    pendingScopeRef.current = { artistIds, albumIds };
    if (albumIds.length === 0) {
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

    setRetagApplying(true);
    try {
      const result: any = await api.applyRetags({ applyAll: true, artistIds });
      toast({
        title: "Write Tags queued",
        description: result?.message || `Queued tag writing for ${artistIds.length} selected artist${artistIds.length === 1 ? "" : "s"}.`,
      });
      setRetagBulkOpen(false);
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
      <Dialog open={retagBulkOpen} onOpenChange={(_, data) => setRetagBulkOpen(data.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Write Tags for selected artists?</DialogTitle>
            <DialogContent>
              <Text>
                Discogenius will check every audio file owned by the {pendingScopeRef.current.artistIds?.length ?? 0} selected artist{pendingScopeRef.current.artistIds?.length === 1 ? "" : "s"} and update only tags that differ from the catalog and library edition. Use an artist or album page when you want a file-by-file preview first.
              </Text>
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
