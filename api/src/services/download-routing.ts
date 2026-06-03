import path from "path";
import { Config } from "./config.js";
import { streamingProviderManager } from "./providers/index.js";

export type StreamingSourceId = string;
export type DownloadMediaType = "album" | "track" | "video";
export type DownloadBackendId = "orpheus" | "tidal-dl-ng";

const DOWNLOAD_FOLDERS: Record<DownloadMediaType, string> = {
    album: "albums",
    track: "tracks",
    video: "videos",
};

export function getDefaultStreamingSource(): StreamingSourceId {
    try {
        return streamingProviderManager.getDefaultStreamingProvider().id;
    } catch {
        return "tidal";
    }
}

export function getDownloadBackendForMediaType(type: DownloadMediaType): DownloadBackendId {
    return type === "video" ? "tidal-dl-ng" : "orpheus";
}

export function getDownloadWorkspacePath(
    type: DownloadMediaType,
    sourceId: string,
    streamingSource: StreamingSourceId = getDefaultStreamingSource(),
): string {
    const provider = streamingProviderManager.getStreamingProvider(streamingSource);
    if (!provider) {
        throw new Error(`Unsupported streaming source: ${streamingSource}`);
    }

    return path.join(Config.getDownloadPath(), DOWNLOAD_FOLDERS[type], sourceId);
}

export function buildStreamingMediaUrl(
    type: DownloadMediaType,
    sourceId: string,
    streamingSource: StreamingSourceId = getDefaultStreamingSource(),
): string {
    const provider = streamingProviderManager.getStreamingProvider(streamingSource);
    if (provider.getMediaUrl) {
        return provider.getMediaUrl(type, sourceId);
    }

    return `https://tidal.com/browse/${type}/${sourceId}`;
}

export function parseStreamingUrl(url: string): {
    streamingSource: StreamingSourceId;
    type: DownloadMediaType;
    sourceId: string;
} | null {
    const providers = streamingProviderManager.getAllStreamingProviders();
    for (const provider of providers) {
        if (provider.parseMediaUrl) {
            const parsed = provider.parseMediaUrl(url);
            if (parsed) {
                return {
                    streamingSource: provider.id,
                    type: parsed.type as DownloadMediaType,
                    sourceId: parsed.providerId,
                };
            }
        }
    }

    return null;
}
