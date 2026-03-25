import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "@/services/api";
import { useToast } from "@/hooks/useToast";
import type { TrackListItem as Track } from "@/types/track-list";

export const useTracks = (options?: {
  monitored?: boolean;
  downloaded?: boolean;
  libraryFilter?: 'all' | 'stereo' | 'atmos' | 'video';
  sort?: string;
  dir?: 'asc' | 'desc';
  search?: string;
  enabled?: boolean;
}) => {
  const [tracks, setTracks] = useState<Track[]>([]);
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
  const libraryFilter = options?.libraryFilter ?? 'all';
  const sort = options?.sort;
  const dir = options?.dir;
  const search = options?.search;
  const enabled = options?.enabled ?? true;

  const fetchTracksPage = useCallback(async (pageNum: number = 0, append: boolean = false) => {
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
      const data: any = await api.getTracks({
        limit: 100,
        offset: pageNum * 100,
        monitored,
        downloaded,
        library_filter: libraryFilter === 'video' ? 'all' : libraryFilter,
        sort,
        dir,
        search,
      });

      if (fetchId !== fetchIdRef.current) {
        return;
      }

      if (append) {
        setTracks(prev => [...prev, ...(data.items || data)]);
      } else {
        setTracks(data.items || data);
      }

      setHasMore(data.hasMore !== undefined ? data.hasMore : false);
      setTotal(data.total || 0);
      setPage(pageNum);
    } catch (error: any) {
      if (fetchId !== fetchIdRef.current) {
        return;
      }
      console.error('Error fetching tracks:', error);
      toastRef.current({
        title: "Failed to load tracks",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      if (!append && fetchId === fetchIdRef.current) {
        setLoading(false);
      }
    }
  }, [enabled, monitored, downloaded, libraryFilter, sort, dir, search]);

  const loadMore = useCallback(async () => {
    if (!hasMore || loading) return;
    if (appendInFlightRef.current) return;

    appendInFlightRef.current = true;
    try {
      await fetchTracksPage(page + 1, true);
    } finally {
      appendInFlightRef.current = false;
    }
  }, [page, hasMore, loading, fetchTracksPage]);

  const fetchRef = useRef(fetchTracksPage);
  fetchRef.current = fetchTracksPage;

  useEffect(() => {
    toastRef.current = toast;
  }, [toast]);

  useEffect(() => {
    if (!enabled) {
      fetchIdRef.current += 1;
      setLoading(false);
      return;
    }

    setTracks([]);
    setPage(0);
    setHasMore(true);
    fetchRef.current(0, false);
  }, [enabled, monitored, downloaded, libraryFilter, sort, dir, search]);

  return {
    tracks,
    loading,
    hasMore,
    total,
    loadMore,
    refetch: () => fetchTracksPage(0, false),
  };
};
