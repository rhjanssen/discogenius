const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_BYTES = 256 * 1024 * 1024;

type CachedPlayback = {
  expiresAt: number;
  promise: Promise<Buffer>;
  size: number;
};

const cache = new Map<string, CachedPlayback>();
let cachedBytes = 0;

function pruneExpired(now = Date.now()) {
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) {
      cache.delete(key);
      cachedBytes -= entry.size;
    }
  }
}

function pruneToFit() {
  for (const [key, entry] of cache) {
    if (cachedBytes <= MAX_CACHE_BYTES) {
      break;
    }
    cache.delete(key);
    cachedBytes -= entry.size;
  }
}

async function fetchSegments(segments: string[]): Promise<Buffer> {
  const buffers: Buffer[] = new Array(segments.length);
  const BATCH_SIZE = 10;
  
  for (let i = 0; i < segments.length; i += BATCH_SIZE) {
    const batch = segments.slice(i, i + BATCH_SIZE);
    const batchPromises = batch.map(async (url, index) => {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Segment ${i + index + 1} of ${segments.length} failed with status ${response.status}`);
      }
      return Buffer.from(await response.arrayBuffer());
    });
    
    const results = await Promise.all(batchPromises);
    for (let j = 0; j < results.length; j++) {
      buffers[i + j] = results[j];
    }
  }
  
  return Buffer.concat(buffers);
}

export async function materializeSegmentedPlayback(cacheKey: string, segments: string[]): Promise<Buffer> {
  pruneExpired();
  const existing = cache.get(cacheKey);
  if (existing) {
    return existing.promise;
  }

  const entry: CachedPlayback = {
    expiresAt: Date.now() + CACHE_TTL_MS,
    promise: Promise.resolve(Buffer.alloc(0)),
    size: 0,
  };
  entry.promise = fetchSegments(segments)
    .then((buffer) => {
      entry.size = buffer.byteLength;
      cachedBytes += entry.size;
      pruneToFit();
      return buffer;
    })
    .catch((error) => {
      cache.delete(cacheKey);
      throw error;
    });
  cache.set(cacheKey, entry);
  return entry.promise;
}

export function parsePlaybackRange(value: string | undefined, size: number): { start: number; end: number } | null {
  if (!value) {
    return null;
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match) {
    throw new Error("Invalid byte range");
  }

  const hasStart = match[1] !== "";
  const hasEnd = match[2] !== "";
  if (!hasStart && !hasEnd) {
    throw new Error("Invalid byte range");
  }

  const requestedStart = hasStart ? Number(match[1]) : null;
  const requestedEnd = hasEnd ? Number(match[2]) : null;
  const start = requestedStart == null ? Math.max(0, size - Number(requestedEnd)) : requestedStart;
  const end = requestedStart == null ? size - 1 : Math.min(requestedEnd ?? size - 1, size - 1);

  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) {
    throw new Error("Invalid byte range");
  }

  return { start, end };
}
