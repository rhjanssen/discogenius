import { getVideoPath } from "@/utils/videoNavigation";

function getOptionalIdentifier(value: unknown): string | null {
    if (typeof value === "number" && Number.isFinite(value)) {
        return String(value);
    }

    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function queueAlbumNavPath(albumId: unknown): string | null {
    const resolvedAlbumId = getOptionalIdentifier(albumId);
    return resolvedAlbumId ? `/album/${resolvedAlbumId}` : null;
}

/** Canonical video page only — never a provider resource id. */
export function queueVideoNavPath(videoId: unknown): string | null {
    const resolvedVideoId = getOptionalIdentifier(videoId);
    return resolvedVideoId ? getVideoPath(resolvedVideoId) : null;
}

export function getQueueItemNavPath(item: {
    type?: string | null;
    media_id?: string | number | null;
    album_id?: string | number | null;
}): string | null {
    if (item.type === "video") {
        return queueVideoNavPath(item.media_id);
    }

    if (item.type === "album" || item.type === "track") {
        return queueAlbumNavPath(item.album_id);
    }

    return null;
}
