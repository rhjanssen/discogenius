import path from "path";
import { Config } from "../config/config.js";
import { streamingProviderManager } from "../providers/index.js";
import { assertPathInsideRoot, assertSafeDownloadResourceId } from "./download-path-safety.js";

export type StreamingSourceId = string;
export type DownloadMediaType = "album" | "track" | "video";

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

export function getDownloadWorkspacePath(
    type: DownloadMediaType,
    sourceId: string,
    streamingSource?: StreamingSourceId,
): string {
    const safeSourceId = assertSafeDownloadResourceId(sourceId);
    const downloadRoot = Config.getDownloadPath();
    // New jobs namespace staging by provider so equal catalog IDs cannot share
    // or delete each other's resumable workspace. Keeping the provider optional
    // preserves the legacy path for persisted jobs created before this change.
    if (streamingSource) {
        streamingProviderManager.getStreamingProvider(streamingSource);
        return assertPathInsideRoot(
            downloadRoot,
            path.join(downloadRoot, DOWNLOAD_FOLDERS[type], streamingSource, safeSourceId),
        );
    }

    return assertPathInsideRoot(
        downloadRoot,
        path.join(downloadRoot, DOWNLOAD_FOLDERS[type], safeSourceId),
    );
}

/** Validate a persisted/import payload path before reading or cleaning it. */
export function validateDownloadWorkspacePath(candidate: string): string {
    return assertPathInsideRoot(Config.getDownloadPath(), candidate);
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

    throw new Error(`Streaming provider ${streamingSource} cannot build media URLs`);
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
