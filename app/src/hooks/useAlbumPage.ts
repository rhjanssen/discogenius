import { useQuery } from '@tanstack/react-query';
import type { Album } from '@/hooks/useLibrary';
import type { Artist } from '@/hooks/useLibrary';
import { api } from '@/services/api';
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
        refetchInterval: 5_000,
        staleTime: 10_000,
    });
}
