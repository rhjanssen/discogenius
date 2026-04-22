import { useCallback, useEffect } from "react";
import {
  type InfiniteData,
  useQueryClient,
} from "@tanstack/react-query";
import { api } from "@/services/api";
import { useToast } from "@/hooks/useToast";
import { useCatalogInfiniteResource, type CatalogPage } from "@/hooks/useCatalogInfiniteResource";
import { useDebouncedQueryInvalidation } from "@/hooks/useDebouncedQueryInvalidation";
import {
  LIBRARY_UPDATED_EVENT,
  MONITOR_STATE_CHANGED_EVENT,
  dispatchLibraryUpdated,
  dispatchMonitorStateChanged,
  type MonitorStateChangedDetail,
} from "@/utils/appEvents";
import type { VideoContract as Video } from "@contracts/catalog";

export type { Video };

type VideosPage = CatalogPage<Video>;

type UseVideosOptions = {
  monitored?: boolean;
  downloaded?: boolean;
  locked?: boolean;
  sort?: string;
  dir?: "asc" | "desc";
  search?: string;
  enabled?: boolean;
};

const VIDEOS_PAGE_SIZE = 50;
const VIDEOS_GLOBAL_EVENTS = [
  "artist.scanned",
  "album.scanned",
  "rescan.completed",
  "file.added",
  "file.deleted",
  "file.upgraded",
] as const;

const videosQueryKey = (options: UseVideosOptions) => [
  "videos",
  {
    monitored: options.monitored,
    downloaded: options.downloaded,
    locked: options.locked,
    sort: options.sort ?? null,
    dir: options.dir ?? null,
    search: options.search ?? "",
  },
] as const;

function updateVideoPages(
  data: InfiniteData<VideosPage> | undefined,
  updater: (video: Video) => Video,
): InfiniteData<VideosPage> | undefined {
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

export const useVideos = (options?: UseVideosOptions) => {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const enabled = options?.enabled ?? true;
  const queryKey = videosQueryKey(options ?? {});

  useDebouncedQueryInvalidation({
    queryKeys: [queryKey],
    globalEvents: [...VIDEOS_GLOBAL_EVENTS],
    windowEvents: [LIBRARY_UPDATED_EVENT],
    debounceMs: 400,
  });

  const query = useCatalogInfiniteResource<Video, Awaited<ReturnType<typeof api.getVideos>>>({
    queryKey,
    pageSize: VIDEOS_PAGE_SIZE,
    fetchPage: ({ limit, offset, signal, timeoutMs }) => api.getVideos({
        limit,
        offset,
        monitored: options?.monitored,
        downloaded: options?.downloaded,
        locked: options?.locked,
        sort: options?.sort,
        dir: options?.dir,
        search: options?.search,
        signal,
        timeoutMs,
      }),
    enabled,
  });

  useEffect(() => {
    const handleMonitorStateChanged = (event: Event) => {
      const detail = (event as CustomEvent<MonitorStateChangedDetail>).detail;
      if (!detail || detail.type !== "video") {
        return;
      }

      queryClient.setQueriesData<InfiniteData<VideosPage>>(
        { queryKey: ["videos"] },
        (current) => updateVideoPages(current, (video) => (
          video.id === detail.tidalId
            ? { ...video, is_monitored: detail.monitored, monitor: detail.monitored }
            : video
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

  const toggleMonitor = useCallback(async (videoId: string, nextState: boolean) => {
    try {
      await api.updateVideo(videoId, { monitored: nextState });
      queryClient.setQueriesData<InfiniteData<VideosPage>>(
        { queryKey: ["videos"] },
        (current) => updateVideoPages(current, (video) => (
          video.id === videoId
            ? { ...video, is_monitored: nextState, monitor: nextState }
            : video
        )),
      );
      dispatchMonitorStateChanged({
        type: "video",
        tidalId: videoId,
        monitored: nextState,
      });
      dispatchLibraryUpdated();
    } catch (error) {
      console.error("Error updating video:", error);
      toast({
        title: "Failed to update video",
        description: error instanceof Error ? error.message : "Could not update video",
        variant: "destructive",
      });
    }
  }, [queryClient, toast]);

  const toggleLock = useCallback(async (videoId: string, nextState: boolean) => {
    try {
      await api.updateVideo(videoId, { monitor_lock: nextState });
      queryClient.setQueriesData<InfiniteData<VideosPage>>(
        { queryKey: ["videos"] },
        (current) => updateVideoPages(current, (video) => (
          video.id === videoId
            ? { ...video, monitor_lock: nextState, monitor_locked: nextState }
            : video
        )),
      );
      dispatchLibraryUpdated();
    } catch (error) {
      console.error("Error updating video lock:", error);
      toast({
        title: "Failed to update video lock",
        description: error instanceof Error ? error.message : "Could not update video lock",
        variant: "destructive",
      });
    }
  }, [queryClient, toast]);

  return {
    videos: query.items,
    loading: query.loading,
    isPopulated: query.isPopulated,
    hasMore: query.hasMore,
    total: query.total,
    loadMore,
    refetch: () => query.refetch(),
    toggleMonitor,
    toggleLock,
    hasRefreshError: query.hasRefreshError,
    refreshErrorMessage: query.refreshErrorMessage,
  };
};
