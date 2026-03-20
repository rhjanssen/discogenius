import { useQuery } from '@tanstack/react-query';
import type { Album } from '@/hooks/useLibrary';
import type { Artist } from '@/hooks/useLibrary';
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
        queryFn: async (): Promise<AlbumPageData> => {
            if (!albumId) {
                throw new Error('Album ID is required');
            }

            const album = await api.getAlbum<Album>(albumId);
            const [tracks, artistData, otherVersionsResult, similarAlbumsResult] = await Promise.all([
                api.getAlbumTracks(albumId),
                album.artist_id ? api.getArtist<Artist>(album.artist_id).catch(() => null) : Promise.resolve(null),
                api.getAlbumVersions(albumId).catch(() => []),
                api.getAlbumSimilar(albumId).catch(() => []),
            ]);

            const artistImage = artistData?.picture
                ? getArtistPicture(artistData.picture, 'tiny')
                : artistData?.cover_image_url ?? null;

            return {
                album,
                tracks,
                otherVersions: otherVersionsResult,
                similarAlbums: similarAlbumsResult,
                artistImage,
            };
        },
        enabled: !!albumId,
        refetchOnMount: 'always',
        refetchOnWindowFocus: true,
        staleTime: 10_000,
    });
}
