import { useQuery } from "@tanstack/react-query";
import { api } from "@/services/api";
import { useDebouncedQueryInvalidation } from "@/hooks/useDebouncedQueryInvalidation";
import { LIBRARY_UPDATED_EVENT } from "@/utils/appEvents";

const ARTIST_PAGE_GLOBAL_EVENTS = [
    "artist.scanned",
    "artist.refresh.complete",
    "file.added",
    "file.deleted",
    "file.upgraded",
] as const;

export function useArtistPage(artistId: string | undefined) {
    useDebouncedQueryInvalidation({
        queryKeys: [["artistPage", artistId]],
        globalEvents: [...ARTIST_PAGE_GLOBAL_EVENTS],
        windowEvents: [LIBRARY_UPDATED_EVENT],
        enabled: Boolean(artistId),
        debounceMs: 400,
    });

    const summaryQuery = useQuery<any>({
        queryKey: ["artistPage", artistId, "identity"],
        queryFn: async ({ signal }) => {
            if (!artistId) throw new Error("Artist ID is required");
            return api.getArtistPage(artistId, {
                section: "identity",
                signal,
                timeoutMs: 15_000,
            });
        },
        enabled: Boolean(artistId),
        refetchOnWindowFocus: false,
        staleTime: 30_000,
        retry: 1,
    });

    const albumsQuery = useQuery<any>({
        queryKey: ["artistPage", artistId, "albums"],
        queryFn: async ({ signal }) => api.getArtistPage(artistId!, {
            section: "albums",
            signal,
            timeoutMs: 60_000,
        }),
        enabled: Boolean(artistId) && summaryQuery.isSuccess,
        refetchOnWindowFocus: false,
        staleTime: 30_000,
        retry: 1,
    });

    // Tracks and videos wait for the albums section: the page reads top-down
    // (header → albums → tracks → videos), so later sections must not flash in
    // above a still-loading library, and the freed connections let the header
    // artwork + ultrablur colors resolve first.
    const tracksQuery = useQuery<any>({
        queryKey: ["artistPage", artistId, "tracks"],
        queryFn: async ({ signal }) => api.getArtistPage(artistId!, {
            section: "tracks",
            signal,
            timeoutMs: 60_000,
        }),
        enabled: Boolean(artistId) && albumsQuery.isSuccess,
        refetchOnWindowFocus: false,
        staleTime: 30_000,
        retry: 1,
    });

    const videosQuery = useQuery<any>({
        queryKey: ["artistPage", artistId, "videos"],
        queryFn: async ({ signal }) => api.getArtistPage(artistId!, {
            section: "videos",
            signal,
            timeoutMs: 60_000,
        }),
        enabled: Boolean(artistId) && albumsQuery.isSuccess,
        refetchOnWindowFocus: false,
        staleTime: 30_000,
        retry: 1,
    });

    const data = summaryQuery.data
        ? {
            ...summaryQuery.data,
            ...albumsQuery.data,
            artist: {
                ...summaryQuery.data.artist,
                ...(albumsQuery.data?.artist || {}),
            },
            rows: [
                ...(tracksQuery.data?.rows || []),
                ...(albumsQuery.data?.rows || []),
                ...(videosQuery.data?.rows || []),
            ],
        }
        : undefined;

    return {
        ...summaryQuery,
        data,
        // The identity response is intentionally fast. Render the artist
        // header as soon as it arrives while the larger catalog sections load
        // below it; callers use isContentLoading to suppress the empty state.
        isLoading: summaryQuery.isLoading,
        isContentLoading: (
            summaryQuery.isSuccess
            && (albumsQuery.isLoading || tracksQuery.isLoading || videosQuery.isLoading)
        ),
        isFetching: summaryQuery.isFetching || albumsQuery.isFetching || tracksQuery.isFetching || videosQuery.isFetching,
        refetch: async () => {
            const [summary] = await Promise.all([
                summaryQuery.refetch(),
                albumsQuery.refetch(),
                tracksQuery.refetch(),
                videosQuery.refetch(),
            ]);
            return summary;
        },
    };
}
