import { useQuery } from "@tanstack/react-query";
import { api } from "@/services/api";
import { useDebouncedQueryInvalidation } from "@/hooks/useDebouncedQueryInvalidation";
import { LIBRARY_UPDATED_EVENT } from "@/utils/appEvents";

export function useArtistPage(artistId: string | undefined) {
    useDebouncedQueryInvalidation({
        queryKeys: [["artistPage", artistId]],
        windowEvents: [LIBRARY_UPDATED_EVENT],
        enabled: Boolean(artistId),
        debounceMs: 400,
    });

    return useQuery({
        queryKey: ["artistPage", artistId],
        queryFn: async () => {
            if (!artistId) throw new Error("Artist ID is required");

            // Database-backed endpoint stays DB-first and only seeds core artist metadata when needed.
            // Full enrichment remains an explicit scan/refresh action so page navigation stays responsive.
            return api.getArtistPageDB(artistId);
        },
        enabled: !!artistId,
        // Important UX: when you toggle monitoring from Search and then open the artist page,
        // we must not show a cached stale view.
        refetchOnMount: 'always',
        refetchOnWindowFocus: true,
        staleTime: 10_000,
    });
}
