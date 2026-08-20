import { useQuery } from '@tanstack/react-query';
import type { Album } from '@/hooks/useLibrary';
import { api } from '@/services/api';
import { useDebouncedQueryInvalidation } from '@/hooks/useDebouncedQueryInvalidation';
import {
    LIBRARY_UPDATED_EVENT,
    MONITOR_STATE_CHANGED_EVENT,
} from '@/utils/appEvents';
import type {
    AlbumAssociatedVideoContract as AlbumAssociatedVideo,
    AlbumTrackContract as AlbumTrack,
    AlbumVersionContract as AlbumVersion,
    LibraryReleaseGroupAvailabilityContract as ReleaseGroupAvailability,
} from '@contracts/media';
import type { TrackListTabContract } from '@contracts/pages';

export type {
    AlbumAssociatedVideoContract as AlbumAssociatedVideo,
    AlbumTrackContract as AlbumTrack,
    AlbumVersionContract as AlbumVersion,
    LibraryReleaseGroupAvailabilityContract as ReleaseGroupAvailability,
} from '@contracts/media';

export interface AlbumPageData {
    album: Album;
    tracks: AlbumTrack[];
    otherVersions: AlbumVersion[];
    associatedVideos: AlbumAssociatedVideo[];
    releaseAvailability: ReleaseGroupAvailability | null;
    artistImage: string | null;
    trackListTabs?: TrackListTabContract[];
    initialTrackListEditionId?: number;
}

export const albumPageQueryKey = (albumId: string | undefined) => ['albumPage', albumId] as const;
export const albumReleaseAvailabilityQueryKey = (albumId: string | undefined) =>
    ['albumPage', albumId, 'releaseAvailability'] as const;

export function useAlbumPage(albumId: string | undefined) {
    useDebouncedQueryInvalidation({
        queryKeys: [albumPageQueryKey(albumId), albumReleaseAvailabilityQueryKey(albumId)],
        globalEvents: [
            "file.added",
            "file.deleted",
            "file.upgraded",
        ],
        windowEvents: [LIBRARY_UPDATED_EVENT, MONITOR_STATE_CHANGED_EVENT],
        enabled: Boolean(albumId),
        debounceMs: 400,
    });

    const pageQuery = useQuery({
        queryKey: albumPageQueryKey(albumId),
        queryFn: async ({ signal }): Promise<Omit<AlbumPageData, 'releaseAvailability'>> => {
            if (!albumId) {
                throw new Error('Album ID is required');
            }

            const response = await api.getAlbumPage(albumId, {
                signal,
                timeoutMs: 15_000,
            });

            const artistImage = response.artistPicture ?? response.artistCoverImageUrl ?? null;

            return {
                album: response.album as Album,
                tracks: response.tracks,
                otherVersions: response.otherVersions,
                associatedVideos: response.associatedVideos ?? [],
                artistImage,
                trackListTabs: response.trackListTabs,
                initialTrackListEditionId: response.initialTrackListEditionId,
            };
        },
        enabled: !!albumId,
        refetchOnWindowFocus: false,
        staleTime: 30_000,
        retry: 1,
    });

    const availabilityQuery = useQuery({
        queryKey: albumReleaseAvailabilityQueryKey(albumId),
        queryFn: async ({ signal }): Promise<ReleaseGroupAvailability> => {
            if (!albumId) {
                throw new Error('Album ID is required');
            }
            return api.getAlbumLibraryAvailability(albumId, {
                signal,
                timeoutMs: 15_000,
            });
        },
        enabled: !!albumId,
        refetchOnWindowFocus: false,
        staleTime: 30_000,
        retry: 1,
    });

    const data: AlbumPageData | undefined = pageQuery.data
        ? {
            ...pageQuery.data,
            releaseAvailability: availabilityQuery.data ?? null,
        }
        : undefined;

    return {
        ...pageQuery,
        data,
        isPageLoading: pageQuery.isLoading,
        isAvailabilityLoading: availabilityQuery.isLoading,
        isFetching: pageQuery.isFetching || availabilityQuery.isFetching,
        refetch: async () => {
            const [page] = await Promise.all([
                pageQuery.refetch(),
                availabilityQuery.refetch(),
            ]);
            return page;
        },
    };
}
