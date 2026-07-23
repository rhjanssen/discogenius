import {
    albumCoverLocalUrl,
    albumProviderArtworkCandidatesFromRow,
    imageContainerFromImagesColumn,
} from "./media-cover-service.js";

export async function resolveHydratedReleaseGroupArtwork(
    releaseGroup: Record<string, any>,
    logPrefix?: string,
): Promise<string | null> {
    void logPrefix;
    return albumCoverLocalUrl({
        albumMbid: releaseGroup.mbid,
        images: imageContainerFromImagesColumn(releaseGroup.images),
        providerCandidates: albumProviderArtworkCandidatesFromRow(releaseGroup),
    });
}
