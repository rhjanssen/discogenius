import fs from "fs";
import path from "path";
import * as mm from "music-metadata";
import type { LibraryRoot } from "./naming.js";
import type { AutoImportedGroupSummary, ImportCandidate, LocalFile, LocalGroup } from "./import-types.js";

export const SUPPORTED_IMPORT_EXTENSIONS = new Set([
    ".mp3", ".flac", ".m4a", ".aac", ".wav", ".ogg", ".opus", ".alac", ".aiff",
    ".mkv", ".mp4", ".m4v", ".mov",
]);

const IGNORED_IMPORT_FOLDERS = new Set([
    ".git", ".vs", "$recycle.bin", "system volume information", "@eaDir",
]);

export async function scanImportDirectory(
    scanPath: string,
    rootPath: string,
    libraryRoot: LibraryRoot = "music"
): Promise<LocalGroup[]> {
    const groups: LocalGroup[] = [];

    try {
        await fs.promises.access(scanPath);
    } catch {
        console.warn(`Path does not exist: ${scanPath}`);
        return [];
    }

    const walk = async (dir: string) => {
        let entries: fs.Dirent[];
        try {
            entries = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch (error) {
            console.warn(`Failed to read dir ${dir}:`, error);
            return;
        }

        const files: LocalFile[] = [];
        const sidecars: string[] = [];

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);

            if (entry.isDirectory()) {
                if (!IGNORED_IMPORT_FOLDERS.has(entry.name.toLowerCase()) && !entry.name.startsWith(".")) {
                    await walk(fullPath);
                }
                continue;
            }

            if (!entry.isFile()) {
                continue;
            }

            const ext = path.extname(entry.name).toLowerCase();
            if (SUPPORTED_IMPORT_EXTENSIONS.has(ext)) {
                try {
                    const stats = await fs.promises.stat(fullPath);
                    let metadata: mm.IAudioMetadata | undefined;
                    try {
                        metadata = await mm.parseFile(fullPath, { skipCovers: true });
                    } catch {
                        metadata = undefined;
                    }

                    files.push({
                        path: fullPath,
                        name: entry.name,
                        size: stats.size,
                        extension: ext,
                        metadata,
                    });
                } catch {
                    // Ignore file access failures during scan.
                }
            } else {
                sidecars.push(fullPath);
            }
        }

        if (files.length > 0) {
            groups.push({
                id: Buffer.from(dir).toString("base64"),
                path: dir,
                rootPath,
                libraryRoot,
                files,
                sidecars,
                commonTags: deriveCommonTags(files, dir, rootPath),
                status: "pending",
            });
        }
    };

    await walk(scanPath);
    return groups;
}

function deriveCommonTags(files: LocalFile[], groupPath: string, rootPath: string): LocalGroup["commonTags"] {
    const artists = new Map<string, number>();
    const albums = new Map<string, number>();
    const years = new Map<number, number>();
    const splitArtistValues = (value: string): string[] =>
        value
            .split(/\s*(?:,|;| feat\.?| ft\.?| featuring | & | x )\s*/i)
            .map((part) => part.trim())
            .filter(Boolean);

    for (const file of files) {
        if (!file.metadata?.common) {
            continue;
        }

        const preferredArtists = [
            file.metadata.common.albumartist,
            ...(file.metadata.common.albumartists || []),
            file.metadata.common.artist,
            ...(file.metadata.common.artists || []),
        ].filter(Boolean) as string[];

        const albumArtistValues = preferredArtists.slice(0, 1).flatMap(splitArtistValues);
        for (const value of albumArtistValues) {
            artists.set(value, (artists.get(value) || 0) + 2);
        }

        const supportingArtists = preferredArtists.slice(1).flatMap(splitArtistValues);
        for (const value of supportingArtists) {
            artists.set(value, (artists.get(value) || 0) + 1);
        }

        if (file.metadata.common.album) {
            const value = file.metadata.common.album;
            albums.set(value, (albums.get(value) || 0) + 1);
        }
        if (file.metadata.common.year) {
            const value = file.metadata.common.year;
            years.set(value, (years.get(value) || 0) + 1);
        }
    }

    const getTop = <T>(values: Map<T, number>): T | undefined => {
        let topItem: T | undefined;
        let maxCount = 0;
        for (const [item, count] of values.entries()) {
            if (count > maxCount) {
                maxCount = count;
                topItem = item;
            }
        }
        return topItem;
    };

    const relativeSegments = path.relative(rootPath, groupPath).split(path.sep).filter(Boolean);
    const topLevelSegment = relativeSegments[0];
    const groupSegment = relativeSegments[relativeSegments.length - 1];
    const parsedGroupSegment = parseReleaseFolderLabel(groupSegment || "");
    const parsedArtistAlbumLabel = parseArtistAlbumLabel(groupSegment || "");
    const firstTrackStem = files.length > 0 ? extractTrackStem(files[0].name) : "";

    let artistTop = getTop(artists);
    let albumTop = getTop(albums);
    let yearTop = getTop(years);

    if (
        parsedArtistAlbumLabel.artist
        && (!artistTop || (topLevelSegment && cleanPathLabel(artistTop) === cleanPathLabel(topLevelSegment)))
    ) {
        artistTop = parsedArtistAlbumLabel.artist;
    }

    if (!artistTop && topLevelSegment && !isGenericPathSegment(topLevelSegment)) {
        artistTop = cleanPathLabel(topLevelSegment) || undefined;
    }

    if (!albumTop) {
        if (parsedArtistAlbumLabel.album) {
            albumTop = parsedArtistAlbumLabel.album;
        } else if (relativeSegments.length > 1 && parsedGroupSegment.title && !isGenericPathSegment(groupSegment)) {
            albumTop = parsedGroupSegment.title;
        } else if (firstTrackStem) {
            albumTop = firstTrackStem;
        }
    }

    if (!yearTop && parsedGroupSegment.year) {
        yearTop = parsedGroupSegment.year;
    }

    return {
        artist: artistTop,
        album: albumTop,
        year: yearTop,
    };
}

export function getTopLevelImportFolder(group: LocalGroup): string {
    const relativeGroupPath = path.relative(group.rootPath, group.path);
    const segments = relativeGroupPath.split(path.sep).filter(Boolean);
    return segments[0] || path.basename(group.path);
}

export function summarizeAutoImportedCandidate(candidate: ImportCandidate): AutoImportedGroupSummary | null {
    const match = candidate.matches[0];
    if (!match) {
        return null;
    }

    const artistId =
        match.item?.artist_id?.toString?.()
        ?? match.item?.artist?.id?.toString?.()
        ?? match.item?.artists?.[0]?.id?.toString?.()
        ?? null;
    const artistName =
        match.item?.artist_name
        ?? match.item?.artist?.name
        ?? match.item?.artists?.[0]?.name
        ?? null;
    const itemId =
        match.item?.id?.toString?.()
        ?? match.item?.tidal_id?.toString?.()
        ?? null;

    if (!artistId || !artistName || !itemId) {
        return null;
    }

    return {
        folderName: getTopLevelImportFolder(candidate.group),
        groupPath: candidate.group.path,
        artistId,
        artistName,
        albumId: match.itemType === "album"
            ? itemId
            : (match.item?.album_id?.toString?.() ?? null),
        albumTitle: match.item?.title ?? "Unknown",
        itemType: match.itemType,
    };
}

export function cleanPathLabel(input: string): string {
    return (input || "")
        .replace(/\[tidal-\d+\]/gi, " ")
        .replace(/\[(?:\d+\s*-\s*bit[^\]]*|album|single|ep|video|explicit|clean|e|atmos|dolby atmos)\]/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
}

export function parseReleaseFolderLabel(input: string): { title: string; year?: number } {
    const yearMatch = input.match(/\((19|20)\d{2}\)/);
    const year = yearMatch ? Number.parseInt(yearMatch[0].slice(1, 5), 10) : undefined;
    const title = cleanPathLabel(input).replace(/\((19|20)\d{2}\)/g, " ").replace(/\s+/g, " ").trim();

    return {
        title,
        year: Number.isFinite(year) ? year : undefined,
    };
}

export function parseArtistAlbumLabel(input: string): { artist?: string; album?: string } {
    const cleaned = cleanPathLabel(input);
    const match = cleaned.match(/^(.+?)\s+[–—-]\s+(.+)$/);
    if (!match) {
        return {};
    }

    const artist = match[1]?.trim();
    const album = match[2]?.trim();

    return {
        artist: artist || undefined,
        album: album || undefined,
    };
}

export function isGenericPathSegment(input?: string | null): boolean {
    const normalized = String(input || "")
        .toLowerCase()
        .replace(/\[tidal-\d+\]/g, " ")
        .replace(/\[(?:\d+\s*-\s*bit[^\]]*|album|single|ep|video|explicit|clean|e|atmos|dolby atmos)\]/g, " ")
        .replace(/\((?:19|20)\d{2}\)/g, " ")
        .replace(/[_./\\-]+/g, " ")
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    if (!normalized) {
        return true;
    }

    return /^(cd|disc|disk|volume|vol)\s*\d+$/.test(normalized);
}

export function extractTrackStem(filename: string): string {
    return cleanPathLabel(
        path.parse(filename).name
            .replace(/^\d{1,3}(?:[ ._-]+\d{1,3})?[ ._-]*/, "")
            .trim()
    );
}