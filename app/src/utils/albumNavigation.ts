import type { NavigateFunction, NavigateOptions } from "react-router-dom";

export interface AlbumRouteState {
    focusTrackId?: string;
}

function normalizeRouteId(value: string | number | null | undefined): string | null {
    if (value === null || value === undefined) {
        return null;
    }

    const normalized = String(value).trim();
    return normalized.length > 0 ? normalized : null;
}

export function getAlbumPath(albumId: string | number): string {
    return `/album/${albumId}`;
}

export function createAlbumRouteState(options?: {
    focusTrackId?: string | number | null;
}): AlbumRouteState | undefined {
    const focusTrackId = normalizeRouteId(options?.focusTrackId);
    return focusTrackId ? { focusTrackId } : undefined;
}

export function getAlbumRouteTrackTarget(state: unknown): string | null {
    if (!state || typeof state !== "object") {
        return null;
    }

    const focusTrackId = (state as AlbumRouteState).focusTrackId;
    return normalizeRouteId(focusTrackId);
}

export function navigateToAlbum(
    navigate: NavigateFunction,
    albumId: string | number,
    options?: NavigateOptions,
) {
    return navigate(getAlbumPath(albumId), options);
}

export function navigateToAlbumTrack(
    navigate: NavigateFunction,
    albumId: string | number,
    trackId: string | number,
    options?: Omit<NavigateOptions, "state">,
) {
    const state = createAlbumRouteState({ focusTrackId: trackId });
    return navigate(getAlbumPath(albumId), {
        ...options,
        state,
    });
}