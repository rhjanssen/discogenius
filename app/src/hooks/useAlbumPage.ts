import { useQuery } from '@tanstack/react-query';
import type { Album } from '@/hooks/useLibrary';
import { api } from '@/services/api';
import { useDebouncedQueryInvalidation } from '@/hooks/useDebouncedQueryInvalidation';
import {
    LIBRARY_UPDATED_EVENT,
    MONITOR_STATE_CHANGED_EVENT,
} from '@/utils/appEvents';
import type {
    AlbumTrackContract as AlbumTrack,
    AlbumVersionContract as AlbumVersion,
    ReleaseGroupAvailabilityContract as ReleaseGroupAvailability,
} from '@contracts/media';

export type {
    AlbumTrackContract as AlbumTrack,
    AlbumVersionContract as AlbumVersion,
    ReleaseGroupAvailabilityContract as ReleaseGroupAvailability,
} from '@contracts/media';

export interface AlbumPageData {
    album: Album;
    tracks: AlbumTrack[];
    otherVersions: AlbumVersion[];
    releaseAvailability: ReleaseGroupAvailability | null;
    artistImage: string | null;
}

export const albumPageQueryKey = (albumId: string | undefined) => ['albumPage', albumId] as const;

export function useAlbumPage(albumId: string | undefined) {
    useDebouncedQueryInvalidation({
        queryKeys: [albumPageQueryKey(albumId)],
        // Queue/activity changes are owned by the queue cache and its live SSE
        // projection. Refetching the complete album page for every unrelated
        // queued/started/completed job caused a request storm during initial
        // library establishment. The page only needs durable library or
        // monitor-state changes; local queue controls already update their own
        // state optimistically.
        windowEvents: [LIBRARY_UPDATED_EVENT, MONITOR_STATE_CHANGED_EVENT],
        enabled: Boolean(albumId),
        debounceMs: 400,
    });

    return useQuery({
        queryKey: albumPageQueryKey(albumId),
        queryFn: async ({ signal }): Promise<AlbumPageData> => {
            if (!albumId) {
                throw new Error('Album ID is required');
            }

            const [response, releaseAvailability] = await Promise.all([
                api.getAlbumPage(albumId, {
                    signal,
                    timeoutMs: 15_000,
                }),
                api.getAlbumReleaseAvailability(albumId, {
                    signal,
                    timeoutMs: 15_000,
                }),
            ]);

            const artistImage = response.artistPicture ?? response.artistCoverImageUrl ?? null;

            return {
                album: response.album as Album,
                tracks: response.tracks,
                otherVersions: response.otherVersions,
                releaseAvailability,
                artistImage,
            };
        },
        enabled: !!albumId,
        refetchOnWindowFocus: false,
        staleTime: 30_000,
        retry: 1,
    });
}
