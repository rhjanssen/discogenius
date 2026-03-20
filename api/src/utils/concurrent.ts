import pLimit from 'p-limit';

/**
 * Concurrency configuration for scanning
 * Based on tidal-dl-ng (8 workers default)
 */
export interface ConcurrencyConfig {
    albumWorkers: number;
    trackWorkers: number;
}

/**
 * Default conservative configuration
 * - albumWorkers: 4 (conservative)
 * - trackWorkers: 6 (between 4 and tidal-dl-ng's 8 default)
 */
export const DEFAULT_CONFIG: ConcurrencyConfig = {
    albumWorkers: 4,
    trackWorkers: 6,
};

export async function yieldToEventLoop(): Promise<void> {
    await new Promise<void>((resolve) => {
        setImmediate(resolve);
    });
}

export function createCooperativeBatcher(batchSize: number): () => Promise<void> {
    let processed = 0;
    const normalizedBatchSize = Math.max(1, Math.floor(batchSize));

    return async () => {
        processed += 1;
        if (processed < normalizedBatchSize) {
            return;
        }

        processed = 0;
        await yieldToEventLoop();
    };
}

/**
 * Concurrent fetcher utility using p-limit
 * Provides controlled concurrency for album and track fetching
 */
export class ConcurrentFetcher {
    private albumLimit: ReturnType<typeof pLimit>;
    private trackLimit: ReturnType<typeof pLimit>;

    constructor(config: ConcurrencyConfig = DEFAULT_CONFIG) {
        this.albumLimit = pLimit(config.albumWorkers);
        this.trackLimit = pLimit(config.trackWorkers);
    }

    /**
     * Fetch albums concurrently with controlled worker limit
     */
    async fetchAlbums<T, R>(
        items: T[],
        fn: (item: T, index: number) => Promise<R>
    ): Promise<R[]> {
        const promises = items.map((item, index) =>
            this.albumLimit(() => fn(item, index))
        );
        return await Promise.all(promises);
    }

    /**
     * Fetch tracks concurrently with controlled worker limit
     */
    async fetchTracks<T, R>(
        items: T[],
        fn: (item: T, index: number) => Promise<R>
    ): Promise<R[]> {
        const promises = items.map((item, index) =>
            this.trackLimit(() => fn(item, index))
        );
        return await Promise.all(promises);
    }
}
