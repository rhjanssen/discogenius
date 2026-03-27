import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "@/services/api";
import { useToast } from "@/hooks/useToast";
import {
  LIBRARY_UPDATED_EVENT,
  MONITOR_STATE_CHANGED_EVENT,
  dispatchLibraryUpdated,
  dispatchMonitorStateChanged,
  type MonitorStateChangedDetail,
} from "@/utils/appEvents";
import type { VideoContract as Video } from "@contracts/catalog";

export type { Video };

export const useVideos = (options?: {
  monitored?: boolean;
  downloaded?: boolean;
  locked?: boolean;
  sort?: string;
  dir?: 'asc' | 'desc';
  search?: string;
  enabled?: boolean;
}) => {
  const [videos, setVideos] = useState<Video[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [total, setTotal] = useState(0);
  const { toast } = useToast();
  const toastRef = useRef(toast);
  const fetchIdRef = useRef(0);
  const appendInFlightRef = useRef(false);

  const monitored = options?.monitored;
  const downloaded = options?.downloaded;
  const locked = options?.locked;
  const sort = options?.sort;
  const dir = options?.dir;
  const search = options?.search;
  const enabled = options?.enabled ?? true;

  const fetchVideosPage = useCallback(async (pageNum: number = 0, append: boolean = false) => {
    if (!enabled) {
      fetchIdRef.current += 1;
      setLoading(false);
      return;
    }

    const fetchId = ++fetchIdRef.current;

    try {
      if (!append) {
        setLoading(true);
      }
      const data = await api.getVideos({
        limit: 50,
        offset: pageNum * 50,
        monitored,
        downloaded,
        locked,
        sort,
        dir,
        search,
      });

      if (fetchId !== fetchIdRef.current) {
        return;
      }

      if (append) {
        setVideos(prev => [...prev, ...data.items]);
      } else {
        setVideos(data.items);
      }

      setHasMore(data.hasMore);
      setTotal(data.total);
      setPage(pageNum);
    } catch (error: any) {
      if (fetchId !== fetchIdRef.current) {
        return;
      }
      console.error('Error fetching videos:', error);
      toastRef.current({
        title: "Failed to load videos",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      if (!append && fetchId === fetchIdRef.current) {
        setLoading(false);
      }
    }
  }, [enabled, monitored, downloaded, locked, sort, dir, search]);

  const loadMore = useCallback(async () => {
    if (!hasMore || loading) return;
    if (appendInFlightRef.current) return;

    appendInFlightRef.current = true;
    try {
      await fetchVideosPage(page + 1, true);
    } finally {
      appendInFlightRef.current = false;
    }
  }, [page, hasMore, loading, fetchVideosPage]);

  const toggleMonitor = useCallback(async (videoId: string, nextState: boolean) => {
    try {
      await api.updateVideo(videoId, { monitored: nextState });
      setVideos(prev =>
        prev.map(video =>
          video.id === videoId ? { ...video, is_monitored: nextState } : video
        )
      );
      dispatchMonitorStateChanged({
        type: 'video',
        tidalId: videoId,
        monitored: nextState,
      });
      dispatchLibraryUpdated();
    } catch (error: any) {
      console.error('Error updating video:', error);
      toastRef.current({
        title: "Failed to update video",
        description: error.message,
        variant: "destructive",
      });
    }
  }, []);

  const toggleLock = useCallback(async (videoId: string, nextState: boolean) => {
    try {
      await api.updateVideo(videoId, { monitor_lock: nextState });
      setVideos(prev =>
        prev.map(video =>
          video.id === videoId ? { ...video, monitor_lock: nextState, monitor_locked: nextState } : video
        )
      );
      dispatchLibraryUpdated();
    } catch (error: any) {
      console.error('Error updating video lock:', error);
      toastRef.current({
        title: "Failed to update video lock",
        description: error.message,
        variant: "destructive",
      });
    }
  }, []);

  const fetchRef = useRef(fetchVideosPage);
  fetchRef.current = fetchVideosPage;

  useEffect(() => {
    toastRef.current = toast;
  }, [toast]);

  useEffect(() => {
    const handleLibraryUpdate = () => {
      if (!enabled) {
        return;
      }

      fetchRef.current(0, false);
    };

    const handleMonitorStateChanged = (event: Event) => {
      const detail = (event as CustomEvent<MonitorStateChangedDetail>).detail;
      if (!detail || detail.type !== "video") {
        return;
      }

      setVideos((prev) => prev.map((video) => (
        video.id === detail.tidalId
          ? { ...video, is_monitored: detail.monitored, monitor: detail.monitored }
          : video
      )));
    };

    window.addEventListener(LIBRARY_UPDATED_EVENT, handleLibraryUpdate);
    window.addEventListener(MONITOR_STATE_CHANGED_EVENT, handleMonitorStateChanged as EventListener);

    return () => {
      window.removeEventListener(LIBRARY_UPDATED_EVENT, handleLibraryUpdate);
      window.removeEventListener(MONITOR_STATE_CHANGED_EVENT, handleMonitorStateChanged as EventListener);
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      fetchIdRef.current += 1;
      setLoading(false);
      return;
    }

    setVideos([]);
    setPage(0);
    setHasMore(true);
    fetchRef.current(0, false);
  }, [enabled, monitored, downloaded, locked, sort, dir, search]);

  return {
    videos,
    loading,
    hasMore,
    total,
    loadMore,
    refetch: () => fetchVideosPage(0, false),
    toggleMonitor,
    toggleLock,
  };
};
