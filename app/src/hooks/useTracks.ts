import { useCallback, useEffect, useRef } from "react";
import {
  type InfiniteData,
  useInfiniteQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { api } from "@/services/api";
import { useToast } from "@/hooks/useToast";
import { useDebouncedQueryInvalidation } from "@/hooks/useDebouncedQueryInvalidation";
import type { TrackListItem as Track } from "@/types/track-list";
import {
  LIBRARY_UPDATED_EVENT,
  MONITOR_STATE_CHANGED_EVENT,
  type MonitorStateChangedDetail,
} from "@/utils/appEvents";

type TracksPage = {
  items: Track[];
  hasMore: boolean;
  total: number;
  offset: number;
};

type UseTracksOptions = {
  monitored?: boolean;
  downloaded?: boolean;
  locked?: boolean;
  libraryFilter?: "all" | "stereo" | "atmos" | "video";
  sort?: string;
  dir?: "asc" | "desc";
  search?: string;
  enabled?: boolean;
};

const TRACKS_PAGE_SIZE = 100;
const TRACKS_GLOBAL_EVENTS = [
  "artist.scanned",
  "album.scanned",
  "rescan.completed",
  "file.added",
  "file.deleted",
  "file.upgraded",
] as const;

const tracksQueryKey = (options: UseTracksOptions) => [
  "tracks",
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

function normalizeTracksPage(response: unknown, offset: number): TracksPage {
  if (Array.isArray(response)) {
    return {
      items: response as Track[],
      hasMore: false,
      total: offset + response.length,
      offset,
    };
  }

  const record = (response && typeof response === "object")
    ? response as {
      items?: unknown;
      hasMore?: unknown;
      total?: unknown;
    }
    : null;
  const items = Array.isArray(record?.items) ? record.items as Track[] : [];

  return {
    items,
    hasMore: record?.hasMore === true,
    total: typeof record?.total === "number" ? record.total : offset + items.length,
    offset,
  };
}

function updateTrackPages(
  data: InfiniteData<TracksPage> | undefined,
  updater: (track: Track) => Track,
): InfiniteData<TracksPage> | undefined {
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

export const useTracks = (options?: UseTracksOptions) => {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const enabled = options?.enabled ?? true;
  const queryKey = tracksQueryKey(options ?? {});
  const lastErrorMessageRef = useRef<string | null>(null);

  useDebouncedQueryInvalidation({
    queryKeys: [queryKey],
    globalEvents: [...TRACKS_GLOBAL_EVENTS],
    windowEvents: [LIBRARY_UPDATED_EVENT],
    debounceMs: 400,
  });

  const query = useInfiniteQuery({
    queryKey,
    queryFn: async ({ pageParam }) => {
      const offset = Number(pageParam || 0);
      const response = await api.getTracks({
        limit: TRACKS_PAGE_SIZE,
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

      return normalizeTracksPage(response, offset);
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
  const tracks = enabled ? pages.flatMap((page) => page.items) : [];
  const hasMore = enabled ? Boolean(query.hasNextPage) : false;
  const total = enabled ? (pages[pages.length - 1]?.total ?? pages[0]?.total ?? 0) : 0;
  const loading = enabled ? query.isPending && tracks.length === 0 : false;

  useEffect(() => {
    if (!query.isError) {
      lastErrorMessageRef.current = null;
      return;
    }

    const message = query.error instanceof Error
      ? query.error.message
      : "Could not load tracks";
    if (message === lastErrorMessageRef.current) {
      return;
    }

    lastErrorMessageRef.current = message;
    toast({
      title: "Failed to load tracks",
      description: message,
      variant: "destructive",
    });
  }, [query.error, query.isError, toast]);

  useEffect(() => {
    const handleMonitorStateChanged = (event: Event) => {
      const detail = (event as CustomEvent<MonitorStateChangedDetail>).detail;
      if (!detail || detail.type !== "track") {
        return;
      }

      queryClient.setQueriesData<InfiniteData<TracksPage>>(
        { queryKey: ["tracks"] },
        (current) => updateTrackPages(current, (track) => (
          track.id === detail.tidalId
            ? { ...track, is_monitored: detail.monitored, monitor: detail.monitored }
            : track
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

  return {
    tracks,
    loading,
    hasMore,
    total,
    loadMore,
    refetch: () => query.refetch(),
  };
};
