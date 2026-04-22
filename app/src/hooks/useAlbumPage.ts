import { useQuery } from '@tanstack/react-query';
import type { Album } from '@/hooks/useLibrary';
import { api } from '@/services/api';
import { useDebouncedQueryInvalidation } from '@/hooks/useDebouncedQueryInvalidation';
import {
    ACTIVITY_REFRESH_EVENT,
    LIBRARY_UPDATED_EVENT,
    MONITOR_STATE_CHANGED_EVENT,
} from '@/utils/appEvents';
import { getArtistPicture } from '@/utils/tidalImages';
import type {
    AlbumTrackContract as AlbumTrack,
    AlbumVersionContract as AlbumVersion,
    SimilarAlbumContract as SimilarAlbum,
} from '@contracts/media';

export type {
    AlbumTrackContract as AlbumTrack,
    AlbumVersionContract as AlbumVersion,
    SimilarAlbumContract as SimilarAlbum,
} from '@contracts/media';

export interface AlbumPageData {
    album: Album;
    tracks: AlbumTrack[];
    similarAlbums: SimilarAlbum[];
    otherVersions: AlbumVersion[];
    artistImage: string | null;
}

export const albumPageQueryKey = (albumId: string | undefined) => ['albumPage', albumId] as const;

export function useAlbumPage(albumId: string | undefined) {
    useDebouncedQueryInvalidation({
        queryKeys: [albumPageQueryKey(albumId)],
        windowEvents: [ACTIVITY_REFRESH_EVENT, LIBRARY_UPDATED_EVENT, MONITOR_STATE_CHANGED_EVENT],
        enabled: Boolean(albumId),
        debounceMs: 400,
    });

    return useQuery({
        queryKey: albumPageQueryKey(albumId),
        queryFn: async ({ signal }): Promise<AlbumPageData> => {
            if (!albumId) {
                throw new Error('Album ID is required');
            }

            const response = await api.getAlbumPage(albumId, {
                signal,
                timeoutMs: 15_000,
            });

            const artistImage = response.artistPicture
                ? getArtistPicture(response.artistPicture, 'tiny')
                : response.artistCoverImageUrl ?? null;

            return {
                album: response.album as Album,
                tracks: response.tracks,
                otherVersions: response.otherVersions,
                similarAlbums: response.similarAlbums,
                artistImage,
            };
        },
        enabled: !!albumId,
        refetchOnWindowFocus: false,
        staleTime: 30_000,
        retry: 1,
    });
}
