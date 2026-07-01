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

    return useQuery({
        queryKey: ["artistPage", artistId],
        queryFn: async ({ signal }) => {
            if (!artistId) throw new Error("Artist ID is required");

            // Artist page reads stay local-first and only seed core artist metadata when needed.
            // Full enrichment remains an explicit scan/refresh action so navigation stays responsive.
            return api.getArtistPage(artistId, {
                signal,
                timeoutMs: 15_000,
            });
        },
        enabled: !!artistId,
        refetchOnWindowFocus: false,
        staleTime: 30_000,
        retry: 1,
    });
}
