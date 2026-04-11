import { useCallback, useEffect, useRef } from "react";
import {
  type InfiniteData,
  useInfiniteQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { AlbumContract as Album } from "@contracts/catalog";
import { api } from "@/services/api";
import { useToast } from "@/hooks/useToast";
import { useDebouncedQueryInvalidation } from "@/hooks/useDebouncedQueryInvalidation";
import {
  LIBRARY_UPDATED_EVENT,
  MONITOR_STATE_CHANGED_EVENT,
  dispatchLibraryUpdated,
  dispatchMonitorStateChanged,
  type MonitorStateChangedDetail,
} from "@/utils/appEvents";

export type { Album };

type AlbumsPage = {
  items: Album[];
  hasMore: boolean;
  total: number;
  offset: number;
};

type UseAlbumsOptions = {
  monitored?: boolean;
  downloaded?: boolean;
  locked?: boolean;
  libraryFilter?: "all" | "stereo" | "atmos" | "video";
  sort?: string;
  dir?: "asc" | "desc";
  search?: string;
  enabled?: boolean;
};

const ALBUMS_PAGE_SIZE = 50;
const ALBUMS_GLOBAL_EVENTS = [
  "artist.scanned",
  "album.scanned",
  "rescan.completed",
  "file.added",
  "file.deleted",
  "file.upgraded",
] as const;

const albumsQueryKey = (options: UseAlbumsOptions) => [
  "albums",
  {
    monitored: options.monitored,
    downloaded: options.downloaded,
    locked: options.locked,
    libraryFilter: options.libraryFilter ?? "all",
    sort: options.sort ?? null,
    dir: options.dir ?? null,
    search: options.search ?? "",
  },
] as const;

function updateAlbumPages(
  data: InfiniteData<AlbumsPage> | undefined,
  updater: (album: Album) => Album,
): InfiniteData<AlbumsPage> | undefined {
  if (!data) {
    return data;
  }

  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      items: page.items.map(updater),
    })),
  };
}

export const useAlbums = (options?: UseAlbumsOptions) => {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const enabled = options?.enabled ?? true;
  const queryKey = albumsQueryKey(options ?? {});
  const lastErrorMessageRef = useRef<string | null>(null);

  useDebouncedQueryInvalidation({
    queryKeys: [queryKey],
    globalEvents: [...ALBUMS_GLOBAL_EVENTS],
    windowEvents: [LIBRARY_UPDATED_EVENT],
    debounceMs: 400,
  });

  const query = useInfiniteQuery({
    queryKey,
    queryFn: async ({ pageParam }) => {
      const offset = Number(pageParam || 0);
      const response = await api.getAlbums({
        limit: ALBUMS_PAGE_SIZE,
        offset,
        monitored: options?.monitored,
        downloaded: options?.downloaded,
        locked: options?.locked,
        library_filter: (options?.libraryFilter ?? "all") === "video"
          ? "all"
          : (options?.libraryFilter ?? "all"),
        sort: options?.sort,
        dir: options?.dir,
        search: options?.search,
      });

      return {
        items: response.items,
        hasMore: response.hasMore,
        total: response.total,
        offset,
      };
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage) => (
      lastPage.hasMore
        ? lastPage.offset + lastPage.items.length
        : undefined
    ),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    placeholderData: (previousData) => previousData,
    enabled,
  });

  const pages = query.data?.pages ?? [];
  const albums = enabled ? pages.flatMap((page) => page.items) : [];
  const hasMore = enabled ? Boolean(query.hasNextPage) : false;
  const total = enabled ? (pages[pages.length - 1]?.total ?? pages[0]?.total ?? 0) : 0;
  const loading = enabled ? query.isPending && albums.length === 0 : false;

  useEffect(() => {
    if (!query.isError) {
      lastErrorMessageRef.current = null;
      return;
    }

    const message = query.error instanceof Error
      ? query.error.message
      : "Could not load albums";
    if (message === lastErrorMessageRef.current) {
      return;
    }

    lastErrorMessageRef.current = message;
    toast({
      title: "Failed to load albums",
      description: message,
      variant: "destructive",
    });
  }, [query.error, query.isError, toast]);

  useEffect(() => {
    const handleMonitorStateChanged = (event: Event) => {
      const detail = (event as CustomEvent<MonitorStateChangedDetail>).detail;
      if (!detail || detail.type !== "album") {
        return;
      }

      queryClient.setQueriesData<InfiniteData<AlbumsPage>>(
        { queryKey: ["albums"] },
        (current) => updateAlbumPages(current, (album) => (
          album.id === detail.tidalId
            ? { ...album, is_monitored: detail.monitored }
            : album
        )),
      );
    };

    window.addEventListener(MONITOR_STATE_CHANGED_EVENT, handleMonitorStateChanged as EventListener);
    return () => {
      window.removeEventListener(MONITOR_STATE_CHANGED_EVENT, handleMonitorStateChanged as EventListener);
    };
  }, [queryClient]);

  const loadMore = useCallback(async () => {
    if (!enabled || !query.hasNextPage || query.isFetchingNextPage) {
      return;
    }

    await query.fetchNextPage();
  }, [enabled, query]);

  const toggleMonitor = useCallback(async (albumId: string, nextState: boolean) => {
    queryClient.setQueriesData<InfiniteData<AlbumsPage>>(
      { queryKey: ["albums"] },
      (current) => updateAlbumPages(current, (album) => (
        album.id === albumId
          ? { ...album, is_monitored: nextState }
          : album
      )),
    );

    try {
      await api.updateAlbum(albumId, { monitored: nextState });
      dispatchMonitorStateChanged({
        type: "album",
        tidalId: albumId,
        monitored: nextState,
      });
      dispatchLibraryUpdated();
    } catch (error) {
      queryClient.setQueriesData<InfiniteData<AlbumsPage>>(
        { queryKey: ["albums"] },
        (current) => updateAlbumPages(current, (album) => (
          album.id === albumId
            ? { ...album, is_monitored: !nextState }
            : album
        )),
      );
      toast({
        title: "Failed to update album",
        description: error instanceof Error ? error.message : "Could not update album monitoring",
        variant: "destructive",
      });
    }
  }, [queryClient, toast]);

  const toggleLock = useCallback(async (albumId: string, nextState: boolean) => {
    queryClient.setQueriesData<InfiniteData<AlbumsPage>>(
      { queryKey: ["albums"] },
      (current) => updateAlbumPages(current, (album) => (
        album.id === albumId
          ? { ...album, monitor_lock: nextState, monitor_locked: nextState }
          : album
      )),
    );

    try {
      await api.updateAlbum(albumId, { monitor_lock: nextState });
      dispatchLibraryUpdated();
    } catch (error) {
      queryClient.setQueriesData<InfiniteData<AlbumsPage>>(
        { queryKey: ["albums"] },
        (current) => updateAlbumPages(current, (album) => (
          album.id === albumId
            ? { ...album, monitor_lock: !nextState, monitor_locked: !nextState }
            : album
        )),
      );
      toast({
        title: "Failed to update album lock",
        description: error instanceof Error ? error.message : "Could not update album lock",
        variant: "destructive",
      });
    }
  }, [queryClient, toast]);

  return {
    albums,
    loading,
    hasMore,
    total,
    loadMore,
    refetch: () => query.refetch(),
    toggleMonitor,
    toggleLock,
  };
};
