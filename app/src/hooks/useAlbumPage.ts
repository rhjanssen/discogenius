import { useQuery } from '@tanstack/react-query';
import type { Album } from '@/hooks/useLibrary';
import type { Artist } from '@/hooks/useLibrary';
import { api } from '@/services/api';
import { getArtistPicture } from '@/utils/tidalImages';

export interface AlbumTrack {
    id: string;
    title: string;
    version?: string | null;
    duration: number;
    track_number: number;
    volume_number: number;
    quality: string;
    artist_name?: string;
    album_title?: string;
    downloaded?: boolean;
    is_monitored?: boolean;
    monitor?: boolean;
    monitor_lock?: number | boolean;
    explicit?: boolean;
    files?: Array<{
        id: number;
        file_type: string;
        file_path: string;
        relative_path?: string;
        filename?: string;
        extension?: string;
        quality?: string;
        library_root?: string;
        file_size?: number;
        bitrate?: number;
        sample_rate?: number;
        bit_depth?: number;
        codec?: string;
        duration?: number;
    }>;
}

export interface SimilarAlbum {
    id: string;
    title: string;
    cover_id?: string;
    artist_name?: string;
    release_date?: string;
    popularity?: number;
    quality?: string;
    explicit?: boolean;
}

export interface AlbumVersion {
    id: string;
    title: string;
    cover_id?: string;
    artist_name?: string;
    release_date?: string;
    quality?: string;
    version?: string;
    explicit?: boolean;
}

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
                api.getAlbumTracks<AlbumTrack[]>(albumId),
                album.artist_id ? api.getArtist<Artist>(album.artist_id).catch(() => null) : Promise.resolve(null),
                api.getAlbumVersions<AlbumVersion[]>(albumId).catch(() => []),
                api.getAlbumSimilar<SimilarAlbum[]>(albumId).catch(() => []),
            ]);

            const artistImage = artistData?.picture
                ? getArtistPicture(artistData.picture, 'tiny')
                : artistData?.cover_image_url ?? null;

            return {
                album,
                tracks,
                otherVersions: Array.isArray(otherVersionsResult) ? otherVersionsResult : [],
                similarAlbums: Array.isArray(similarAlbumsResult) ? similarAlbumsResult : [],
                artistImage,
            };
        },
        enabled: !!albumId,
        refetchOnMount: 'always',
        refetchInterval: 5_000,
        staleTime: 10_000,
    });
}
