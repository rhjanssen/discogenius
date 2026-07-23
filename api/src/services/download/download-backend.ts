export interface DownloadRequest {
    provider: string;
    entityType: "album" | "track" | "video";
    providerId: string;
    downloadPath: string;
    quality?: string | null;
    /** The library variant selected by curation; one provider offer may serve more than one slot. */
    slot?: "stereo" | "spatial" | "video" | string;
    metadata?: {
        save_lyrics?: boolean;
        artwork_preference?: "canonical" | "provider";
    };
}

export interface DownloadProgress {
    /** 0-100 when known. Omit/null when the tool gives no file-level progress. */
    progress?: number | null;
    currentFileNum?: number;
    totalFiles?: number;
    currentTrack?: string;
    currentProviderTrackId?: string;
    currentTrackNum?: number;
    currentVolumeNum?: number;
    trackProgress?: number;
    trackStatus?: 'queued' | 'downloading' | 'completed' | 'error' | 'skipped';
    statusMessage?: string;
    state?: 'queued' | 'downloading' | 'completed' | 'failed' | 'paused' | 'importPending' | 'importing' | 'importFailed';
    speed?: string;
    eta?: string;
    size?: number;
    sizeleft?: number;
    tracks?: Array<{ title: string; trackNum?: number; status: 'queued' | 'downloading' | 'completed' | 'error' | 'skipped'; providerTrackId?: string }>;
}

export interface DownloadBackend {
    readonly id: string;
    readonly supportedProviders: string[];
    readonly capabilities: Array<"stereo" | "spatial" | "video">;
    download(request: DownloadRequest, options: { signal?: AbortSignal; onProgress: (progress: DownloadProgress) => void }): Promise<void>;
}

export class DownloadBackendRegistryClass {
    private backends = new Map<string, DownloadBackend>();

    register(backend: DownloadBackend): void {
        this.backends.set(backend.id, backend);
    }

    get(id: string): DownloadBackend | undefined {
        return this.backends.get(id);
    }

    resolve(provider: string, capability: "stereo" | "spatial" | "video"): DownloadBackend | undefined {
        for (const backend of this.backends.values()) {
            if (backend.supportedProviders.includes(provider) && backend.capabilities.includes(capability)) {
                return backend;
            }
        }
        return undefined;
    }

    getAll(): DownloadBackend[] {
        return Array.from(this.backends.values());
    }
}

export const downloadBackendRegistry = new DownloadBackendRegistryClass();
