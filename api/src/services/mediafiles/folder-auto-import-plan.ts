/**
 * Decides whether one folder of unmapped files can be imported without a
 * person, and onto which canonical tracks. Pure: callers read tags and the
 * catalog, this function only decides (Lidarr: ImportDecisionMaker with
 * CloseTrackMatch / NoMissingOrUnmatchedTracks; PRODUCT_VISION ADR-2).
 *
 * Authority rules:
 * - One library: the enabled library whose root holds every file.
 * - One release: every file carries the same MusicBrainz release id, and that
 *   release exists in the local catalog.
 * - Every file maps to exactly one distinct track of that release, by track
 *   MBID, then recording MBID (unique in the release), then disc+track number
 *   with a matching title. A known duration must be within 10 s.
 * Anything else is "review" with a reason; nothing is imported partially.
 */

export interface AutoImportFile {
    id: number;
    libraryRoot: string;
    ignored: boolean;
    durationSeconds: number | null;
    tags: Record<string, string>;
}

export interface AutoImportLibrary {
    id: number;
    rootPath: string;
}

export interface AutoImportReleaseTrack {
    id: number;
    mbid: string | null;
    recordingMbid: string | null;
    mediumPosition: number;
    position: number;
    title: string;
    durationMs: number | null;
}

export interface AutoImportRelease {
    id: number;
    mbid: string;
    tracks: AutoImportReleaseTrack[];
}

export type FolderAutoImportPlan =
    | {
        decision: "import";
        libraryId: number;
        editionId: number;
        mappings: Array<{ unmappedFileId: number; trackId: number }>;
    }
    | { decision: "review"; reason: string };

export const DURATION_TOLERANCE_SECONDS = 10;

function normalizeKey(key: string): string {
    return key.toLowerCase().replace(/^(txxx:|----:com\.apple\.itunes:)/, "").replace(/[\s_]/g, "");
}

export function readTag(tags: Record<string, string>, ...names: string[]): string | null {
    const wanted = new Set(names.map(normalizeKey));
    for (const [key, value] of Object.entries(tags)) {
        if (wanted.has(normalizeKey(key))) {
            const trimmed = String(value).split(/[;\0]/)[0]?.trim();
            if (trimmed) return trimmed;
        }
    }
    return null;
}

function leadingInt(value: string | null): number | null {
    if (!value) return null;
    const match = /^\s*(\d+)/.exec(value);
    return match ? Number(match[1]) : null;
}

function normalizeTitle(value: string): string {
    return value
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, "");
}

function normalizePath(value: string): string {
    return value.replace(/\\/g, "/").replace(/\/+$/, "");
}

export function releaseMbidOf(file: AutoImportFile): string | null {
    return readTag(file.tags, "musicbrainz_albumid", "MusicBrainz Album Id")?.toLowerCase() ?? null;
}

export function planFolderAutoImport(input: {
    files: AutoImportFile[];
    libraries: AutoImportLibrary[];
    findRelease: (releaseMbid: string) => AutoImportRelease | null;
}): FolderAutoImportPlan {
    const { files } = input;
    if (files.length === 0) return { decision: "review", reason: "No files in this folder" };
    if (files.some((file) => file.ignored)) {
        return { decision: "review", reason: "A file in this folder is ignored" };
    }

    const roots = new Set(files.map((file) => normalizePath(file.libraryRoot)));
    if (roots.size !== 1) return { decision: "review", reason: "Files are in more than one library root" };
    const [root] = [...roots];
    const library = input.libraries.find((candidate) => normalizePath(candidate.rootPath) === root);
    if (!library) return { decision: "review", reason: `No enabled library uses root ${root}` };

    const releaseMbids = new Set(files.map(releaseMbidOf));
    if (releaseMbids.has(null)) {
        return { decision: "review", reason: "A file has no MusicBrainz release id tag" };
    }
    if (releaseMbids.size !== 1) {
        return { decision: "review", reason: "Files carry different MusicBrainz release ids" };
    }
    const [releaseMbid] = [...releaseMbids] as string[];
    const release = input.findRelease(releaseMbid);
    if (!release) {
        return {
            decision: "review",
            reason: `MusicBrainz release ${releaseMbid} is not in the catalog; add or refresh the artist first`,
        };
    }

    const byTrackMbid = new Map<string, AutoImportReleaseTrack>();
    const byRecording = new Map<string, AutoImportReleaseTrack[]>();
    const byPosition = new Map<string, AutoImportReleaseTrack>();
    for (const track of release.tracks) {
        if (track.mbid) byTrackMbid.set(track.mbid.toLowerCase(), track);
        if (track.recordingMbid) {
            const key = track.recordingMbid.toLowerCase();
            byRecording.set(key, [...(byRecording.get(key) ?? []), track]);
        }
        byPosition.set(`${track.mediumPosition}:${track.position}`, track);
    }

    const mappings: Array<{ unmappedFileId: number; trackId: number }> = [];
    const usedTracks = new Set<number>();
    for (const file of files) {
        let track: AutoImportReleaseTrack | undefined;
        const trackMbid = readTag(file.tags, "musicbrainz_releasetrackid", "MusicBrainz Release Track Id")?.toLowerCase();
        if (trackMbid) track = byTrackMbid.get(trackMbid);
        if (!track) {
            const recordingMbid = readTag(file.tags, "musicbrainz_trackid", "MusicBrainz Track Id")?.toLowerCase();
            const candidates = recordingMbid ? byRecording.get(recordingMbid) ?? [] : [];
            if (candidates.length === 1) track = candidates[0];
        }
        if (!track) {
            const disc = leadingInt(readTag(file.tags, "disc", "discnumber", "disk")) ?? 1;
            const number = leadingInt(readTag(file.tags, "track", "tracknumber"));
            const title = readTag(file.tags, "title");
            const candidate = number !== null ? byPosition.get(`${disc}:${number}`) : undefined;
            if (candidate && title && normalizeTitle(candidate.title) === normalizeTitle(title)) {
                track = candidate;
            }
        }
        if (!track) {
            return { decision: "review", reason: `File ${file.id} matches no track of release ${releaseMbid}` };
        }
        if (
            file.durationSeconds !== null
            && track.durationMs !== null
            && Math.abs(file.durationSeconds - track.durationMs / 1000) > DURATION_TOLERANCE_SECONDS
        ) {
            return {
                decision: "review",
                reason: `File ${file.id} length differs more than ${DURATION_TOLERANCE_SECONDS}s from "${track.title}"`,
            };
        }
        if (usedTracks.has(track.id)) {
            return { decision: "review", reason: `Two files map to "${track.title}"` };
        }
        usedTracks.add(track.id);
        mappings.push({ unmappedFileId: file.id, trackId: track.id });
    }

    return { decision: "import", libraryId: library.id, editionId: release.id, mappings };
}
