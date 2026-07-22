/**
 * Selection-scoped Preview Rename / Write Tags for library file tools.
 * Settings keeps naming templates and tag-writing policy; actions live on Library selection bars.
 */
import { useCallback, useRef, useState, type ReactElement, type ReactNode } from "react";
import { Spinner } from "@fluentui/react-components";
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
        return Boolean(item.missing || item.conflict || item.needs_rename);
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

  const handleApplyRetags = useCallback(async (ids?: number[]) => {
    setRetagApplying(true);
    try {
      if (ids?.length) {
        const result: any = await api.applyRetags({ ids });
        toast({
          title: "Retag queued",
          description: result?.message || `Queued retag for ${ids.length} file(s).`,
        });
      } else {
        const { artistIds = [], albumIds = [] } = pendingScopeRef.current;
        let queued = 0;
        if (albumIds.length > 0) {
          for (const albumId of albumIds) {
            await api.applyRetags({ applyAll: true, albumId });
            queued += 1;
          }
        } else {
          for (const artistId of artistIds) {
            await api.applyRetags({ applyAll: true, artistId });
            queued += 1;
          }
        }
        toast({
          title: "Retag queued",
          description: `Queued retag for ${queued} selected scope${queued === 1 ? "" : "s"}.`,
        });
      }
      setRetagPreviewOpen(false);
    } catch (error) {
      toast({
        title: "Failed to queue retag",
        description: error instanceof Error ? error.message : "Could not queue retag.",
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
