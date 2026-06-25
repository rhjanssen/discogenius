import {
    albumProviderArtworkCandidatesFromRow,
    chooseCachedAlbumArtwork,
    imageContainerFromImagesColumn,
} from "./media-cover-service.js";

export async function resolveHydratedReleaseGroupArtwork(
    releaseGroup: Record<string, any>,
    logPrefix?: string,
): Promise<string | null> {
    void logPrefix;
    return chooseCachedAlbumArtwork({
        albumMbid: releaseGroup.mbid,
        servarrMetadataData: imageContainerFromImagesColumn(releaseGroup.images),
        providerCandidates: albumProviderArtworkCandidatesFromRow(releaseGroup),
    });
}
