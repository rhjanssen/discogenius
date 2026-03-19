import { useState, useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/services/api";
import { useToast } from "@/hooks/useToast";
import type { SearchResponseContract, SearchResultContract } from "@contracts/catalog";
import { formatDurationSeconds } from "@/utils/format";
import {
    clearOptimisticMonitorState,
    dispatchActivityRefresh,
    dispatchLibraryUpdated,
    dispatchMonitorStateChanged,
    setOptimisticMonitorState,
} from "@/utils/appEvents";

export interface SearchResultItem {
    id: number;
    tidalId: string;
    name: string;
    imageUrl: string | null;
    type: 'artist' | 'album' | 'track' | 'video';
    subtitle?: string;
    monitored?: boolean;
    inLibrary?: boolean;
    imageId?: string;
}

export interface SearchResults {
    artists: SearchResultItem[];
    albums: SearchResultItem[];
    tracks: SearchResultItem[];
    videos: SearchResultItem[];
    topResult?: SearchResultItem;
}

export const useSearch = () => {
    const queryClient = useQueryClient();
    const [searchResults, setSearchResults] = useState<SearchResults>({
        artists: [],
        albums: [],
        tracks: [],
        videos: [],
    });
    const [isSearching, setIsSearching] = useState(false);
    const { toast } = useToast();
    const toastRef = useRef(toast);
    const searchAbortRef = useRef<AbortController | null>(null);
    const latestSearchIdRef = useRef(0);

    useEffect(() => {
        toastRef.current = toast;
    }, [toast]);

    useEffect(() => {
        return () => {
            searchAbortRef.current?.abort();
        };
    }, []);

    const syncOptimisticMonitorState = useCallback((item: SearchResultItem, monitored: boolean) => {
        const detail = {
            type: item.type,
            tidalId: item.tidalId,
            monitored,
        } as const;

        setOptimisticMonitorState(detail);
        dispatchMonitorStateChanged(detail);
    }, []);

    const reconcileMonitorQueries = useCallback((item: SearchResultItem) => {
        queryClient.invalidateQueries({ queryKey: [item.type, item.tidalId] });

        if (item.type === 'artist') {
            queryClient.invalidateQueries({ queryKey: ["artistPage", item.tidalId] });
        }
    }, [queryClient]);

    const search = useCallback(async (
        query: string,
    ) => {
        if (!query.trim()) {
            searchAbortRef.current?.abort();
            setSearchResults({ artists: [], albums: [], tracks: [], videos: [] });
            setIsSearching(false);
            return;
        }

        // Cancel in-flight request to prevent race conditions / stale error toasts.
        searchAbortRef.current?.abort();
        const controller = new AbortController();
        searchAbortRef.current = controller;
        const searchId = ++latestSearchIdRef.current;

        setIsSearching(true);
        try {
            // Search for all types
            const data: SearchResponseContract = await api.search(
                query,
                ['artists', 'albums', 'tracks', 'videos'],
                10,
                controller.signal,
            );

            // Ignore stale responses from older requests.
            if (searchId !== latestSearchIdRef.current) return;

            const formatItem = (item: SearchResultContract, type: 'artist' | 'album' | 'track' | 'video'): SearchResultItem => {

                // Helper to get year
                const getYear = (date?: string | null) => {
                    if (!date) return '';
                    return new Date(date).getFullYear().toString();
                };

                // Format the subtitle: Type · Artist · Info
                const typeLabel = type.charAt(0).toUpperCase() + type.slice(1);
                const artistPart = item.subtitle || undefined;

                let infoPart = undefined;
                if (type === 'track' && item.duration !== undefined) infoPart = formatDurationSeconds(item.duration);
                if (type === 'video' && item.duration !== undefined) infoPart = formatDurationSeconds(item.duration);
                if (type === 'album') infoPart = getYear(item.release_date);

                const parts = [typeLabel];
                if (artistPart) parts.push(artistPart);
                if (infoPart) parts.push(infoPart);

                const finalSubtitle = parts.join(' · ');

                return {
                    id: parseInt(String(item.id)),
                    tidalId: item.id?.toString(),
                    name: item.name,
                    imageUrl: null, // Computed on frontend now
                    type,
                    subtitle: finalSubtitle, // Pre-formatted subtitle
                    monitored: !!item.monitored,
                    inLibrary: !!item.in_library,
                    imageId: item.imageId || undefined,
                };
            };

            // Backend now returns grouped results
            const results = data.results;

            const artists = (results.artists || []).map((i) => formatItem(i, 'artist'));
            const albums = (results.albums || []).map((i) => formatItem(i, 'album'));
            const tracks = (results.tracks || []).map((i) => formatItem(i, 'track'));
            const videos = (results.videos || []).map((i) => formatItem(i, 'video'));


            // Determine top result
            // Priority: Exact Track Match > Exact Artist Match > Exact Album Match > First Artist > First Track
            const lowerQuery = query.toLowerCase();

            const topResult: SearchResultItem | undefined = tracks.find((a: SearchResultItem) => a.name.toLowerCase() === lowerQuery) ||
                artists.find((a: SearchResultItem) => a.name.toLowerCase() === lowerQuery) ||
                albums.find((a: SearchResultItem) => a.name.toLowerCase() === lowerQuery) ||
                artists[0] ||
                tracks[0] ||
                albums[0];

            setSearchResults({
                artists,  // Keep full list (like tidarr)
                albums,   // Keep full list
                tracks,   // Keep full list
                videos,   // Keep full list
                topResult,
            });
        } catch (error: any) {
            const isHidden = typeof document !== 'undefined' && document.visibilityState !== 'visible';
            const isFailedFetch = String(error?.message || '').includes('Failed to fetch');

            // Ignore intentional aborts (new query typed, component unmount, navigation/tab close).
            if (error?.name === 'AbortError' || (isFailedFetch && isHidden)) {
                return;
            }

            if (searchId !== latestSearchIdRef.current) return;

            console.error('Search error:', error);
            toastRef.current({
                title: "Search failed",
                description: error.message || "Failed to perform search",
                variant: "destructive",
            });
            setSearchResults({ artists: [], albums: [], tracks: [], videos: [] });
        } finally {
            if (searchId === latestSearchIdRef.current) {
                setIsSearching(false);
            }
        }
    }, []);

    const addItem = useCallback(async (item: SearchResultItem) => {
        const previousMonitored = Boolean(item.monitored);
        const previousInLibrary = Boolean(item.inLibrary);

        // Optimistically update monitored status immediately
        setSearchResults(prev => {
            const updateList = (list: SearchResultItem[]) =>
                list.map(i => i.tidalId === item.tidalId ? { ...i, monitored: true, inLibrary: true } : i);

            return {
                ...prev,
                artists: updateList(prev.artists),
                albums: updateList(prev.albums),
                tracks: updateList(prev.tracks),
                videos: updateList(prev.videos),
                topResult: prev.topResult?.tidalId === item.tidalId
                    ? { ...prev.topResult, monitored: true, inLibrary: true }
                    : prev.topResult
            };
        });

        syncOptimisticMonitorState(item, true);

        try {
            // Use the monitor endpoints for explicit "Monitor" action
            // These handle fetching data + setting monitor flags in one call
            switch (item.type) {
                case 'artist':
                    await api.monitorArtist(item.tidalId);
                    toastRef.current({
                        title: "Artist monitored",
                        description: `${item.name} is now being monitored`,
                    });
                    break;
                case 'album':
                    await api.monitorAlbum(item.tidalId);
                    toastRef.current({
                        title: "Album monitored",
                        description: `${item.name} is now being monitored`,
                    });
                    break;
                case 'track':
                    if (item.inLibrary) {
                        await api.updateTrack(item.tidalId, { monitored: true });
                    } else {
                        await api.addTrack(item.tidalId);
                    }
                    toastRef.current({
                        title: "Track monitored",
                        description: `${item.name} is now being monitored`,
                    });
                    break;
                case 'video':
                    if (item.inLibrary) {
                        await api.updateVideo(item.tidalId, { monitored: true });
                    } else {
                        await api.addVideo(item.tidalId);
                    }
                    toastRef.current({
                        title: "Video monitored",
                        description: `${item.name} is now being monitored`,
                    });
                    break;
            }

            reconcileMonitorQueries(item);
            dispatchLibraryUpdated();
            dispatchActivityRefresh();

        } catch (error: any) {
            console.error('Add item error:', error);
            toastRef.current({
                title: "Failed to add item",
                description: error.message,
                variant: "destructive",
            });

            // Revert optimistic update on error
            setSearchResults(prev => {
                const updateList = (list: SearchResultItem[]) =>
                    list.map(i => i.tidalId === item.tidalId ? { ...i, monitored: previousMonitored, inLibrary: previousInLibrary } : i);

                return {
                    ...prev,
                    artists: updateList(prev.artists),
                    albums: updateList(prev.albums),
                    tracks: updateList(prev.tracks),
                    videos: updateList(prev.videos),
                    topResult: prev.topResult?.tidalId === item.tidalId
                        ? { ...prev.topResult, monitored: previousMonitored, inLibrary: previousInLibrary }
                        : prev.topResult
                };
            });

            if (previousMonitored) {
                syncOptimisticMonitorState(item, true);
            } else {
                clearOptimisticMonitorState(item.type, item.tidalId);
                dispatchMonitorStateChanged({
                    type: item.type,
                    tidalId: item.tidalId,
                    monitored: false,
                });
            }
        }
    }, [reconcileMonitorQueries, syncOptimisticMonitorState]);

    const removeItem = useCallback(async (item: SearchResultItem) => {
        const previousMonitored = Boolean(item.monitored);

        // Optimistically update monitored status immediately
        // Note: We only toggle monitored=false, NOT delete. Item stays in library but unmonitored.
        setSearchResults(prev => {
            const updateList = (list: SearchResultItem[]) =>
                list.map(i => i.tidalId === item.tidalId ? { ...i, monitored: false } : i);

            return {
                ...prev,
                artists: updateList(prev.artists),
                albums: updateList(prev.albums),
                tracks: updateList(prev.tracks),
                videos: updateList(prev.videos),
                topResult: prev.topResult?.tidalId === item.tidalId
                    ? { ...prev.topResult, monitored: false }
                    : prev.topResult
            };
        });

        syncOptimisticMonitorState(item, false);

        try {
            // Toggle monitored to false instead of deleting
            switch (item.type) {
                case 'artist':
                    await api.updateArtist(item.tidalId, { monitored: false });
                    break;
                case 'album':
                    await api.updateAlbum(item.tidalId, { monitored: false });
                    break;
                case 'track':
                    await api.updateTrack(item.tidalId, { monitored: false });
                    break;
                case 'video':
                    await api.updateVideo(item.tidalId, { monitored: false });
                    break;
            }

            toastRef.current({
                title: "Item unmonitored",
                description: `${item.name} is no longer being monitored`,
            });

            reconcileMonitorQueries(item);
            dispatchLibraryUpdated();
            dispatchActivityRefresh();

        } catch (error: any) {
            console.error('Unmonitor item error:', error);
            toastRef.current({
                title: "Failed to unmonitor item",
                description: error.message,
                variant: "destructive",
            });

            // Revert optimistic update on error
            setSearchResults(prev => {
                const updateList = (list: SearchResultItem[]) =>
                    list.map(i => i.tidalId === item.tidalId ? { ...i, monitored: true } : i);

                return {
                    ...prev,
                    artists: updateList(prev.artists),
                    albums: updateList(prev.albums),
                    tracks: updateList(prev.tracks),
                    videos: updateList(prev.videos),
                    topResult: prev.topResult?.tidalId === item.tidalId
                        ? { ...prev.topResult, monitored: true }
                        : prev.topResult
                };
            });

            if (previousMonitored) {
                syncOptimisticMonitorState(item, true);
            } else {
                clearOptimisticMonitorState(item.type, item.tidalId);
            }
        }
    }, [reconcileMonitorQueries, syncOptimisticMonitorState]);

    return {
        searchResults,
        isSearching,
        search,
        addItem,
        removeItem,
    };
};
