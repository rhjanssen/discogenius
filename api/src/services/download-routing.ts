import path from "path";
import { Config } from "./config.js";

export type StreamingSourceId = "tidal";
export type DownloadMediaType = "album" | "track" | "video" | "playlist";
export type DownloadBackendId = "orpheus" | "tidal-dl-ng";

const DOWNLOAD_FOLDERS: Record<DownloadMediaType, string> = {
    album: "albums",
    track: "tracks",
    video: "videos",
    playlist: "playlists",
};

export function getDefaultStreamingSource(): StreamingSourceId {
    return "tidal";
}

export function getDownloadBackendForMediaType(type: DownloadMediaType): DownloadBackendId {
    return type === "video" ? "tidal-dl-ng" : "orpheus";
}

export function getDownloadWorkspacePath(
    type: DownloadMediaType,
    sourceId: string,
    streamingSource: StreamingSourceId = getDefaultStreamingSource(),
): string {
    if (streamingSource !== "tidal") {
        throw new Error(`Unsupported streaming source: ${streamingSource}`);
    }

    return path.join(Config.getDownloadPath(), DOWNLOAD_FOLDERS[type], sourceId);
}

export function buildStreamingMediaUrl(
    type: DownloadMediaType,
    sourceId: string,
    streamingSource: StreamingSourceId = getDefaultStreamingSource(),
): string {
    if (streamingSource !== "tidal") {
        throw new Error(`Unsupported streaming source: ${streamingSource}`);
    }

    return `https://tidal.com/browse/${type}/${sourceId}`;
}

export function parseStreamingUrl(url: string): {
    streamingSource: StreamingSourceId;
    type: DownloadMediaType;
    sourceId: string;
} | null {
    const match = url.match(
        /^https?:\/\/(?:listen\.)?tidal\.com\/(?:browse\/)?(track|album|video|playlist)\/([A-Za-z0-9-]+)\/?/i,
    );

    if (!match) {
        return null;
    }

    return {
        streamingSource: "tidal",
        type: match[1].toLowerCase() as DownloadMediaType,
        sourceId: match[2],
    };
}