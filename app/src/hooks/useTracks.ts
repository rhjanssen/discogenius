import { useCallback, useEffect } from "react";
import {
  type InfiniteData,
  useQueryClient,
} from "@tanstack/react-query";
import { api } from "@/services/api";
import { useCatalogInfiniteResource, type CatalogPage } from "@/hooks/useCatalogInfiniteResource";
import { useDebouncedQueryInvalidation } from "@/hooks/useDebouncedQueryInvalidation";
import type { TrackListItem as Track } from "@/types/track-list";
import {
  LIBRARY_UPDATED_EVENT,
  MONITOR_STATE_CHANGED_EVENT,
  type MonitorStateChangedDetail,
} from "@/utils/appEvents";

type TracksPage = CatalogPage<Track>;

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

const TRACKS_PAGE_SIZE = 50;
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
  const queryClient = useQueryClient();
  const enabled = options?.enabled ?? true;
  const queryKey = tracksQueryKey(options ?? {});

  useDebouncedQueryInvalidation({
    queryKeys: [queryKey],
    globalEvents: [...TRACKS_GLOBAL_EVENTS],
    windowEvents: [LIBRARY_UPDATED_EVENT],
    debounceMs: 400,
  });

  const query = useCatalogInfiniteResource<Track, Awaited<ReturnType<typeof api.getTracks>>>({
    queryKey,
    pageSize: TRACKS_PAGE_SIZE,
    fetchPage: ({ limit, offset, signal, timeoutMs }) => api.getTracks({
        limit,
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
        signal,
        timeoutMs,
      }),
    normalizePage: normalizeTracksPage,
    enabled,
  });

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
    tracks: query.items,
    loading: query.loading,
    isPopulated: query.isPopulated,
    hasMore: query.hasMore,
    total: query.total,
    loadMore,
    refetch: () => query.refetch(),
    hasRefreshError: query.hasRefreshError,
    refreshErrorMessage: query.refreshErrorMessage,
  };
};
