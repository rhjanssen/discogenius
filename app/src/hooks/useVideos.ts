import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "@/services/api";
import { useToast } from "@/hooks/useToast";
import { dispatchLibraryUpdated, dispatchMonitorStateChanged } from "@/utils/appEvents";

export interface Video {
  id: string;
  title: string;
  duration: number;
  release_date?: string;
  version?: string;
  explicit?: boolean;
  quality?: string;
  cover_art_url?: string;
  url?: string;
  path?: string;
  artist_id: string;
  artist_name?: string;
  is_monitored: boolean;
  is_downloaded: boolean;
  created_at?: string;
  updated_at?: string;
}

export const useVideos = (options?: {
  monitored?: boolean;
  downloaded?: boolean;
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
      const data: any = await api.getVideos({
        limit: 50,
        offset: pageNum * 50,
        monitored,
        downloaded,
        sort,
        dir,
        search,
      });

      if (fetchId !== fetchIdRef.current) {
        return;
      }

      if (append) {
        setVideos(prev => [...prev, ...(data.items || data)]);
      } else {
        setVideos(data.items || data);
      }

      setHasMore(data.hasMore !== undefined ? data.hasMore : false);
      setTotal(data.total || 0);
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
  }, [enabled, monitored, downloaded, sort, dir, search]);

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

  const fetchRef = useRef(fetchVideosPage);
  fetchRef.current = fetchVideosPage;

  useEffect(() => {
    toastRef.current = toast;
  }, [toast]);

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
  }, [enabled, monitored, downloaded, sort, dir, search]);

  return {
    videos,
    loading,
    hasMore,
    total,
    loadMore,
    refetch: () => fetchVideosPage(0, false),
    toggleMonitor,
  };
};
