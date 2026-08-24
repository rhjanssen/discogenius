import { useState, useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, type ArtistLibraryScope } from "@/services/api";
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
    id: string;
    providerId: string;
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
            providerId: item.providerId,
            monitored,
        } as const;

        setOptimisticMonitorState(detail);
        dispatchMonitorStateChanged(detail);
    }, []);

    const reconcileMonitorQueries = useCallback((item: SearchResultItem) => {
        queryClient.invalidateQueries({ queryKey: [item.type, item.providerId] });

        if (item.type === 'artist') {
            queryClient.invalidateQueries({ queryKey: ["artistPage", item.providerId] });
        }

        queryClient.invalidateQueries({ queryKey: ["artists"] });
        queryClient.invalidateQueries({ queryKey: ["albums"] });
        queryClient.invalidateQueries({ queryKey: ["tracks"] });
        queryClient.invalidateQueries({ queryKey: ["videos"] });
        queryClient.invalidateQueries({ queryKey: ["libraryStats"] });
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
        let paintedLocal = false;
        try {
            // Lidarr-style: paint local FTS hits first, then merge remote catalog
            // discovery without blocking the keystroke on SkyHook/MB latency.
            const formatItem = (item: SearchResultContract, type: 'artist' | 'album' | 'track' | 'video'): SearchResultItem => {
                const getYear = (date?: string | null) => {
                    if (!date) return '';
                    return new Date(date).getFullYear().toString();
                };

                const typeLabel = type.charAt(0).toUpperCase() + type.slice(1);
                const artistPart = item.subtitle || undefined;

                let infoPart = undefined;
                if (type === 'track' && item.duration !== undefined) infoPart = formatDurationSeconds(item.duration);
                if (type === 'video' && item.duration !== undefined) infoPart = formatDurationSeconds(item.duration);
                if (type === 'album') infoPart = getYear(item.release_date);

                const parts = [typeLabel];
                if (artistPart) parts.push(artistPart);
                if (infoPart) parts.push(infoPart);

                return {
                    id: String(item.id),
                    providerId: item.id?.toString(),
                    name: item.name,
                    imageUrl: null,
                    type,
                    subtitle: parts.join(' · '),
                    monitored: !!item.monitored,
                    inLibrary: !!item.in_library,
                    imageId: item.imageId || undefined,
                };
            };

            const pickTopResult = (
                artists: SearchResultItem[],
                albums: SearchResultItem[],
                tracks: SearchResultItem[],
                lowerQuery: string,
            ): SearchResultItem | undefined =>
                tracks.find((a) => a.name.toLowerCase() === lowerQuery)
                || artists.find((a) => a.name.toLowerCase() === lowerQuery)
                || albums.find((a) => a.name.toLowerCase() === lowerQuery)
                || artists[0]
                || tracks[0]
                || albums[0];

            const localData: SearchResponseContract = await api.search(
                query,
                ['artists', 'albums', 'tracks', 'videos'],
                10,
                controller.signal,
                { remote: false },
            );

            if (searchId !== latestSearchIdRef.current) return;

            const lowerQuery = query.toLowerCase();
            let artists = (localData.results.artists || []).map((i) => formatItem(i, 'artist'));
            let albums = (localData.results.albums || []).map((i) => formatItem(i, 'album'));
            const tracks = (localData.results.tracks || []).map((i) => formatItem(i, 'track'));
            const videos = (localData.results.videos || []).map((i) => formatItem(i, 'video'));

            setSearchResults({
                artists,
                albums,
                tracks,
                videos,
                topResult: pickTopResult(artists, albums, tracks, lowerQuery),
            });
            paintedLocal = true;
            setIsSearching(false);

            // Remote discovery for Add New (artists/albums not already in library).
            const remoteData: SearchResponseContract = await api.search(
                query,
                ['artists', 'albums'],
                10,
                controller.signal,
                { remote: true, local: false },
            );

            if (searchId !== latestSearchIdRef.current) return;

            const seenArtistIds = new Set(artists.map((item) => item.id));
            const seenAlbumIds = new Set(albums.map((item) => item.id));
            for (const item of (remoteData.results.artists || []).map((i) => formatItem(i, 'artist'))) {
                if (!seenArtistIds.has(item.id)) {
                    artists = [...artists, item];
                    seenArtistIds.add(item.id);
                }
            }
            for (const item of (remoteData.results.albums || []).map((i) => formatItem(i, 'album'))) {
                if (!seenAlbumIds.has(item.id)) {
                    albums = [...albums, item];
                    seenAlbumIds.add(item.id);
                }
            }

            setSearchResults({
                artists,
                albums,
                tracks,
                videos,
                topResult: pickTopResult(artists, albums, tracks, lowerQuery),
            });
        } catch (error: any) {
            const isHidden = typeof document !== 'undefined' && document.visibilityState !== 'visible';
            const isFailedFetch = String(error?.message || '').includes('Failed to fetch');

            // Ignore intentional aborts (new query typed, component unmount, navigation/tab close).
            if (error?.name === 'AbortError' || (isFailedFetch && isHidden)) {
                return;
            }

            if (searchId !== latestSearchIdRef.current) return;

            // Keep already-painted local hits if only the remote discovery leg failed.
            if (paintedLocal) {
                console.warn('Remote catalog search failed; keeping local results:', error);
                return;
            }

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

    const addItem = useCallback(async (
        item: SearchResultItem,
        artistScope?: ArtistLibraryScope,
        artistPolicy: "all" | "new" | "none" = "all",
    ) => {
        const previousMonitored = Boolean(item.monitored);
        const previousInLibrary = Boolean(item.inLibrary);

        // Optimistically update monitored status immediately
        setSearchResults(prev => {
            const updateList = (list: SearchResultItem[]) =>
                list.map(i => i.providerId === item.providerId ? { ...i, monitored: true, inLibrary: true } : i);

            return {
                ...prev,
                artists: updateList(prev.artists),
                albums: updateList(prev.albums),
                tracks: updateList(prev.tracks),
                videos: updateList(prev.videos),
                topResult: prev.topResult?.providerId === item.providerId
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
                    if (!artistScope) throw new Error("Choose at least one library for this artist.");
                    await api.monitorArtist(item.providerId, artistScope, item.name);
                    if (artistPolicy !== "all") {
                        await api.setArtistPolicy(item.providerId, artistPolicy, artistScope);
                    }
                    toastRef.current({
                        title: "Artist monitored",
                        description: `${item.name} is now being monitored`,
                    });
                    break;
                case 'album':
                    await api.monitorAlbum(item.providerId, { allLibraries: true });
                    toastRef.current({
                        title: "Album monitored",
                        description: `${item.name} is now being monitored`,
                    });
                    break;
                case 'video':
                    if (item.inLibrary) {
                        await api.updateVideo(item.providerId, { monitored: true });
                    } else {
                        await api.addVideo(item.providerId);
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
                    list.map(i => i.providerId === item.providerId ? { ...i, monitored: previousMonitored, inLibrary: previousInLibrary } : i);

                return {
                    ...prev,
                    artists: updateList(prev.artists),
                    albums: updateList(prev.albums),
                    tracks: updateList(prev.tracks),
                    videos: updateList(prev.videos),
                    topResult: prev.topResult?.providerId === item.providerId
                        ? { ...prev.topResult, monitored: previousMonitored, inLibrary: previousInLibrary }
                        : prev.topResult
                };
            });

            if (previousMonitored) {
                syncOptimisticMonitorState(item, true);
            } else {
                clearOptimisticMonitorState(item.type, item.providerId);
                dispatchMonitorStateChanged({
                    type: item.type,
                    providerId: item.providerId,
                    monitored: false,
                });
            }
        }
    }, [reconcileMonitorQueries, syncOptimisticMonitorState]);

    const removeItem = useCallback(async (item: SearchResultItem, artistScope?: ArtistLibraryScope) => {
        const previousMonitored = Boolean(item.monitored);

        // Optimistically update monitoring while the explicit library mutation runs.
        setSearchResults(prev => {
            const updateList = (list: SearchResultItem[]) =>
                list.map(i => i.providerId === item.providerId ? { ...i, monitored: false } : i);

            return {
                ...prev,
                artists: updateList(prev.artists),
                albums: updateList(prev.albums),
                tracks: updateList(prev.tracks),
                videos: updateList(prev.videos),
                topResult: prev.topResult?.providerId === item.providerId
                    ? { ...prev.topResult, monitored: false }
                    : prev.topResult
            };
        });

        syncOptimisticMonitorState(item, false);

        try {
            let resultingMonitored = false;
            switch (item.type) {
                case 'artist':
                    if (!artistScope) throw new Error("Choose at least one library for this artist.");
                    resultingMonitored = Boolean((await api.updateArtist(item.providerId, {
                        monitored: false,
                        ...artistScope,
                    }) as { monitored?: boolean })?.monitored);
                    break;
                case 'album':
                    await api.updateAlbum(item.providerId, { monitored: false }, { allLibraries: true });
                    break;
                case 'video':
                    await api.updateVideo(item.providerId, { monitored: false });
                    break;
            }

            if (item.type === "artist" && resultingMonitored) {
                setSearchResults(prev => {
                    const updateList = (list: SearchResultItem[]) => list.map(i => (
                        i.providerId === item.providerId ? { ...i, monitored: true, inLibrary: true } : i
                    ));
                    return {
                        ...prev,
                        artists: updateList(prev.artists),
                        albums: updateList(prev.albums),
                        tracks: updateList(prev.tracks),
                        videos: updateList(prev.videos),
                        topResult: prev.topResult?.providerId === item.providerId
                            ? { ...prev.topResult, monitored: true, inLibrary: true }
                            : prev.topResult,
                    };
                });
                syncOptimisticMonitorState(item, true);
            }

            toastRef.current({
                title: item.type === "artist" ? "Artist libraries updated" : "Item unmonitored",
                description: resultingMonitored
                    ? `${item.name} remains monitored in another library.`
                    : `${item.name} is no longer being monitored.`,
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
                    list.map(i => i.providerId === item.providerId ? { ...i, monitored: true } : i);

                return {
                    ...prev,
                    artists: updateList(prev.artists),
                    albums: updateList(prev.albums),
                    tracks: updateList(prev.tracks),
                    videos: updateList(prev.videos),
                    topResult: prev.topResult?.providerId === item.providerId
                        ? { ...prev.topResult, monitored: true }
                        : prev.topResult
                };
            });

            if (previousMonitored) {
                syncOptimisticMonitorState(item, true);
            } else {
                clearOptimisticMonitorState(item.type, item.providerId);
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
