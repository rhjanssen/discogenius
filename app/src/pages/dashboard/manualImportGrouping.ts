export type GroupableUnmappedFile = {
    id: number;
    file_path: string;
    relative_path: string;
    library_root: string;
    filename: string;
    detected_artist?: string | null;
    detected_album?: string | null;
    ignored: boolean;
};

const GROUP_MIN_FILES = 2;
const GROUP_MIN_RATIO = 0.6;

export function normalizeComparableText(value?: string | null): string {
    return (value || "")
        .toLowerCase()
        .replace(/&/g, " and ")
        .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
        .replace(/[_./\\-]+/g, " ")
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function getRelativeDirectory(input: string) {
    const normalized = input.replace(/\\/g, "/");
    const lastSlash = normalized.lastIndexOf("/");
    return lastSlash >= 0 ? normalized.slice(0, lastSlash) : "";
}

/**
 * Group files only when a common artist/album tag accounts for most of one
 * physical folder. Ambiguous or sparse metadata remains one row per file.
 */
export function groupUnmappedFilesForReview<T extends GroupableUnmappedFile>(files: T[]): T[][] {
    const directoryBuckets = new Map<string, T[]>();

    for (const file of files) {
        const key = [file.library_root, getRelativeDirectory(file.relative_path || file.file_path), file.ignored ? "ignored" : "active"].join("::");
        const current = directoryBuckets.get(key) || [];
        current.push(file);
        directoryBuckets.set(key, current);
    }

    const groups: T[][] = [];
    for (const bucketFiles of directoryBuckets.values()) {
        const orderedBucket = [...bucketFiles].sort((left, right) => left.filename.localeCompare(right.filename));
        const albumBuckets = new Map<string, T[]>();

        for (const file of orderedBucket) {
            const albumKey = normalizeComparableText(file.detected_album);
            if (!albumKey) continue;

            const artistKey = normalizeComparableText(file.detected_artist);
            const key = `${albumKey}::${artistKey}`;
            const current = albumBuckets.get(key) || [];
            current.push(file);
            albumBuckets.set(key, current);
        }

        const consumedIds = new Set<number>();
        const groupedCandidates = Array.from(albumBuckets.values())
            .filter((candidateFiles) => candidateFiles.length >= GROUP_MIN_FILES
                && candidateFiles.length / orderedBucket.length >= GROUP_MIN_RATIO)
            .sort((left, right) => right.length - left.length);

        for (const candidateFiles of groupedCandidates) {
            const remainingFiles = candidateFiles.filter((file) => !consumedIds.has(file.id));
            if (remainingFiles.length < GROUP_MIN_FILES) continue;
            remainingFiles.forEach((file) => consumedIds.add(file.id));
            groups.push(remainingFiles);
        }

        for (const file of orderedBucket) {
            if (!consumedIds.has(file.id)) groups.push([file]);
        }
    }

    return groups;
}
