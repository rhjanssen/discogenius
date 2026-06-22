import {
    albumProviderArtworkCandidatesFromRow,
    getSkyHookAlbumImageUrl,
    parseJsonObject,
    registerMediaCoverProxyUrl,
    resolveAlbumArtwork,
} from "./media-cover-service.js";
import { skyHookProxy } from "./skyhook-proxy.js";

function rowHasCanonicalArtwork(row: Record<string, any>): boolean {
    const images = parseJsonObject(row.images);
    if (!Array.isArray(images)) return false;
    return images.some((image) => {
        if (!image || typeof image !== "object") return false;
        const source = String((image as any).source || (image as any).Source || "").trim().toLowerCase();
        const url = (image as any).url || (image as any).Url || (image as any).remoteUrl || (image as any).RemoteUrl;
        return Boolean(url) && source !== "provider-fallback";
    });
}

function rowHasAnyCachedArtwork(row: Record<string, any>): boolean {
    const images = parseJsonObject(row.images);
    if (!Array.isArray(images)) return false;
    return images.some((image) => {
        if (!image || typeof image !== "object") return false;
        const url = (image as any).url || (image as any).Url || (image as any).remoteUrl || (image as any).RemoteUrl;
        return Boolean(url);
    });
}

function rowHasProviderFallbackArtwork(row: Record<string, any>): boolean {
    const images = parseJsonObject(row.images);
    if (!Array.isArray(images)) return false;
    return images.some((image) => {
        if (!image || typeof image !== "object") return false;
        const source = String((image as any).source || (image as any).Source || "").trim().toLowerCase();
        const url = (image as any).url || (image as any).Url || (image as any).remoteUrl || (image as any).RemoteUrl;
        return Boolean(url) && source === "provider-fallback";
    });
}

function rowHasSkyHookDataArtwork(row: Record<string, any>): boolean {
    return Boolean(getSkyHookAlbumImageUrl(parseJsonObject(row.data)));
}

export async function ensureReleaseGroupArtworkHydrated(
    releaseGroup: Record<string, any>,
    logPrefix = "ReleaseGroupArtworkService",
): Promise<void> {
    if (rowHasCanonicalArtwork(releaseGroup)) return;
    if (rowHasSkyHookDataArtwork(releaseGroup)) return;
    if (rowHasAnyCachedArtwork(releaseGroup) && !rowHasProviderFallbackArtwork(releaseGroup)) return;

    const releaseGroupMbid = String(releaseGroup.mbid || "").trim();
    const artistMbid = String(releaseGroup.artist_mbid || "").trim();
    if (!releaseGroupMbid || !artistMbid) return;

    try {
        await skyHookProxy.syncReleaseGroup(releaseGroupMbid, artistMbid);
    } catch (error) {
        console.warn(`[${logPrefix}] Failed to hydrate artwork for release group ${releaseGroupMbid}:`, error);
    }
}

export async function resolveHydratedReleaseGroupArtwork(
    releaseGroup: Record<string, any>,
    logPrefix?: string,
): Promise<string | null> {
    await ensureReleaseGroupArtworkHydrated(releaseGroup, logPrefix);
    const resolvedCoverUrl = await resolveAlbumArtwork({
        albumMbid: releaseGroup.mbid,
        skyHookData: parseJsonObject(releaseGroup.data),
        providerCandidates: albumProviderArtworkCandidatesFromRow(releaseGroup),
    });
    return resolvedCoverUrl
        ? registerMediaCoverProxyUrl(resolvedCoverUrl) || resolvedCoverUrl
        : null;
}
