import { useCallback, useEffect, useRef } from "react";
import {
  type InfiniteData,
  useInfiniteQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { ArtistContract as Artist } from "@contracts/catalog";
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

export type { Artist };

type ArtistsPage = {
  items: Artist[];
  hasMore: boolean;
  total: number;
  offset: number;
};

type UseArtistsOptions = {
  monitored?: boolean;
  sort?: string;
  dir?: "asc" | "desc";
  search?: string;
  includeDownloadStats?: boolean;
  enabled?: boolean;
};

const ARTISTS_PAGE_SIZE = 50;
const ARTISTS_GLOBAL_EVENTS = [
  "artist.scanned",
  "album.scanned",
  "rescan.completed",
  "file.added",
  "file.deleted",
  "file.upgraded",
] as const;

const artistsQueryKey = (options: UseArtistsOptions) => [
  "artists",
  {
    monitored: options.monitored,
    sort: options.sort ?? null,
    dir: options.dir ?? null,
    search: options.search ?? "",
    includeDownloadStats: options.includeDownloadStats ?? false,
  },
] as const;

function updateArtistPages(
  data: InfiniteData<ArtistsPage> | undefined,
  updater: (artist: Artist) => Artist,
): InfiniteData<ArtistsPage> | undefined {
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

export const useArtists = (options?: UseArtistsOptions) => {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const enabled = options?.enabled ?? true;
  const queryKey = artistsQueryKey(options ?? {});
  const lastErrorMessageRef = useRef<string | null>(null);

  useDebouncedQueryInvalidation({
    queryKeys: [queryKey],
    globalEvents: [...ARTISTS_GLOBAL_EVENTS],
    windowEvents: [LIBRARY_UPDATED_EVENT],
    debounceMs: 400,
  });

  const query = useInfiniteQuery({
    queryKey,
    queryFn: async ({ pageParam }) => {
      const offset = Number(pageParam || 0);
      const response = await api.getArtists({
        limit: ARTISTS_PAGE_SIZE,
        offset,
        monitored: options?.monitored,
        sort: options?.sort,
        dir: options?.dir,
        search: options?.search,
        includeDownloadStats: options?.includeDownloadStats ?? false,
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
  const artists = enabled ? pages.flatMap((page) => page.items) : [];
  const hasMore = enabled ? Boolean(query.hasNextPage) : false;
  const total = enabled ? (pages[pages.length - 1]?.total ?? pages[0]?.total ?? 0) : 0;
  const loading = enabled ? query.isPending && artists.length === 0 : false;

  useEffect(() => {
    if (!query.isError) {
      lastErrorMessageRef.current = null;
      return;
    }

    const message = query.error instanceof Error
      ? query.error.message
      : "Could not load artists";
    if (message === lastErrorMessageRef.current) {
      return;
    }

    lastErrorMessageRef.current = message;
    toast({
      title: "Failed to load artists",
      description: message,
      variant: "destructive",
    });
  }, [query.error, query.isError, toast]);

  useEffect(() => {
    const handleMonitorStateChanged = (event: Event) => {
      const detail = (event as CustomEvent<MonitorStateChangedDetail>).detail;
      if (!detail || detail.type !== "artist") {
        return;
      }

      queryClient.setQueriesData<InfiniteData<ArtistsPage>>(
        { queryKey: ["artists"] },
        (current) => updateArtistPages(current, (artist) => (
          artist.id === detail.tidalId
            ? { ...artist, is_monitored: detail.monitored }
            : artist
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

  const toggleMonitor = useCallback(async (artistId: string, nextState: boolean) => {
    queryClient.setQueriesData<InfiniteData<ArtistsPage>>(
      { queryKey: ["artists"] },
      (current) => updateArtistPages(current, (artist) => (
        artist.id === artistId
          ? { ...artist, is_monitored: nextState }
          : artist
      )),
    );

    try {
      await api.toggleArtistMonitored(artistId, nextState);
      dispatchMonitorStateChanged({
        type: "artist",
        tidalId: artistId,
        monitored: nextState,
      });
      dispatchLibraryUpdated();
    } catch (error) {
      queryClient.setQueriesData<InfiniteData<ArtistsPage>>(
        { queryKey: ["artists"] },
        (current) => updateArtistPages(current, (artist) => (
          artist.id === artistId
            ? { ...artist, is_monitored: !nextState }
            : artist
        )),
      );
      toast({
        title: "Failed to update monitoring",
        description: error instanceof Error ? error.message : "Could not update artist monitoring",
        variant: "destructive",
      });
    }
  }, [queryClient, toast]);

  return {
    artists,
    loading,
    hasMore,
    total,
    loadMore,
    refetch: () => query.refetch(),
    toggleMonitor,
  };
};
