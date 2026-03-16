import { useQuery } from "@tanstack/react-query";
import { api } from "@/services/api";

export function useArtistPage(artistId: string | undefined) {
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
        refetchInterval: 5_000,
        staleTime: 10_000,
    });
}
